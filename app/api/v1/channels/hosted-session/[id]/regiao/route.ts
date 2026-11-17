import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { CredencialRecusadaError, getAdapter, type ChannelRegiaoOps } from "@/lib/channels";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A REGIÃO DE SAÍDA da conexão hospedada — o proxy regional do transporte.
 *
 * O número "aparece" para o WhatsApp a partir da cidade escolhida. Perto de onde
 * o negócio atende é o que se quer: um número de Belo Horizonte saindo de um IP
 * qualquer do país é o tipo de sinal que o WhatsApp lê como estranho.
 *
 *   GET            → região atual + estados do catálogo
 *   GET ?estado=mg → as cidades daquele estado
 *   PUT {estado, cidade} → grava; a cidade é conferida no catálogo antes
 *
 * País fixo no Brasil por ora: o catálogo do transporte cobre 179 países, mas a
 * tela pergunta estado e cidade, e "estado" é a subdivisão que o catálogo
 * brasileiro traz. Outro país é extensão desta rota, não troca.
 */
const PAIS = "br";
const SIGLA = /^[a-z]{2}$/;

const definirSchema = z.object({
  estado: z.string().trim().toLowerCase().regex(SIGLA),
  cidade: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{1,80}$/),
});

async function regiaoDaSessao(id: string, organizationId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("channel_sessions")
    .select(`${CHANNEL_SESSION_REF_COLUMNS}, id, archived_at`)
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`channel_session_lookup_failed: ${error.message}`);
  const sessao = data as (Record<string, unknown> & { provider: string; archived_at: string | null }) | null;
  if (!sessao || sessao.archived_at) return null;
  const ops: ChannelRegiaoOps | undefined = getAdapter(sessao.provider as never).sessao?.regiao;
  if (!ops) return { sessao, ops: null, sessionRef: "" };
  return { sessao, ops, sessionRef: resolveSessionRef(sessao as never) };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channel_session" });
  if (!authz.ok) return authz.response;
  const { id } = await params;
  const estado = req.nextUrl.searchParams.get("estado")?.trim().toLowerCase() || null;
  if (estado && !SIGLA.test(estado)) return fail("invalid_request", "Estado inválido.", 422, { requestId });

  try {
    const achada = await regiaoDaSessao(id, authz.org.orgId);
    if (!achada) return fail("not_found", "Canal não encontrado.", 404, { requestId });
    if (!achada.ops)
      return fail("region_unavailable", "Este canal não escolhe região.", 422, { requestId });
    const escopo = { organizationId: authz.org.orgId, sessionRef: achada.sessionRef };

    if (estado) {
      const cidades = await achada.ops.cidades({ ...escopo, pais: PAIS, estado });
      return ok({ cidades: cidades.filter((c) => c.estado === estado) }, { requestId });
    }
    const [atual, todas] = await Promise.all([
      achada.ops.atual(escopo),
      achada.ops.cidades({ ...escopo, pais: PAIS }),
    ]);
    const estados = [...new Map(todas.map((c) => [c.estado, c.estadoNome])).entries()]
      .map(([sigla, nome]) => ({ sigla, nome }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    return ok({ atual, estados }, { requestId });
  } catch (err) {
    if (err instanceof CredencialRecusadaError)
      return fail("credential_rejected", "O servidor recusou o token salvo.", 409, { requestId });
    return fail("upstream_unavailable", "Não foi possível consultar a região da conexão.", 502, { requestId });
  }
}

export async function PUT(
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

  const parsed = definirSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("invalid_request", t("Escolha o estado e a cidade."), 422, { requestId });
  const { id } = await params;

  try {
    const achada = await regiaoDaSessao(id, authz.org.orgId);
    if (!achada) return fail("not_found", t("Canal não encontrado."), 404, { requestId });
    if (!achada.ops)
      return fail("region_unavailable", t("Este canal não escolhe região."), 422, { requestId });
    const escopo = { organizationId: authz.org.orgId, sessionRef: achada.sessionRef };

    // A cidade vem do catálogo do transporte, não de um texto livre: um valor
    // que ele não conhece seria salvo e só falharia no próximo ciclo da conexão.
    const doEstado = await achada.ops.cidades({ ...escopo, pais: PAIS, estado: parsed.data.estado });
    const cidade = doEstado.find((c) => c.valor === parsed.data.cidade && c.estado === parsed.data.estado);
    if (!cidade)
      return fail("invalid_request", t("Cidade fora do catálogo deste estado."), 422, { requestId });

    const atual = await achada.ops.definir({
      ...escopo,
      pais: PAIS,
      estado: cidade.estado,
      cidade: cidade.valor,
    });
    void audit({
      action: "channel.region_updated",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "channel_session",
      resourceId: id,
      requestId,
      metadata: { pais: PAIS, estado: cidade.estado, cidade: cidade.valor, em_uso: atual.emUso },
    });
    return ok({ atual, cidade: { valor: cidade.valor, nome: cidade.nome, estado: cidade.estado } }, { requestId });
  } catch (err) {
    if (err instanceof CredencialRecusadaError)
      return fail("credential_rejected", t("O servidor recusou o token salvo."), 409, { requestId });
    return fail("upstream_unavailable", t("Não foi possível salvar a região da conexão."), 502, { requestId });
  }
}
