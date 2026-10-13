/**
 * Credenciais por sessão do canal hospedado por instância.
 *
 * A URL e o token pertencem à conexão da organização, nunca ao ambiente da
 * instalação. Assim uma instância de um tenant não pode, por acidente, enviar
 * pela credencial de outro. O token é cifrado pelos mesmos RPCs usados pelos
 * demais segredos de integração.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";

/** Só o literal `true` liga esta integração opcional na instalação. */
export function canalUazapiLigado(valor: string | undefined = process.env.UAZAPI_ENABLED): boolean {
  return (valor ?? "").trim().toLowerCase() === "true";
}

/** Nome de apresentação: componentes e rotas pedem esta constante, não a marca. */
export const UAZAPI_LABEL = "Uazapi";

export interface UazapiCredentials {
  channelSessionId: string;
  instanceId: string;
  serverUrl: string;
  token: string;
}

/**
 * Normaliza a raiz da API e recusa formas que poderiam esconder outra origem.
 * A resolução DNS fica separada para a rota de conexão poder falhar fechada
 * antes de persistir uma URL apontando para a rede privada da VPS.
 */
export function normalizarUazapiServerUrl(valor: string): string {
  const bruto = valor.trim();
  assertSafeOutboundUrl(bruto);

  let url: URL;
  try {
    url = new URL(bruto);
  } catch {
    throw new Error("unsafe_url:invalid");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("unsafe_url:credentials_or_fragment");
  }

  // A API pode estar atrás de um prefixo de proxy; preservamo-lo, mas nunca
  // aceitamos uma barra final duplicada ao montar endpoints.
  return url.toString().replace(/\/+$/, "");
}

/** Validação completa para toda URL nova antes de gravar no banco. */
export async function validarUazapiServerUrl(valor: string): Promise<string> {
  const normalizada = normalizarUazapiServerUrl(valor);
  await assertDestinoResolvidoSeguro(new URL(normalizada).hostname);
  return normalizada;
}

/**
 * Busca a credencial da sessão escopada pela organização confiável.
 *
 * `channel_sessions` é lida pelo service role, então os dois filtros são
 * obrigatórios: o identificador remoto nunca basta para atravessar tenants.
 */
export async function resolveUazapiCreds(
  admin: SupabaseClient,
  lookup: { organizationId: string; instanceId: string },
): Promise<UazapiCredentials | null> {
  const { organizationId, instanceId } = lookup;
  if (!organizationId || !instanceId) return null;

  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, uazapi_instance_id, uazapi_server_url, uazapi_instance_token_encrypted")
      .eq("organization_id", organizationId)
      .eq("uazapi_instance_id", instanceId);
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) {
    throw new Error(
      `uazapi_creds_lookup_failed: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim(),
    );
  }

  const linha = data as {
    id: string;
    uazapi_instance_id?: string | null;
    uazapi_server_url?: string | null;
    uazapi_instance_token_encrypted?: unknown;
  } | null;
  if (
    !linha?.uazapi_instance_id ||
    !linha.uazapi_server_url ||
    !linha.uazapi_instance_token_encrypted
  ) {
    return null;
  }

  const token = await decryptWebhookSecret(admin, linha.uazapi_instance_token_encrypted as string);
  if (!token) return null;

  return {
    channelSessionId: linha.id,
    instanceId: linha.uazapi_instance_id,
    serverUrl: linha.uazapi_server_url,
    token,
  };
}
