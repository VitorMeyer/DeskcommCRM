/**
 * O parser do canal hospedado contra payloads REAIS (sanitizados) — mensagem
 * enviada pelo celular, edição, reação e grupo, os quatro casos que o spike não
 * tinha capturado. Origem e régua de sanitização: `tests/fixtures/uazapi/README.md`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { lerEnvelopeUazapi } from "@/lib/channels/uazapi/envelope";

const fixture = (nome: string) =>
  readFileSync(join(process.cwd(), "tests/fixtures/uazapi", `${nome}.json`), "utf8");

const DONO = { phone: "+5511900000001", lid: "900000000000001" };
const CLIENTE = { phone: "+5511900000002", lid: "900000000000002" };
const GRUPO = "120363000000000001@g.us";

describe("mensagem enviada pelo celular do dono", () => {
  it("o contato é quem RECEBEU (o chat), nunca o próprio número da empresa", () => {
    const r = lerEnvelopeUazapi(fixture("messages-outbound-pelo-celular"));
    expect(r).toMatchObject({ ok: true, event: { kind: "message" } });
    if (!r.ok || r.event.kind !== "message") throw new Error("esperava mensagem");
    const m = r.event.message;
    expect(m.direction).toBe("outbound");
    expect(m.identity.phone).toBe(CLIENTE.phone);
    expect(m.identity.phone).not.toBe(DONO.phone);
    expect(m.identity.bsuid).not.toBe(DONO.lid);
    expect(m.identity.bsuid).toBe(CLIENTE.lid);
    expect(m.identity.anchor).toEqual({ kind: "bsuid", value: CLIENTE.lid });
    // O nome no evento é o do dono; gravá-lo no contato renomearia o cliente.
    expect(m.identity.displayName).not.toBe("Dono de teste");
  });

  it("a recebida continua usando o remetente", () => {
    const r = lerEnvelopeUazapi(fixture("messages-inbound-text"));
    if (!r.ok || r.event.kind !== "message") throw new Error("esperava mensagem");
    expect(r.event.message.direction).toBe("inbound");
    expect(r.event.message.identity.displayName).toBe("Contato de teste");
  });
});

describe("edição", () => {
  it("a edição do cliente aponta para a mensagem ORIGINAL e não vira mensagem nova", () => {
    expect(lerEnvelopeUazapi(fixture("messages-inbound-editada"))).toEqual({
      ok: true,
      event: { kind: "edited", externalId: "AC98212CD4909DE6799E78D93A824A3F", body: "Oi2" },
    });
  });

  it("a edição feita pelo celular do dono também", () => {
    expect(lerEnvelopeUazapi(fixture("messages-outbound-editada-pelo-celular"))).toEqual({
      ok: true,
      event: { kind: "edited", externalId: "ACF3BAA609D967CF59AF1F4A8CE59202", body: "Oi2" },
    });
  });
});

describe("reação", () => {
  it("vira reação ligada ao alvo, com o emoji e quem reagiu", () => {
    const r = lerEnvelopeUazapi(fixture("messages-inbound-reacao"));
    expect(r).toMatchObject({
      ok: true,
      event: {
        kind: "reaction",
        reacao: {
          externalId: "ACA560BBE49219D22145948EA04BADDE",
          alvoExternalId: "AC24A7E68360C7E9A54F64AB85FAECE2",
          emoji: "❤️",
          author: "900000000000002@lid",
          direction: "inbound",
        },
      },
    });
  });

  it("reação dentro de grupo também é reação (o alvo diz a conversa)", () => {
    const r = lerEnvelopeUazapi(fixture("messages-grupo-inbound-reacao"));
    expect(r).toMatchObject({
      ok: true,
      event: { kind: "reaction", reacao: { alvoExternalId: "AC22BF3A36A96598EEC85BFBDF00BECD" } },
    });
  });
});

describe("grupo", () => {
  it("mensagem de grupo NUNCA vira conversa individual com quem escreveu", () => {
    const r = lerEnvelopeUazapi(fixture("messages-grupo-inbound-text"));
    expect(r).toMatchObject({
      ok: true,
      event: {
        kind: "group",
        entrada: {
          groupChatId: GRUPO,
          direction: "inbound",
          externalId: "AC4D6F7672164E5C348BA0847D4F55B5",
          type: "text",
          body: "Oi",
          remetente: { name: "Contato de teste", phone: CLIENTE.phone, lid: CLIENTE.lid },
        },
      },
    });
  });

  it("a enviada pelo celular no grupo entra sem remetente (é a loja)", () => {
    const r = lerEnvelopeUazapi(fixture("messages-grupo-outbound-pelo-celular"));
    expect(r).toMatchObject({
      ok: true,
      event: { kind: "group", entrada: { groupChatId: GRUPO, direction: "outbound", remetente: null } },
    });
  });

  it("mídia de grupo vai pela referência autenticada, nunca pela URL do evento", () => {
    const r = lerEnvelopeUazapi(fixture("messages-grupo-inbound-imagem"));
    expect(r).toMatchObject({
      ok: true,
      event: {
        kind: "group",
        entrada: {
          type: "image",
          mediaUrl: "uazapi-message:AC290EF75336247CBAE610FFE1C4E693",
          mediaMime: "image/jpeg",
          temMidia: true,
        },
      },
    });
  });
});

describe("eventos de grupo (entrar/sair)", () => {
  it("são ignorados sem erro: o webhook nem os assina", () => {
    expect(lerEnvelopeUazapi(fixture("groups-entrou"))).toMatchObject({
      ok: true,
      event: { kind: "ignored" },
    });
  });
});

describe("recibo de mensagem nossa num grupo (`GroupReceipts`, lido ao vivo em 2026-11-19)", () => {
  it("o estado vem por participante e vira o tique da mensagem: entregue, depois lida", () => {
    expect(lerEnvelopeUazapi(fixture("messages-update-grupo-delivered"))).toEqual({
      ok: true,
      event: {
        kind: "status",
        externalIds: ["3EB0TESTGROUPRECEIPT01"],
        status: "delivered",
        occurredAt: new Date(1790553400 * 1000).toISOString(),
      },
    });
    expect(lerEnvelopeUazapi(fixture("messages-update-grupo-read"))).toMatchObject({
      ok: true,
      event: { kind: "status", externalIds: ["3EB0TESTGROUPRECEIPT01"], status: "read" },
    });
  });

  it("vários participantes: vale o mais avançado; lista sem estado conhecido continua ignorada", () => {
    const base = JSON.parse(fixture("messages-update-grupo-delivered")) as {
      event: { Receipts: Record<string, unknown>[] };
    };
    const [primeiro] = base.event.Receipts;
    base.event.Receipts = [primeiro!, { ...primeiro!, state: "Read", timestamp: 1790553500 }];
    expect(lerEnvelopeUazapi(JSON.stringify(base))).toMatchObject({
      ok: true,
      event: { kind: "status", status: "read", occurredAt: new Date(1790553500 * 1000).toISOString() },
    });
    base.event.Receipts = [{ ...primeiro!, state: "Algo" }];
    expect(lerEnvelopeUazapi(JSON.stringify(base))).toMatchObject({
      ok: true,
      event: { kind: "ignored", reason: "estado_sem_interesse" },
    });
  });
});

