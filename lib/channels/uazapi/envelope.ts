import { z } from "zod";

import { lerLocalizacao } from "@/lib/messaging/localizacao";

import type { ZernioInboundMessage } from "../zernio/webhook";
import { estadoDoCanalUazapi, type EstadoDoCanal } from "./estado";

const webhookSchema = z.looseObject({
  EventType: z.string().optional(),
  event: z.unknown().optional(),
  message: z.unknown().optional(),
});

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const timestampIso = (value: unknown): string | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  if (milliseconds > 8_640_000_000_000_000) return null;
  return new Date(milliseconds).toISOString();
};

export type UazapiWebhookEvent =
  | { kind: "message"; message: ZernioInboundMessage }
  | {
      kind: "status";
      externalIds: string[];
      status: "sent" | "delivered" | "read" | "failed";
      occurredAt: string | null;
    }
  | { kind: "revoked"; externalIds: string[] }
  | { kind: "connection"; status: EstadoDoCanal }
  | { kind: "ignored"; reason: string };

export type UazapiEnvelopeResult =
  | { ok: true; event: UazapiWebhookEvent }
  | { ok: false; reason: "invalid_json" | "contract_violation" };

/**
 * O desfecho de UMA mensagem, na forma que o ingest compartilhado já aplica.
 *
 * Existe para o ACK não ter caminho próprio: o passo comum recusa rebaixar
 * `read` para `delivered` e carimba `delivered_at`/`read_at` uma vez só (com
 * `read` sem `delivered` antes carimbando os dois). Um UPDATE escrito aqui
 * perderia as duas regras — e foi assim que uma instalação medida ficou com 41
 * entregas no dia sem nenhum `delivered_at`.
 */
export function mensagemDeDesfecho(input: {
  externalId: string;
  status: "sent" | "delivered" | "read" | "failed";
  occurredAt: string | null;
}): ZernioInboundMessage {
  return {
    direction: "outbound",
    kind: "status",
    status: input.status,
    statusAt: input.occurredAt,
    errorReason: input.status === "failed" ? "O WhatsApp informou falha na entrega." : null,
    conversationId: "",
    externalId: input.externalId,
    accountId: null,
    text: null,
    attachments: [],
    sentAt: null,
    identity: { phone: null, bsuid: null, username: null, displayName: null, anchor: null },
    referral: null,
  };
}

/** Lê os eventos documentados sem confiar em campos escolhidos pelo payload. */
export function lerEnvelopeUazapi(rawBody: string): UazapiEnvelopeResult {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  const checked = webhookSchema.safeParse(json);
  if (!checked.success) return { ok: false, reason: "contract_violation" };

  const root = checked.data;
  const eventName = str(root.EventType) ?? str(obj(root.event)?.Type) ?? str(root.event);
  if (eventName === "messages_update") {
    const inner = obj(root.event);
    return lerAtualizacao({
      ...root,
      ...(inner ?? {}),
      Type: inner?.Type ?? root.type,
      state: inner?.state ?? root.state,
      Timestamp: inner?.Timestamp ?? root.Timestamp,
      MessageIDs: inner?.MessageIDs ?? root.MessageIDs,
    });
  }
  if (eventName === "connection") {
    const status = estadoDoCanalUazapi(obj(root.instance)?.status);
    return status
      ? { ok: true, event: { kind: "connection", status } }
      : { ok: false, reason: "contract_violation" };
  }
  if (eventName !== "messages")
    return { ok: true, event: { kind: "ignored", reason: "evento_sem_interesse" } };

  const message = obj(root.message);
  if (!message) return { ok: false, reason: "contract_violation" };
  const externalId = str(message.messageid) ?? str(message.messageId);
  const conversationId = str(message.chatid);
  if (
    !externalId ||
    !conversationId ||
    typeof message.fromMe !== "boolean" ||
    (message.wasSentByApi !== undefined && typeof message.wasSentByApi !== "boolean") ||
    (message.messageType !== undefined && typeof message.messageType !== "string") ||
    (message.messageTimestamp !== undefined &&
      (typeof message.messageTimestamp !== "number" || !Number.isFinite(message.messageTimestamp))) ||
    (message.sender_pn !== undefined && message.sender_pn !== null && typeof message.sender_pn !== "string") ||
    (message.sender_lid !== undefined && message.sender_lid !== null && typeof message.sender_lid !== "string")
  )
    return { ok: false, reason: "contract_violation" };

  // A configuração exclui envios originados pela API. Reforçamos aqui para
  // evitar loops mesmo se o servidor remoto ignorar o filtro.
  if (message.fromMe === true && message.wasSentByApi === true) {
    return { ok: true, event: { kind: "ignored", reason: "eco_da_api" } };
  }

  // `reaction` carrega o id da mensagem reagida e vem vazio nas mensagens
  // comuns. O CRM não modela reação: gravá-la como mensagem nova mostraria um
  // "👍" solto no meio da conversa, sem dizer a que se refere.
  if (str(message.reaction)) return { ok: true, event: { kind: "ignored", reason: "reacao" } };

  const outbound = message.fromMe === true;
  const senderJid = str(message.sender) ?? str(message.sender_lid);
  const jid = outbound
    ? message.isGroup === true
      ? null
      : str(message.chatid)
    : (str(message.sender_pn) ?? senderJid);
  const phoneSource = str(message.sender_pn) ?? (!jid?.includes("@lid") ? jid : null);
  const phoneDigits = phoneSource?.replace(/@.*$/, "").replace(/\D/g, "") ?? "";
  const phone = phoneDigits.length >= 8 ? `+${phoneDigits}` : null;
  const lidJid = str(message.sender_lid) ?? (senderJid?.includes("@lid") ? senderJid : null);
  const lid = lidJid?.replace(/@lid$/, "") ?? null;
  const anchor = lid
    ? ({ kind: "bsuid", value: lid } as const)
    : phone
      ? ({ kind: "phone", value: phone } as const)
      : null;

  const sentAt = timestampIso(message.messageTimestamp ?? message.timestamp);
  const messageType = (str(message.messageType) ?? "text").toLowerCase();
  const content = obj(message.content);
  // Texto vem em `text` e, no texto simples, também como `content` string;
  // legenda de mídia vem em `text` ou `content.caption`.
  const text =
    str(message.text) ??
    str(content?.text) ??
    str(content?.caption) ??
    (typeof message.content === "string" ? str(message.content) : null);
  const location =
    messageType.includes("location")
      ? lerLocalizacao(content?.location ?? content)
      : null;
  const tipoDaMidia = location ? null : tipoDeAnexo(messageType, str(message.mediaType));
  const attachments = tipoDaMidia
    ? [
        {
          type: tipoDaMidia,
          // Não persiste URL remota arbitrária do webhook: o adapter busca
          // pela API autenticada usando o ID validado da mensagem.
          url: `uazapi-message:${encodeURIComponent(externalId)}`,
        },
      ]
    : [];

  // Enquete, contato, protocolo (edição/apagamento) e o que o transporte inventar
  // depois chegam sem texto, sem mídia e sem pino. Gravar isso criaria uma linha
  // vazia; o evento cru segue no arquivo de webhooks para reprocessar quando o
  // tipo ganhar suporte.
  if (!text && !location && attachments.length === 0) {
    return { ok: true, event: { kind: "ignored", reason: "tipo_sem_suporte" } };
  }

  return {
    ok: true,
    event: {
      kind: "message",
      message: {
        direction: outbound ? "outbound" : "inbound",
        kind: "message",
        conversationId,
        externalId,
        accountId: null,
        text,
        attachments,
        sentAt,
        ...(location ? { location } : {}),
        identity: {
          phone,
          bsuid: lid,
          username: null,
          displayName: str(message.senderName),
          anchor,
        },
        referral: null,
      },
    },
  };
}

function lerAtualizacao(value: unknown): UazapiEnvelopeResult {
  const event = obj(value);
  if (!event) return { ok: false, reason: "contract_violation" };
  const rawIds = event.MessageIDs ?? event.messageIds ?? event.messageids;
  const ids = Array.isArray(rawIds) && rawIds.every((id) => typeof id === "string")
    ? rawIds.filter((id): id is string => id.trim().length > 0)
    : [];
  if (ids.length === 0) return { ok: false, reason: "contract_violation" };

  const rawStatus = (str(event.state) ?? str(event.Type) ?? str(event.Status) ?? "").toLowerCase();
  // Apagar para todos gera `messages_update` com o estado "Deleted" (contrato da
  // API). É o único desfecho que não é tique: a linha continua, marcada apagada.
  if (rawStatus.includes("delet")) return { ok: true, event: { kind: "revoked", externalIds: ids } };
  // Recibo que PARTIU do nosso próprio número (`IsFromMe`) é a leitura, no
  // celular do operador, de uma mensagem que RECEBEMOS. Os ids são de linhas
  // inbound: aplicar o tique ali marcaria como "lida" uma mensagem do cliente.
  if (event.IsFromMe === true) return { ok: true, event: { kind: "ignored", reason: "recibo_proprio" } };
  const status = rawStatus.includes("read") || rawStatus.includes("played")
    ? "read"
    : rawStatus.includes("fail")
      ? "failed"
      : rawStatus.includes("deliver")
        ? "delivered"
        : rawStatus === "sent"
          ? "sent"
        : null;
  const occurredAt = timestampIso(event.Timestamp ?? event.timestamp);
  return status
    ? { ok: true, event: { kind: "status", externalIds: ids, status, occurredAt } }
    : { ok: true, event: { kind: "ignored", reason: "estado_sem_interesse" } };
}

/**
 * Só o que a API sabe devolver como arquivo vira anexo; qualquer outro tipo é
 * texto (ou nada). O oposto — "desconhecido é documento" — fabricava um anexo
 * que `POST /message/download` não consegue baixar para reação, enquete e afins.
 * `mediaType` (`ptt`, `image`…) vem pronto no evento e vale mais que o nome do tipo.
 */
function tipoDeAnexo(type: string, mediaType: string | null): string | null {
  const dica = `${mediaType?.toLowerCase() ?? ""} ${type}`;
  if (dica.includes("sticker")) return "sticker";
  if (dica.includes("image")) return "image";
  if (dica.includes("video")) return "video";
  if (dica.includes("audio") || dica.includes("ptt")) return "audio";
  if (dica.includes("document")) return "document";
  return null;
}
