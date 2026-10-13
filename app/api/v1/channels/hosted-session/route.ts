import { randomBytes, randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { canalUazapiLigado, UAZAPI_LABEL } from "@/lib/channels/uazapi/credentials";
import { findUazapiSession, salvarUazapiSession } from "@/lib/channels/uazapi/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  server_url: z.string().trim().min(1).max(2000),
  token: z.string().trim().min(1).max(2000),
});

function naoExiste(requestId: string): NextResponse {
  return fail("not_found", "not found", 404, { requestId });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  if (!canalUazapiLigado()) return naoExiste(requestId);
  const authz = await requireRole("admin", { requestId, resource: "channel_session" });
  if (!authz.ok) return authz.response;

  try {
    const base = basePublicaDaInstalacao(req);
    const session = await findUazapiSession(createAdminClient(), authz.org.orgId, base);
    return ok({ label: UAZAPI_LABEL, session }, { requestId });
  } catch {
    return fail("internal_error", "Não foi possível carregar a conexão.", 500, { requestId });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  if (!canalUazapiLigado()) return naoExiste(requestId);
  const authz = await requireRole("admin", { requestId, resource: "channel_session" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  if (await mfaEmDivida())
    return fail("mfa_required", t("Confirme a verificação em duas etapas."), 403, { requestId });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", t("Informe a URL e o token da instância."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  let result: Awaited<ReturnType<typeof salvarUazapiSession>>;
  try {
    const basePublicUrl = basePublicaDaInstalacao(req);
    const tokenPath = randomBytes(32).toString("base64url");
    result = await salvarUazapiSession(createAdminClient(), {
      organizationId: authz.org.orgId,
      serverUrl: parsed.data.server_url,
      token: parsed.data.token,
      webhookPathToken: tokenPath,
      webhookUrl: `${basePublicUrl}/api/v1/webhooks/channel/${tokenPath}`,
      basePublicUrl,
    });
  } catch {
    return fail("internal_error", "Não foi possível salvar a conexão.", 502, { requestId });
  }
  if (!result.ok) return fail("invalid_request", t(result.motivo), 422, { requestId });

  void audit({
    action: "channel.connected",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "channel_session",
    resourceId: result.session.id,
    requestId,
    metadata: { etapa: "credencial", phone_number: result.session.phoneNumber },
  });
  return ok({ connected: true, session: result.session }, { requestId, status: 201 });
}
