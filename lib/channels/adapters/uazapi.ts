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
import { CredencialRecusadaError } from "../credencial-recusada";
import {
  resolveUazapiCreds,
  validarUazapiServerUrl,
  type UazapiCredentials,
} from "../uazapi/credentials";
import { estadoDoCanalUazapi, numeroDaInstancia } from "../uazapi/estado";
import { requisitarNo, requisitarUazapi as requisitarHttp } from "../uazapi/http";
import { parseRetryAfterMs } from "../uazapi/retry-after";
import { caminhoDaConexao, definirRecebimentoDeGrupos } from "../uazapi/webhook-remoto";
import type {
  ChannelAdapter,
  ChannelGroup,
  ChannelHealth,
  CidadeDaRegiao,
  RegiaoDaConexao,
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
    /** Texto `"<número>:<aparelho>@s.whatsapp.net"` na API real; objeto na especificação. */
    jid?: unknown;
  };
  qrcode?: string | null;
  qrCode?: string | null;
  pairingCode?: string | null;
  paircode?: string | null;
  fileURL?: string;
  mimetype?: string;
};

function detalheDoErro(body: UazapiBody, status: number): string {
  return (body.error ?? body.message ?? `http_${status}`).slice(0, 200);
}

async function requisitarUazapi(
  creds: UazapiCredentials,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: UazapiBody }> {
  const { response, body } = await requisitarHttp(creds, path, init);
  const corpo = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  return { response, body: corpo as UazapiBody };
}

/**
 * `GET /instance/proxy` na forma neutra. `effective_mode` diz como a conexão SAI
 * agora; `mode` é só a preferência salva — numa contingência os dois divergem, e
 * a tela tem de mostrar a verdade, não o pedido.
 */
function regiaoDaResposta(body: unknown): RegiaoDaConexao {
  const d = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const texto = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const fallback = d.fallback && typeof d.fallback === "object" ? (d.fallback as Record<string, unknown>) : {};
  const efetivo = texto(d.effective_mode);
  const emUso: RegiaoDaConexao["emUso"] =
    fallback.active === true
      ? "contingencia"
      : efetivo === "custom"
        ? "propria"
        : efetivo === "direct"
          ? "direta"
          : "regional";
  return {
    pais: texto(d.proxy_managed_country) ?? "br",
    estado: texto(d.proxy_managed_state),
    cidade: texto(d.proxy_managed_city),
    emUso,
    erro: texto(d.last_test_error),
  };
}

function statusDaSessao(body: UazapiBody): ChannelSessionStatus {
  // `loggedIn`, não `connected`: durante o QR o socket já está aberto
  // (`connected`) sem número autenticado — tratar isso como conectado mostraria
  // "WORKING" na tela antes de alguém ler o código.
  const status = estadoDoCanalUazapi(body.instance?.status, body.status?.loggedIn === true) ?? "FAILED";
  return {
    status,
    qrCode: body.instance?.qrcode ?? body.qrcode ?? body.qrCode ?? null,
    pairingCode: body.instance?.paircode ?? body.pairingCode ?? body.paircode ?? null,
    phoneNumber: numeroDaInstancia(body),
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

/**
 * A credencial gravada da sessão. O módulo da instalação (`canal_uazapi`) não é
 * conferido aqui, de propósito: ele decide se a tela OFERECE conectar; uma
 * conexão já feita segue atendendo até a empresa removê-la, como o robô.
 */
async function credenciaisDaSessao(input: ChannelTenantScope & { sessionRef: string }) {
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

/** 401/403: a instância expirou, foi apagada ou teve o token trocado no painel. */
function credencialFoiRecusada(response: Response): boolean {
  return response.status === 401 || response.status === 403;
}

async function exigirSucesso(
  creds: UazapiCredentials,
  path: string,
  init: RequestInit,
  opcoes: { credencialComNome?: boolean } = {},
): Promise<UazapiBody> {
  const { response, body } = await requisitarUazapi(creds, path, init);
  if (response.ok && !body.error) return body;

  // Só nas operações de sessão: no envio, o 401 segue como `uazapi_401` e cai
  // na falha comum do envio, sem mudar o código que a mensagem registra.
  if (opcoes.credencialComNome && credencialFoiRecusada(response))
    throw new CredencialRecusadaError(detalheDoErro(body, response.status));

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
    return true;
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
      const body = await exigirSucesso(
        creds,
        "/instance/connect",
        {
          method: "POST",
          body: JSON.stringify(
            input.phoneNumber ? { phone: input.phoneNumber.replace(/\D/g, "") } : {},
          ),
        },
        { credencialComNome: true },
      );
      return statusDaSessao(body);
    },

    async getStatus(input) {
      const creds = await credenciaisDaSessao(input);
      const { response, body } = await requisitarUazapi(creds, "/instance/status");
      if (credencialFoiRecusada(response))
        throw new CredencialRecusadaError(detalheDoErro(body, response.status));
      if (!response.ok || body.error) {
        throw new Error(`uazapi_${response.status}: ${detalheDoErro(body, response.status)}`);
      }
      return statusDaSessao(body);
    },

    async disconnect(input) {
      const creds = await credenciaisDaSessao(input);
      await exigirSucesso(
        creds,
        "/instance/disconnect",
        { method: "POST", body: "{}" },
        { credencialComNome: true },
      );
    },

    regiao: {
      async cidades(input): Promise<CidadeDaRegiao[]> {
        const creds = await credenciaisDaSessao(input);
        const q = new URLSearchParams({ country: input.pais });
        if (input.estado) q.set("state", input.estado);
        // Catálogo público do servidor (não usa o token, mas a porta HTTP é a
        // mesma: URL já validada contra SSRF, sem seguir redirect).
        const { response, body } = await requisitarHttp(creds, `/proxy-managed/cities?${q.toString()}`);
        if (!response.ok) throw new Error(`uazapi_regiao_catalogo_${response.status}`);
        const lista = (body as { cities?: unknown }).cities;
        if (!Array.isArray(lista)) return [];
        return lista.flatMap((bruto): CidadeDaRegiao[] => {
          const c = bruto as Record<string, unknown>;
          return typeof c.value === "string" && typeof c.label === "string" && typeof c.state === "string"
            ? [
                {
                  valor: c.value,
                  nome: c.label,
                  estado: c.state,
                  estadoNome: typeof c.state_label === "string" ? c.state_label : c.state.toUpperCase(),
                },
              ]
            : [];
        });
      },

      async atual(input): Promise<RegiaoDaConexao> {
        const creds = await credenciaisDaSessao(input);
        const { response, body } = await requisitarHttp(creds, "/instance/proxy");
        if (credencialFoiRecusada(response)) throw new CredencialRecusadaError(`http_${response.status}`);
        if (!response.ok) throw new Error(`uazapi_regiao_${response.status}`);
        return regiaoDaResposta(body);
      },

      async definir(input): Promise<RegiaoDaConexao> {
        const creds = await credenciaisDaSessao(input);
        // `internal` = a infraestrutura de proxy do próprio serviço, com o alvo
        // geográfico pedido. O 200 confirma que a preferência foi salva; a rota
        // real é validada no próximo ciclo da conexão — por isso relemos.
        await exigirSucesso(
          creds,
          "/instance/proxy",
          {
            method: "POST",
            body: JSON.stringify({
              mode: "internal",
              proxy_managed_country: input.pais,
              proxy_managed_state: input.estado,
              proxy_managed_city: input.cidade,
            }),
          },
          { credencialComNome: true },
        );
        const { response, body } = await requisitarHttp(creds, "/instance/proxy");
        if (!response.ok) throw new Error(`uazapi_regiao_${response.status}`);
        return regiaoDaResposta(body);
      },
    },
  },

  async listGroups(input): Promise<ChannelGroup[]> {
    const creds = await credenciaisDaSessao(input);
    const grupos: ChannelGroup[] = [];
    // Paginado: um número com centenas de grupos não cabe numa resposta só, e a
    // lista sem participantes é a leve (a tela só precisa de id e nome).
    for (let offset = 0, pagina = 0; pagina < 20; pagina += 1) {
      const body = (await exigirSucesso(creds, "/group/list", {
        method: "POST",
        body: JSON.stringify({ noParticipants: true, limit: 500, offset }),
      })) as UazapiBody & { groups?: unknown; hasMore?: unknown; nextOffset?: unknown };
      const lista = Array.isArray(body.groups) ? body.groups : [];
      for (const bruto of lista) {
        const g = bruto as { JID?: unknown; Name?: unknown };
        if (typeof g.JID !== "string" || !g.JID.endsWith("@g.us")) continue;
        const nome = typeof g.Name === "string" && g.Name.trim() ? g.Name.trim() : g.JID;
        grupos.push({ chatId: g.JID, subject: nome });
      }
      if (body.hasMore !== true || typeof body.nextOffset !== "number") break;
      offset = body.nextOffset;
    }
    return grupos;
  },

  async setGroupIntake(input): Promise<boolean> {
    const creds = await credenciaisDaSessao(input);
    if (!creds.webhookPathToken) return false;
    return definirRecebimentoDeGrupos(requisitarNo(creds), {
      caminho: caminhoDaConexao(creds.webhookPathToken),
      receber: input.receive,
    });
  },

  async sendReaction(input): Promise<{ externalId: string | null }> {
    const creds = await credenciaisDaSessao(input);
    // Só `id` e `text`: a API acha o chat pela mensagem; texto vazio remove a reação.
    const body = await exigirSucesso(creds, "/message/react", {
      method: "POST",
      body: JSON.stringify({ id: input.externalId, text: input.emoji }),
    });
    // O `messageid` curto, a mesma forma que o webhook entrega — senão o eco
    // (quando houver) e esta linha seriam duas reações.
    return { externalId: body.messageid ?? null };
  },

  async checkHealth(input): Promise<ChannelHealth> {
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
