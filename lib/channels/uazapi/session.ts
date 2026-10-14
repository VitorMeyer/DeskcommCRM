import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { CHANNEL_PROVIDER_UAZAPI } from "../capabilities";
import { queryTolerantToMissingArchived, ARCHIVED_AT } from "../archived";
import { validarCredenciaisUazapi } from "./validate-credentials";

export interface UazapiSessionSummary {
  id: string;
  instanceId: string;
  serverUrl: string;
  phoneNumber: string | null;
  displayName: string | null;
  status: string;
  hasToken: boolean;
  webhookUrl: string | null;
  archivedAt: string | null;
}

const COLUNAS =
  "id, uazapi_instance_id, uazapi_server_url, uazapi_instance_token_encrypted, phone_number, display_name, status, webhook_path_token";

function resumo(
  row: Record<string, unknown> | null,
  basePublicUrl: string,
): UazapiSessionSummary | null {
  if (!row) return null;
  const webhookPathToken =
    typeof row.webhook_path_token === "string" ? row.webhook_path_token : null;
  return {
    id: String(row.id),
    instanceId: String(row.uazapi_instance_id ?? ""),
    serverUrl: String(row.uazapi_server_url ?? ""),
    phoneNumber: typeof row.phone_number === "string" ? row.phone_number : null,
    displayName: typeof row.display_name === "string" ? row.display_name : null,
    status: String(row.status ?? "STOPPED"),
    hasToken: Boolean(row.uazapi_instance_token_encrypted),
    webhookUrl: webhookPathToken
      ? `${basePublicUrl}/api/v1/webhooks/channel/${webhookPathToken}`
      : null,
    archivedAt: typeof row.archived_at === "string" ? row.archived_at : null,
  };
}

/**
 * A conexão ATIVA da organização — a que a tela mostra e opera.
 *
 * Só a ativa: a linha excluída fica arquivada (para o histórico de conversas não
 * perder o canal), e devolvê-la aqui fazia a conexão removida continuar na tela,
 * com botões que respondem "Este canal foi excluído".
 */
export async function findUazapiSession(
  admin: SupabaseClient,
  organizationId: string,
  basePublicUrl: string,
): Promise<UazapiSessionSummary | null> {
  const base = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_UAZAPI);
  const { data, error } = await queryTolerantToMissingArchived(
    () =>
      base(`${COLUNAS}, ${ARCHIVED_AT}`)
        .is("archived_at", null)
        .order("created_at", { ascending: false })
        .limit(1),
    () => base(COLUNAS).order("created_at", { ascending: false }).limit(1),
  );
  if (error) throw new Error(`uazapi_session_lookup_failed: ${error.message}`);
  return resumo((data as unknown as Record<string, unknown>[] | null)?.[0] ?? null, basePublicUrl);
}

/**
 * Valida, cifra e persiste uma sessão. A organização vem sempre do guard.
 *
 * Qual linha recebe a credencial:
 *  - há conexão ativa: ELA, sempre — mesma instância (token trocado no painel) ou
 *    outra (a instância anterior expirou ou foi trocada). A linha é o canal da
 *    organização, com o acesso da IA e o histórico ligados a ela; a instância é
 *    o que está por trás, como a sessão que se re-pareia no canal por QR;
 *  - não há ativa: linha nova, também quando a instância é uma que a organização
 *    já usou e removeu. A linha removida fica arquivada com o histórico dela,
 *    como no canal por QR — desarquivá-la exigiria procurar a instância entre as
 *    INATIVAS, onde o índice único não garante uma linha só.
 *
 * Trocar de instância com o número conectado é recusado: a troca derrubaria o
 * atendimento em silêncio. Quem opera desconecta primeiro — e desconectar não
 * depende do token antigo estar vivo.
 */
export async function salvarUazapiSession(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    serverUrl: string;
    token: string;
    webhookPathToken: string;
    webhookUrl: string;
    basePublicUrl: string;
  },
): Promise<{ ok: true; session: UazapiSessionSummary } | { ok: false; motivo: string }> {
  const validacao = await validarCredenciaisUazapi({
    serverUrl: input.serverUrl,
    token: input.token,
  });
  if (!validacao.ok) return validacao;

  const ativa = await findUazapiSession(admin, input.organizationId, input.basePublicUrl);
  const outraInstancia =
    ativa !== null &&
    (ativa.instanceId !== validacao.instanceId || ativa.serverUrl !== validacao.serverUrl);
  if (ativa && outraInstancia && ativa.status === "WORKING") {
    return {
      ok: false,
      motivo: "O número atual está conectado. Desconecte-o antes de trocar de instância.",
    };
  }
  const existente = ativa;

  const tokenEncrypted = await encryptWebhookSecret(admin, input.token.trim());
  // O endpoint de entrada usa o token de caminho opaco como autenticação. A
  // coluna legacy é NOT NULL e recebe um segredo aleatório, nunca o token remoto.
  const webhookSecretEncrypted = existente
    ? null
    : await encryptWebhookSecret(admin, randomBytes(32).toString("hex"));
  if (!tokenEncrypted || (!existente && !webhookSecretEncrypted)) {
    return { ok: false, motivo: "A cifra de credenciais não está disponível nesta instalação." };
  }

  const webhookPathToken = input.webhookPathToken;

  // A configuração remota do webhook ocorre antes da gravação. Assim o estado
  // `connected` nunca promete entrada quando o registro no servidor falhou.
  const webhook = await fetch(`${validacao.serverUrl}/webhook`, {
    method: "POST",
    redirect: "error",
    headers: { token: input.token.trim(), "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      url: input.webhookUrl,
      // Sem `presence`: cada "digitando…" chegaria ao webhook e viraria uma linha
      // no arquivo de webhooks, para um evento que o CRM ignora.
      events: ["messages", "messages_update", "connection"],
      excludeMessages: ["wasSentByApi"],
      addUrlEvents: false,
      addUrlTypesMessages: false,
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!webhook?.ok) {
    return {
      ok: false,
      motivo: "Não foi possível registrar o webhook no servidor. A conexão não foi salva.",
    };
  }

  const row = {
    organization_id: input.organizationId,
    provider: CHANNEL_PROVIDER_UAZAPI,
    uazapi_instance_id: validacao.instanceId,
    uazapi_server_url: validacao.serverUrl,
    uazapi_instance_token_encrypted: tokenEncrypted,
    webhook_path_token: webhookPathToken,
    // Só dígitos, como o canal por QR grava: a trava "um número vive em UM canal
    // ativo" compara texto, e `+55…` não colidiria com `55…` — o mesmo número
    // ficaria ligado nos dois transportes ao mesmo tempo.
    phone_number: validacao.phoneNumber,
    display_name: validacao.displayName,
    status: validacao.status,
  };

  const saved = existente
    ? await admin
        .from("channel_sessions")
        .update(row as never)
        .eq("organization_id", input.organizationId)
        .eq("id", existente.id)
        .select(`${COLUNAS}, ${ARCHIVED_AT}`)
        .single()
    : await admin
        .from("channel_sessions")
        .insert({
          ...row,
          webhook_secret_encrypted: webhookSecretEncrypted,
          metadata: metadataInicialDoCanal(),
        } as never)
        .select(`${COLUNAS}, ${ARCHIVED_AT}`)
        .single();
  if (saved.error || !saved.data) {
    // Duas travas dão 23505 aqui, e a mensagem do Postgres nomeia o índice: a
    // instância ativa em outra organização, ou o número já ligado a outro canal
    // ativo DESTA organização (o mesmo aparelho pareado por QR, por exemplo).
    const travaDoNumero =
      saved.error?.code === "23505" && /phone/i.test(saved.error.message ?? "");
    return {
      ok: false,
      motivo: travaDoNumero
        ? "Este número já está conectado em outro canal ativo desta organização. Remova o outro canal para usá-lo aqui."
        : saved.error?.code === "23505"
          ? "Esta instância já está conectada a outra organização."
          : "Não foi possível salvar a conexão.",
    };
  }

  const session = resumo(saved.data as unknown as Record<string, unknown>, input.basePublicUrl);
  return session
    ? { ok: true, session }
    : { ok: false, motivo: "Não foi possível ler a conexão salva." };
}
