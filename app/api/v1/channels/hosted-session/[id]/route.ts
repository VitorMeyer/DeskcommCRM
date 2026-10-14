import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { CredencialRecusadaError, getAdapter } from "@/lib/channels";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { sincronizarEstadoDaSessaoPareada } from "@/lib/channels/estado-da-sessao-pareada";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Excluir NÃO é ação daqui: é a rota comum `DELETE /api/v1/channel-sessions/[id]`,
 * que decide entre arquivar e apagar, fecha os avisos da Central e não depende da
 * credencial estar viva. Esta rota apagava a instância remota com o token
 * gravado — e, com o token morto, a conexão não saía nunca mais da tela.
 */
const actionSchema = z.object({
  action: z.enum(["connect", "pairing_code", "disconnect"]),
  phone_number: z.string().trim().max(32).optional(),
});

async function buscarSessao(id: string, organizationId: string) {
  const admin = createAdminClient();
  const query = (columns: string) =>
    admin
      .from("channel_sessions")
      .select(columns)
      .eq("organization_id", organizationId)
      .eq("id", id)
      .maybeSingle();
  const { data, error } = await queryTolerantToMissingArchived(
    () =>
      query(
        `${CHANNEL_SESSION_REF_COLUMNS}, id, organization_id, status, display_name, phone_number, ${ARCHIVED_AT}`,
      ),
    () =>
      query(
        `${CHANNEL_SESSION_REF_COLUMNS}, id, organization_id, status, display_name, phone_number`,
      ),
  );
  if (error) throw new Error(`channel_session_lookup_failed: ${error.message}`);
  return data as
    | (Record<string, unknown> & {
        id: string;
        organization_id: string;
        provider: string;
        archived_at?: string | null;
      })
    | null;
}

const atualizarEstado = (
  session: Record<string, unknown> & { id: string; organization_id: string },
  state: { status: string; phoneNumber?: string | null; displayName?: string | null },
) => sincronizarEstadoDaSessaoPareada(createAdminClient(), session, state);

/**
 * Estado devolvido quando o servidor recusa o token gravado. É 200 e não 502:
 * a consulta funcionou, e o que ela descobriu é que a credencial morreu — a tela
 * para de consultar e diz o que fazer, em vez de acumular erros a cada 5 s.
 */
const CREDENCIAL_RECUSADA = {
  status: "FAILED",
  qrCode: null,
  pairingCode: null,
  phoneNumber: null,
  displayName: null,
  phone_number_conflict: false,
  credential_rejected: true,
} as const;

const MSG_CREDENCIAL_RECUSADA =
  "O servidor recusou o token salvo. Cole o token de uma instância válida para trocar, ou remova a conexão.";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channel_session" });
  if (!authz.ok) return authz.response;
  const { id } = await params;
  try {
    const session = await buscarSessao(id, authz.org.orgId);
    if (!session) return fail("not_found", "Canal não encontrado.", 404, { requestId });
    if (session.archived_at)
      return fail("channel_archived", "Este canal foi excluído.", 409, { requestId });
    const adapter = getAdapter(session.provider as never);
    if (!adapter.sessao)
      return fail(
        "session_operations_unavailable",
        "Este canal não oferece pareamento por QR.",
        422,
        { requestId },
      );
    const sessionRef = resolveSessionRef(session as never);
    try {
      const state = await adapter.sessao.getStatus({ organizationId: authz.org.orgId, sessionRef });
      const { phoneConflict } = await atualizarEstado(session, state);
      return ok({ ...state, phone_number_conflict: phoneConflict }, { requestId });
    } catch (err) {
      if (!(err instanceof CredencialRecusadaError)) throw err;
      await atualizarEstado(session, { status: "FAILED" });
      return ok(CREDENCIAL_RECUSADA, { requestId });
    }
  } catch {
    return fail("internal_error", "Não foi possível consultar o estado da conexão.", 502, {
      requestId,
    });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channel_session" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  if (await mfaEmDivida())
    return fail("mfa_required", t("Confirme a verificação em duas etapas."), 403, { requestId });

  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("invalid_request", t("Ação de conexão inválida."), 422, { requestId });
  const { id } = await params;

  try {
    const session = await buscarSessao(id, authz.org.orgId);
    if (!session) return fail("not_found", t("Canal não encontrado."), 404, { requestId });
    if (session.archived_at)
      return fail("channel_archived", t("Este canal foi excluído."), 409, { requestId });
    const adapter = getAdapter(session.provider as never);
    if (!adapter.sessao)
      return fail(
        "session_operations_unavailable",
        t("Este canal não oferece essa operação."),
        422,
        { requestId },
      );
    const sessionRef = resolveSessionRef(session as never);
    const scope = { organizationId: authz.org.orgId, sessionRef };
    const action = parsed.data.action;

    // Credencial morta em QR/código: grava o estado e diz o que fazer. Não há
    // pareamento possível com um token que o servidor recusa.
    const recusou = async (err: unknown): Promise<Response> => {
      if (!(err instanceof CredencialRecusadaError)) throw err;
      await atualizarEstado(session, { status: "FAILED" });
      return fail("credential_rejected", t(MSG_CREDENCIAL_RECUSADA), 422, { requestId });
    };

    if (action === "pairing_code") {
      const digits = parsed.data.phone_number?.replace(/\D/g, "") ?? "";
      if (digits.length < 8 || digits.length > 15) {
        return fail("invalid_request", t("Informe um telefone internacional válido."), 422, {
          requestId,
        });
      }
      let state;
      try {
        state = await adapter.sessao.connect({ ...scope, phoneNumber: digits });
      } catch (err) {
        return await recusou(err);
      }
      await atualizarEstado(session, state);
      return state.pairingCode
        ? ok({ code: state.pairingCode, status: state.status }, { requestId })
        : fail(
            "pairing_code_unavailable",
            t("O servidor não devolveu o código. Tente novamente ou use o QR Code."),
            502,
            { requestId },
          );
    }

    if (action === "connect") {
      let state;
      try {
        await adapter.sessao.connect(scope);
        state = await adapter.sessao.getStatus(scope);
      } catch (err) {
        return await recusou(err);
      }
      await atualizarEstado(session, state);
      void audit({
        action: "channel.reconnected",
        actorUserId: authz.user.id,
        organizationId: authz.org.orgId,
        resourceType: "channel_session",
        resourceId: id,
        requestId,
        metadata: { etapa: "pareamento", status: state.status },
      });
      return ok(state, { requestId });
    }

    // Desconectar não depende do token antigo estar vivo: se o servidor o recusa,
    // não há sessão dele ligada a este CRM, e o estado local diz isso. Prender o
    // operador aqui era prender também a troca de instância, que exige o número
    // desconectado.
    let remoto: "desconectado" | "credencial_recusada" = "desconectado";
    try {
      await adapter.sessao.disconnect(scope);
    } catch (err) {
      if (!(err instanceof CredencialRecusadaError)) throw err;
      remoto = "credencial_recusada";
    }
    await atualizarEstado(session, { status: "STOPPED" });
    void audit({
      action: "channel.disconnected",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "channel_session",
      resourceId: id,
      requestId,
      metadata: { remoto },
    });
    return ok(
      { status: "STOPPED", credential_rejected: remoto === "credencial_recusada" },
      { requestId },
    );
  } catch {
    return fail(
      "channel_operation_failed",
      t("Não foi possível concluir a operação. Verifique a conexão e tente de novo."),
      502,
      { requestId },
    );
  }
}
