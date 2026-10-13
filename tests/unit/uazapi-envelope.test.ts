import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { lerEnvelopeUazapi, mensagemDeDesfecho } from "@/lib/channels/uazapi/envelope";

const fixture = (name: string) =>
  readFileSync(`tests/fixtures/uazapi/${name}.json`, "utf8");

describe("envelope Uazapi", () => {
  it("preserva telefone e LID juntos e lê o relógio da mensagem em milissegundos", () => {
    const parsed = lerEnvelopeUazapi(fixture("messages-inbound-ptt"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.event.kind !== "message") throw new Error("mensagem esperada");
    expect(parsed.event.message.identity).toMatchObject({
      phone: "+15555550100",
      bsuid: "test-lid",
      anchor: { kind: "bsuid", value: "test-lid" },
    });
    expect(parsed.event.message.sentAt).toBe("2026-09-27T23:57:44.000Z");
    expect(parsed.event.message.attachments[0]).toMatchObject({
      type: "audio",
      url: "uazapi-message:TEST_PTT_MESSAGE_ID",
    });
  });

  it("lê texto inbound: `content` string, remetente e relógio em milissegundos", () => {
    const parsed = lerEnvelopeUazapi(fixture("messages-inbound-text"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.event.kind !== "message") throw new Error("mensagem esperada");
    expect(parsed.event.message).toMatchObject({
      direction: "inbound",
      conversationId: "15555550100@s.whatsapp.net",
      externalId: "TEST_MESSAGE_ID",
      text: "mensagem de teste",
      attachments: [],
      sentAt: "2026-09-27T23:52:12.000Z",
      identity: { phone: "+15555550100", displayName: "Contato de teste" },
    });
  });

  it("aceita o relógio da mensagem também em segundos, sem virar 1970", () => {
    const raw = JSON.parse(fixture("messages-inbound-text"));
    raw.message.messageTimestamp = 1790553132;
    const parsed = lerEnvelopeUazapi(JSON.stringify(raw));
    if (!parsed.ok || parsed.event.kind !== "message") throw new Error("mensagem esperada");
    expect(parsed.event.message.sentAt).toBe("2026-09-27T23:52:12.000Z");
  });

  it("mapeia Played para leitura quando quem ouviu foi o CONTATO", () => {
    const raw = JSON.parse(fixture("messages-update-played"));
    raw.event.IsFromMe = false;
    expect(lerEnvelopeUazapi(JSON.stringify(raw))).toEqual({
      ok: true,
      event: {
        kind: "status",
        externalIds: ["TEST_PTT_MESSAGE_ID"],
        status: "read",
        occurredAt: "2026-09-27T23:58:08.000Z",
      },
    });
  });

  it("o dono ouvir o áudio do cliente (captura real: IsFromMe) não vira tique", () => {
    // O id do recibo é o do `messages-inbound-ptt`: uma mensagem RECEBIDA. Aplicar
    // "lida" ali marcaria como lida, na linha do cliente, algo que ele nunca leu.
    expect(lerEnvelopeUazapi(fixture("messages-update-played"))).toEqual({
      ok: true,
      event: { kind: "ignored", reason: "recibo_proprio" },
    });
  });

  it("lê o ACK de vários ids de uma vez, com o relógio em segundos", () => {
    expect(lerEnvelopeUazapi(fixture("messages-update-read"))).toEqual({
      ok: true,
      event: {
        kind: "status",
        externalIds: ["TEST_MESSAGE_ID_A", "TEST_MESSAGE_ID_B"],
        status: "read",
        occurredAt: "2026-09-27T23:55:31.000Z",
      },
    });
    expect(lerEnvelopeUazapi(fixture("messages-update-delivered"))).toMatchObject({
      ok: true,
      event: { kind: "status", status: "delivered", externalIds: ["TEST_OUTBOUND_MESSAGE_ID"] },
    });
  });

  it("traduz a desconexão pela API para STOPPED", () => {
    expect(lerEnvelopeUazapi(fixture("connection-disconnected"))).toEqual({
      ok: true,
      event: { kind: "connection", status: "STOPPED" },
    });
  });

  it("presença (digitando) é reconhecida e deliberadamente ignorada", () => {
    expect(lerEnvelopeUazapi(fixture("presence-composing"))).toEqual({
      ok: true,
      event: { kind: "ignored", reason: "evento_sem_interesse" },
    });
  });

  it("normaliza localização sem tratá-la como documento", () => {
    const parsed = lerEnvelopeUazapi(
      JSON.stringify({
        EventType: "messages",
        message: {
          messageid: "MSG-LOCATION",
          chatid: "5531999998888@s.whatsapp.net",
          fromMe: false,
          messageType: "LocationMessage",
          content: { latitude: -23.55, longitude: -46.63, name: "Praça da Sé" },
        },
      }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      event: {
        kind: "message",
        message: {
          location: { latitude: -23.55, longitude: -46.63, nome: "Praça da Sé" },
          attachments: [],
        },
      },
    });
  });

  it("mídia com legenda vira anexo do tipo certo e mantém o texto", () => {
    const raw = JSON.parse(fixture("messages-inbound-text"));
    raw.message.messageType = "ImageMessage";
    raw.message.mediaType = "image";
    raw.message.type = "media";
    raw.message.text = "olha isto";
    raw.message.content = { URL: "https://example.invalid/x.enc", mimetype: "image/jpeg" };
    const parsed = lerEnvelopeUazapi(JSON.stringify(raw));
    if (!parsed.ok || parsed.event.kind !== "message") throw new Error("mensagem esperada");
    expect(parsed.event.message.text).toBe("olha isto");
    expect(parsed.event.message.attachments).toEqual([
      { type: "image", url: "uazapi-message:TEST_MESSAGE_ID" },
    ]);
  });

  it("reação não vira mensagem nova — o CRM não a modela", () => {
    const raw = JSON.parse(fixture("messages-inbound-text"));
    raw.message.messageType = "ReactionMessage";
    raw.message.reaction = "TEST_MESSAGE_ID";
    raw.message.text = "👍";
    expect(lerEnvelopeUazapi(JSON.stringify(raw))).toEqual({
      ok: true,
      event: { kind: "ignored", reason: "reacao" },
    });
  });

  it("tipo desconhecido sem texto nem mídia é ignorado, não vira documento fantasma", () => {
    const raw = JSON.parse(fixture("messages-inbound-text"));
    raw.message.messageType = "PollCreationMessage";
    raw.message.text = "";
    raw.message.content = { name: "enquete" };
    expect(lerEnvelopeUazapi(JSON.stringify(raw))).toEqual({
      ok: true,
      event: { kind: "ignored", reason: "tipo_sem_suporte" },
    });
  });

  it("tipo desconhecido COM texto entra como texto — nada que o cliente escreveu se perde", () => {
    const raw = JSON.parse(fixture("messages-inbound-text"));
    raw.message.messageType = "TipoQueAindaNaoExiste";
    const parsed = lerEnvelopeUazapi(JSON.stringify(raw));
    if (!parsed.ok || parsed.event.kind !== "message") throw new Error("mensagem esperada");
    expect(parsed.event.message).toMatchObject({ text: "mensagem de teste", attachments: [] });
  });

  it("apagar para todos (`Deleted`) vira revogação dos ids afetados", () => {
    expect(
      lerEnvelopeUazapi(
        JSON.stringify({
          EventType: "messages_update",
          state: "Deleted",
          event: { MessageIDs: ["MSG-A", "MSG-B"], Type: "Deleted" },
        }),
      ),
    ).toEqual({ ok: true, event: { kind: "revoked", externalIds: ["MSG-A", "MSG-B"] } });
  });

  it("recibo que partiu do NOSSO número é sobre mensagem recebida: não vira tique", () => {
    const raw = JSON.parse(fixture("messages-update-read"));
    raw.event.IsFromMe = true;
    expect(lerEnvelopeUazapi(JSON.stringify(raw))).toEqual({
      ok: true,
      event: { kind: "ignored", reason: "recibo_proprio" },
    });
  });

  it("o desfecho normalizado carrega a hora do evento e o motivo só quando falhou", () => {
    expect(
      mensagemDeDesfecho({ externalId: "X", status: "read", occurredAt: "2026-09-27T23:55:31.000Z" }),
    ).toMatchObject({
      kind: "status",
      status: "read",
      statusAt: "2026-09-27T23:55:31.000Z",
      externalId: "X",
      errorReason: null,
    });
    expect(
      mensagemDeDesfecho({ externalId: "X", status: "failed", occurredAt: null }).errorReason,
    ).toMatch(/falha/i);
  });

  it.each([
    ["sent", "sent"],
    ["Delivered", "delivered"],
    ["Read", "read"],
    ["Played", "read"],
    ["Failed", "failed"],
  ] as const)("normaliza ACK %s", (type, status) => {
    const parsed = lerEnvelopeUazapi(
      JSON.stringify({
        EventType: "messages_update",
        type: "ReadReceipt",
        state: type,
        event: { MessageIDs: ["MSG-1"] },
      }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      event: { kind: "status", externalIds: ["MSG-1"], status, occurredAt: null },
    });
  });

  it("ignora eco enviado pela própria API e recusa atualização sem IDs", () => {
    expect(
      lerEnvelopeUazapi(
        JSON.stringify({
          EventType: "messages",
          message: {
            messageid: "MSG-2",
            chatid: "5531999998888@s.whatsapp.net",
            fromMe: true,
            wasSentByApi: true,
          },
        }),
      ),
    ).toMatchObject({ ok: true, event: { kind: "ignored", reason: "eco_da_api" } });
    expect(
      lerEnvelopeUazapi(JSON.stringify({ EventType: "messages_update", event: { Type: "Read" } })),
    ).toEqual({ ok: false, reason: "contract_violation" });
  });

  it.each([
    ["connected", "WORKING"],
    ["disconnected", "STOPPED"],
    ["hibernated", "STOPPED"],
    ["connecting", "SCAN_QR_CODE"],
    ["registering", "STARTING"],
    ["registration_conflict", "FAILED"],
  ] as const)("normaliza estado de conexão %s", (remoteStatus, status) => {
    expect(
      lerEnvelopeUazapi(
        JSON.stringify({ EventType: "connection", instance: { status: remoteStatus } }),
      ),
    ).toEqual({ ok: true, event: { kind: "connection", status } });
  });

  it("recusa mensagem sem direção booleana e aceita só IDs de ACK válidos", () => {
    expect(
      lerEnvelopeUazapi(
        JSON.stringify({
          EventType: "messages",
          message: { messageid: "MSG-3", chatid: "5531999998888@s.whatsapp.net" },
        }),
      ),
    ).toEqual({ ok: false, reason: "contract_violation" });
    expect(
      lerEnvelopeUazapi(
        JSON.stringify({
          EventType: "messages_update",
          event: { Type: "Read", MessageIDs: ["MSG-1", 4] },
        }),
      ),
    ).toEqual({ ok: false, reason: "contract_violation" });
  });
});
