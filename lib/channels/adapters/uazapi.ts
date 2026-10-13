/**
 * Adapter do canal WhatsApp hospedado por instância.
 *
 * O adapter traduz os nossos envelopes para a API remota; não decide janela,
 * warm-up, retry ou horário de envio. Essas regras vivem antes dele e valem
 * para todos os canais.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import {
  MAX_MEDIA_BYTES,
  MediaTooLargeError,
  type FetchedMedia,
} from "@/lib/messaging/media/types";

import { CHANNEL_PROVIDER_UAZAPI } from "../capabilities";
import {
  canalUazapiLigado,
  resolveUazapiCreds,
  validarUazapiServerUrl,
  type UazapiCredentials,
} from "../uazapi/credentials";
import { estadoDoCanalUazapi } from "../uazapi/estado";
import { parseRetryAfterMs } from "../uazapi/retry-after";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelSessionStatus,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";

const NAO_CONFIGURADO = "uazapi_not_configured";

/**
 * Quanto tempo o "digitando…" pode ficar aceso se ninguém o cancelar.
 *
 * Sem `delay` a API mantém a presença por até 5 MINUTOS, reenviando-a a cada 10 s,
 * e só a cancela sozinha quando uma mensagem sai para o mesmo chat. Se o turno do
 * agente terminar sem enviar (veto, erro), o cliente ficaria vendo "digitando…" por
 * minutos. O atraso humano do agente tem teto de 7,5 s; o dobro cobre a espera
 * normal, e o envio cancela antes.
 */
const PRESENCA_MAXIMA_MS = 15_000;

type UazapiBody = {
  error?: string;
  message?: string;
  provider_code?: number;
  messageid?: string;
  id?: string;
  instance?: {
    status?: string;
    profileName?: string;
    qrcode?: string | null;
    paircode?: string | null;
  };
  status?: {
    connected?: boolean;
    loggedIn?: boolean;
    jid?: { user?: string } | null;
  };
  qrcode?: string | null;
  qrCode?: string | null;
  pairingCode?: string | null;
  paircode?: string | null;
  fileURL?: string;
  mimetype?: string;
};

function enderecoDaApi(serverUrl: string, path: string): string {
  return `${serverUrl.replace(/\/+$/, "")}${path}`;
}

function detalheDoErro(body: UazapiBody, status: number): string {
  return (body.error ?? body.message ?? `http_${status}`).slice(0, 200);
}

async function requisitarUazapi(
  creds: UazapiCredentials,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: UazapiBody }> {
  const response = await fetch(enderecoDaApi(creds.serverUrl, path), {
    ...init,
    redirect: "error",
    headers: {
      token: creds.token,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as UazapiBody;
  return { response, body };
}

function statusDaSessao(body: UazapiBody): ChannelSessionStatus {
  const status =
    estadoDoCanalUazapi(body.instance?.status, Boolean(body.status?.connected || body.status?.loggedIn)) ??
    "FAILED";
  const jid = body.status?.jid?.user?.replace(/\D/g, "") || null;
  return {
    status,
    qrCode: body.instance?.qrcode ?? body.qrcode ?? body.qrCode ?? null,
    pairingCode: body.instance?.paircode ?? body.pairingCode ?? body.paircode ?? null,
    phoneNumber: jid,
    displayName: body.instance?.profileName ?? null,
  };
}

/** O JID preserva @lid e grupos; telefone comum vira o domínio nativo da API. */
export function resolveUazapiRecipient(input: RecipientInput): string | null {
  if (input.isGroup) return input.groupChatId || null;
  if (input.waLid) return `${input.waLid.replace(/\D/g, "")}@lid`;
  if (input.waIdentity?.startsWith("lid:")) {
    return `${input.waIdentity.slice("lid:".length).replace(/\D/g, "")}@lid`;
  }
  const telefone =
    input.phoneNumber ??
    (input.waIdentity?.startsWith("phone:") ? input.waIdentity.slice(6) : null);
  const digits = telefone?.replace(/\D/g, "") ?? "";
  return digits ? `${digits}@s.whatsapp.net` : null;
}

async function credenciaisDaSessao(input: ChannelTenantScope & { sessionRef: string }) {
  if (!canalUazapiLigado()) {
    throw new Error(
      `${NAO_CONFIGURADO}: o canal está desligado nesta instalação (UAZAPI_ENABLED).`,
    );
  }
  const creds = await resolveUazapiCreds(createAdminClient(), {
    organizationId: input.organizationId,
    instanceId: input.sessionRef,
  });
  if (!creds) throw new Error(`${NAO_CONFIGURADO}: nenhuma credencial gravada para esta sessão.`);
  return { ...creds, serverUrl: await validarUazapiServerUrl(creds.serverUrl) };
}

function corpoDeEnvio(envelope: OutboundEnvelope): { path: string; body: Record<string, unknown> } {
  const comum = {
    number: envelope.to,
    ...(envelope.replyToExternalId ? { replyid: envelope.replyToExternalId } : {}),
  };
  if (envelope.kind === "contact" && envelope.contact) {
    return {
      path: "/send/contact",
      body: {
        ...comum,
        fullName: envelope.contact.fullName,
        phoneNumber: envelope.contact.phoneNumber.replace(/\D/g, ""),
      },
    };
  }
  if (envelope.kind === "location" && envelope.location) {
    return {
      path: "/send/location",
      body: {
        ...comum,
        latitude: envelope.location.latitude,
        longitude: envelope.location.longitude,
        ...(envelope.location.nome ? { name: envelope.location.nome } : {}),
        ...(envelope.location.endereco ? { address: envelope.location.endereco } : {}),
      },
    };
  }
  if (envelope.media) {
    const type =
      envelope.kind === "audio" ? "ptt" : envelope.kind === "sticker" ? "sticker" : envelope.kind;
    return {
      path: "/send/media",
      body: {
        ...comum,
        type,
        file: envelope.media.url,
        mimetype: envelope.media.mime,
        ...(envelope.media.filename ? { docName: envelope.media.filename } : {}),
        ...(envelope.media.caption ? { text: envelope.media.caption } : {}),
      },
    };
  }
  if (envelope.kind !== "text") throw new Error("uazapi_unsupported_message_kind");
  return { path: "/send/text", body: { ...comum, text: envelope.body ?? "" } };
}

async function exigirSucesso(
  creds: UazapiCredentials,
  path: string,
  init: RequestInit,
): Promise<UazapiBody> {
  const { response, body } = await requisitarUazapi(creds, path, init);
  if (response.ok && !body.error) return body;

  if (body.provider_code === 463)
    throw new Error("uazapi_timelock: restrição temporária para iniciar conversas.");
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    throw new Error(
      `uazapi_rate_limited:${retryAfterMs ?? ""}: limite de requisições excedido.`,
    );
  }
  throw new Error(
    `uazapi_${body.provider_code ?? response.status}: ${detalheDoErro(body, response.status)}`,
  );
}

export const uazapiAdapter: ChannelAdapter = {
  provider: CHANNEL_PROVIDER_UAZAPI,

  resolveRecipient(input: RecipientInput): string | null {
    return resolveUazapiRecipient(input);
  },

  isConfigured(): boolean {
    // A presença da credencial é assíncrona e por sessão; `send` a confirma.
    return canalUazapiLigado();
  },

  codes: {
    notConfigured: NAO_CONFIGURADO,
    sendFailed: "uazapi_error",
    unknownError: "uazapi_unknown",
  },
  deferredErrors: [
    {
      prefix: "uazapi_timelock:",
      queuedReason: "uazapi_timelock",
      retryStrategy: "manual",
      operatorNotice: {
        kind: "channel_number_alert",
        severity: "warn",
        title: "O envio pelo WhatsApp foi temporariamente limitado",
        body: "A mensagem ficou na fila e não será reenviada automaticamente. Revise a situação do número antes de tentar novamente.",
      },
    },
    {
      prefix: "uazapi_rate_limited:",
      queuedReason: "uazapi_rate_limited",
      retryAfterMs(errorMessage) {
        const match = /^uazapi_rate_limited:(\d+):/.exec(errorMessage);
        if (!match) return null;
        const delay = Number(match[1]);
        return Number.isSafeInteger(delay) && delay > 0 ? delay : null;
      },
    },
  ],

  sessao: {
    async connect(input) {
      const creds = await credenciaisDaSessao(input);
      const body = await exigirSucesso(creds, "/instance/connect", {
        method: "POST",
        body: JSON.stringify(
          input.phoneNumber ? { phone: input.phoneNumber.replace(/\D/g, "") } : {},
        ),
      });
      return statusDaSessao(body);
    },

    async getStatus(input) {
      const creds = await credenciaisDaSessao(input);
      const { response, body } = await requisitarUazapi(creds, "/instance/status");
      if (!response.ok || body.error) {
        throw new Error(`uazapi_${response.status}: ${detalheDoErro(body, response.status)}`);
      }
      return statusDaSessao(body);
    },

    async disconnect(input) {
      const creds = await credenciaisDaSessao(input);
      await exigirSucesso(creds, "/instance/disconnect", { method: "POST", body: "{}" });
    },

    async delete(input) {
      const creds = await credenciaisDaSessao(input);
      await exigirSucesso(creds, "/instance", { method: "DELETE" });
    },
  },

  async checkHealth(input): Promise<ChannelHealth> {
    if (!canalUazapiLigado())
      return { reachable: false, status: null, detail: "canal_desligado_na_instalacao" };
    const storedCreds = await resolveUazapiCreds(createAdminClient(), {
      organizationId: input.organizationId,
      instanceId: input.sessionRef,
    });
    if (!storedCreds)
      return { reachable: false, status: null, detail: "sem_credencial_para_a_sessao" };

    try {
      const creds = {
        ...storedCreds,
        serverUrl: await validarUazapiServerUrl(storedCreds.serverUrl),
      };
      const { response, body } = await requisitarUazapi(creds, "/instance/status");
      if (response.status === 401 || response.status === 403) {
        return { reachable: true, status: "FAILED", detail: null };
      }
      if (!response.ok || body.error) {
        return { reachable: true, status: "FAILED", detail: detalheDoErro(body, response.status) };
      }
      return { reachable: true, status: statusDaSessao(body).status, detail: null };
    } catch (err) {
      const detail = err instanceof Error ? err.message : "erro_desconhecido";
      return { reachable: false, status: null, detail: detail.slice(0, 200) };
    }
  },

  async signalTyping(input): Promise<void> {
    const creds = await credenciaisDaSessao(input);
    await exigirSucesso(creds, "/message/presence", {
      method: "POST",
      body: JSON.stringify({
        number: input.recipient,
        presence: "composing",
        delay: PRESENCA_MAXIMA_MS,
      }),
    });
  },

  async editMessage(input): Promise<void> {
    const creds = await credenciaisDaSessao(input);
    await exigirSucesso(creds, "/message/edit", {
      method: "POST",
      body: JSON.stringify({ id: input.externalId, text: input.text }),
    });
  },

  async revokeMessage(input): Promise<void> {
    const creds = await credenciaisDaSessao(input);
    await exigirSucesso(creds, "/message/delete", {
      method: "POST",
      body: JSON.stringify({ id: input.externalId }),
    });
  },

  async fetchInboundMedia(input): Promise<FetchedMedia> {
    const prefix = "uazapi-message:";
    if (!input.url.startsWith(prefix)) throw new Error("uazapi_media_reference_invalid");
    let messageId: string;
    try {
      messageId = decodeURIComponent(input.url.slice(prefix.length));
    } catch {
      throw new Error("uazapi_media_reference_invalid");
    }
    if (!messageId || messageId.length > 300) throw new Error("uazapi_media_reference_invalid");

    const creds = await credenciaisDaSessao(input);
    const { response, body } = await requisitarUazapi(creds, "/message/download", {
      method: "POST",
      body: JSON.stringify({ id: messageId, return_link: true, generate_mp3: false }),
    });
    if (!response.ok || body.error || !body.fileURL) {
      throw new Error(`uazapi_media_download_${response.status}`);
    }

    let fileUrl: string;
    try {
      assertSafeOutboundUrl(body.fileURL);
      const parsed = new URL(body.fileURL);
      await assertDestinoResolvidoSeguro(parsed.hostname);
      fileUrl = parsed.toString();
    } catch {
      throw new Error("uazapi_media_url_unsafe");
    }
    const downloaded = await fetch(fileUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!downloaded.ok) throw new Error(`uazapi_media_file_${downloaded.status}`);
    const declared = Number(downloaded.headers.get("content-length") ?? 0);
    if (declared > MAX_MEDIA_BYTES) throw new MediaTooLargeError();
    if (!downloaded.body) throw new Error("uazapi_media_body_missing");
    const reader = downloaded.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_MEDIA_BYTES) {
          await reader.cancel();
          throw new MediaTooLargeError();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
    return {
      buffer,
      mime:
        body.mimetype ??
        downloaded.headers.get("content-type") ??
        input.hintMime ??
        "application/octet-stream",
    };
  },

  async send(envelope): Promise<{ externalId: string | null }> {
    const creds = await credenciaisDaSessao(envelope);
    const envio = corpoDeEnvio(envelope);
    await envelope.beforeSend?.();
    const body = await exigirSucesso(creds, envio.path, {
      method: "POST",
      body: JSON.stringify(envio.body),
    });
    return { externalId: body.messageid ?? body.id ?? null };
  },
};
