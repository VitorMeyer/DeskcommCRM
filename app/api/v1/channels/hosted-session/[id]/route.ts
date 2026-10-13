import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { getAdapter } from "@/lib/channels";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { sincronizarEstadoDaSessaoPareada } from "@/lib/channels/estado-da-sessao-pareada";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const actionSchema = z.object({
  action: z.enum(["connect", "pairing_code", "disconnect", "delete"]),
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
    const state = await adapter.sessao.getStatus({ organizationId: authz.org.orgId, sessionRef });
    const { phoneConflict } = await atualizarEstado(session, state);
    return ok({ ...state, phone_number_conflict: phoneConflict }, { requestId });
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

    if (action === "pairing_code") {
      const digits = parsed.data.phone_number?.replace(/\D/g, "") ?? "";
      if (digits.length < 8 || digits.length > 15) {
        return fail("invalid_request", t("Informe um telefone internacional válido."), 422, {
          requestId,
        });
      }
      const state = await adapter.sessao.connect({ ...scope, phoneNumber: digits });
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
      await adapter.sessao.connect(scope);
      const state = await adapter.sessao.getStatus(scope);
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

    if (action === "disconnect") {
      await adapter.sessao.disconnect(scope);
      await atualizarEstado(session, { status: "STOPPED" });
      void audit({
        action: "channel.disconnected",
        actorUserId: authz.user.id,
        organizationId: authz.org.orgId,
        resourceType: "channel_session",
        resourceId: id,
        requestId,
      });
      return ok({ status: "STOPPED" }, { requestId });
    }

    await adapter.sessao.delete(scope);
    const admin = createAdminClient();
    const { error } = await admin
      .from("channel_sessions")
      .update({ archived_at: new Date().toISOString(), status: "STOPPED" })
      .eq("organization_id", authz.org.orgId)
      .eq("id", id);
    if (error) throw new Error("channel_session_archive_failed");
    void audit({
      action: "channel.archived",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "channel_session",
      resourceId: id,
      requestId,
    });
    return ok({ archived: true }, { requestId });
  } catch {
    return fail(
      "channel_operation_failed",
      t("Não foi possível concluir a operação. Verifique a conexão e tente de novo."),
      502,
      { requestId },
    );
  }
}
