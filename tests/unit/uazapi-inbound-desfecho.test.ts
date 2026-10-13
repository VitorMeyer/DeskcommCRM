import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O QUE O WEBHOOK DA INSTÂNCIA HOSPEDADA FAZ COM ACK, APAGAR E CONEXÃO.
 *
 * O envelope só LÊ o evento (`uazapi-envelope.test.ts`). Aqui o que se prende é
 * o efeito no banco — e o ponto é que o ACK não tem caminho próprio: passa pelo
 * mesmo passo de desfecho dos outros canais. Um UPDATE em lote escrito só para
 * este canal deixa de recusar o rebaixamento de `read` e deixa `delivered_at`
 * sem carimbo, e nada avisa: o tique aparece certo na tela.
 */
vi.mock("@/lib/channels/health", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sincronizarSaudeDaConexao: vi.fn(async () => "sem_mudanca"),
}));

import { handleInboundWebhook } from "@/lib/channels/inbound";

const fixture = (name: string) => readFileSync(`tests/fixtures/uazapi/${name}.json`, "utf8");

type Filtro = [string, unknown[]];
type Op = { tabela: string; op: string; payload?: unknown; filtros: Filtro[] };

const ops: Op[] = [];
let afetadas: unknown[] = [{ id: "m1" }];

function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
  const filtros: Filtro[] = [];
  ops.push({ tabela, op, payload, filtros });
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown) => ok({ data: afetadas, error: null });
        }
        return (...args: unknown[]) => {
          filtros.push([String(prop), args]);
          return proxy;
        };
      },
    },
  ) as Record<string, unknown>;
  return proxy;
}

const admin = {
  from: (t: string) => ({
    update: (p: unknown) => chain(t, "update", p),
    insert: (p: unknown) => chain(t, "insert", p),
    delete: () => chain(t, "delete"),
    select: () => chain(t, "select"),
  }),
} as never;

const SESSAO = {
  id: "sess-1",
  organization_id: "org-1",
  provider: "uazapi",
  display_name: "Comercial",
  phone_number: null,
};

const entrar = (rawBody: string) =>
  handleInboundWebhook(admin, { session: SESSAO, rawBody, headers: new Headers(), secret: "s".repeat(32) });

const atualizacoes = (tabela: string) => ops.filter((o) => o.tabela === tabela && o.op === "update");
const doFiltro = (o: Op, nome: string) => o.filtros.filter(([n]) => n === nome).map(([, a]) => a);

beforeEach(() => {
  ops.length = 0;
  afetadas = [{ id: "m1" }];
});

describe("ACK pelo passo de desfecho compartilhado", () => {
  it("atualiza o status de cada id, escopado por organização, sessão e id externo", async () => {
    const r = await entrar(fixture("messages-update-read"));
    expect(r).toEqual({ ok: true, body: { status: "ack", updated: 2 } });

    const porStatus = atualizacoes("messages").filter((o) => (o.payload as { status?: string }).status);
    expect(porStatus).toHaveLength(2); // um por id do recibo
    for (const [i, id] of ["TEST_MESSAGE_ID_A", "TEST_MESSAGE_ID_B"].entries()) {
      const eq = Object.fromEntries(doFiltro(porStatus[i]!, "eq").map(([k, v]) => [k, v]));
      expect(eq).toMatchObject({ organization_id: "org-1", channel_session_id: "sess-1", external_id: id });
      expect(porStatus[i]!.payload).toMatchObject({ status: "read" });
    }
  });

  it("não rebaixa `read`: um `delivered` atrasado não volta o tique para trás", async () => {
    await entrar(fixture("messages-update-delivered"));
    const up = atualizacoes("messages").find((o) => (o.payload as { status?: string }).status)!;
    expect(doFiltro(up, "not")).toContainEqual(["status", "in", "(read)"]);
  });

  it("`read` carimba `delivered_at` E `read_at`, cada um só se ainda estiver vazio", async () => {
    const raw = JSON.parse(fixture("messages-update-read"));
    raw.event.MessageIDs = ["TEST_MESSAGE_ID_A"];
    await entrar(JSON.stringify(raw));
    const carimbos = atualizacoes("messages").filter((o) => {
      const p = o.payload as Record<string, unknown>;
      return "delivered_at" in p || "read_at" in p;
    });
    const colunas = carimbos.map((o) => Object.keys(o.payload as object)[0]).sort();
    expect(colunas).toEqual(["delivered_at", "read_at"]);
    for (const c of carimbos) {
      expect(doFiltro(c, "is")).toContainEqual([Object.keys(c.payload as object)[0], null]);
      // A hora é a do EVENTO (segundos do transporte), não a de chegada do webhook.
      expect(Object.values(c.payload as object)[0]).toBe("2026-09-27T23:55:31.000Z");
    }
  });

  it("o dono ouvir o áudio do cliente não escreve nada (é mensagem RECEBIDA)", async () => {
    const r = await entrar(fixture("messages-update-played"));
    expect(r).toEqual({ ok: true, body: { status: "ignored", reason: "recibo_proprio" } });
    expect(ops).toHaveLength(0);
  });

  it("ACK de mensagem que não é nossa é ignorado sem criar nada", async () => {
    afetadas = [];
    const r = await entrar(fixture("messages-update-delivered"));
    expect(r).toEqual({ ok: true, body: { status: "ack", updated: 0 } });
    expect(ops.some((o) => o.op === "insert" || o.op === "delete")).toBe(false);
  });
});

describe("apagar para todos", () => {
  const apagado = JSON.stringify({
    EventType: "messages_update",
    state: "Deleted",
    event: { MessageIDs: ["MSG-A"], Type: "Deleted" },
  });

  it("carimba `revoked_at` e preserva a linha e o corpo", async () => {
    const r = await entrar(apagado);
    expect(r).toEqual({ ok: true, body: { status: "revoked", updated: 1 } });
    expect(ops.some((o) => o.op === "delete")).toBe(false);
    const up = atualizacoes("messages")[0]!;
    expect(up.payload).toHaveProperty("revoked_at");
    expect(up.payload).not.toHaveProperty("body");
  });

  it("casa por organização da SESSÃO e id externo — nunca só pelo id", async () => {
    await entrar(apagado);
    const eq = Object.fromEntries(doFiltro(atualizacoes("messages")[0]!, "eq").map(([k, v]) => [k, v]));
    expect(eq).toMatchObject({ organization_id: "org-1", external_id: "MSG-A" });
  });
});

describe("conexão", () => {
  it("só reinicia `last_status_change_at` quando o status MUDA", async () => {
    const r = await entrar(fixture("connection-disconnected"));
    expect(r).toEqual({ ok: true, body: { status: "connection_updated", connection: "STOPPED" } });

    const up = atualizacoes("channel_sessions")[0]!;
    expect(up.payload).toMatchObject({ status: "STOPPED" });
    expect(up.payload).toHaveProperty("last_status_change_at");
    // A condição `status é nulo ou diferente` é o que impede um evento repetido
    // de reiniciar a régua que o vigia de canal mudo lê como "desde quando funciona".
    expect(doFiltro(up, "or")).toContainEqual(["status.is.null,status.neq.STOPPED"]);
  });

  it("só toca a sessão do próprio provider, da própria organização, não arquivada", async () => {
    await entrar(fixture("connection-disconnected"));
    const up = atualizacoes("channel_sessions")[0]!;
    const eq = Object.fromEntries(doFiltro(up, "eq").map(([k, v]) => [k, v]));
    expect(eq).toMatchObject({ organization_id: "org-1", id: "sess-1", provider: "uazapi" });
    expect(doFiltro(up, "is")).toContainEqual(["archived_at", null]);
  });
});

describe("o que o webhook recusa ou ignora", () => {
  it("presença é reconhecida e não escreve nada", async () => {
    const r = await entrar(fixture("presence-composing"));
    expect(r).toEqual({ ok: true, body: { status: "ignored", reason: "evento_sem_interesse" } });
    expect(ops).toHaveLength(0);
  });

  it("JSON quebrado é `invalid_json`, e contrato violado nomeia o problema sem eco do payload", async () => {
    expect(await entrar("{nao é json")).toMatchObject({ ok: false, code: "invalid_json" });
    expect(
      await entrar(JSON.stringify({ EventType: "messages_update", event: { Type: "Read" } })),
    ).toMatchObject({ ok: false, code: "contrato_violado" });
  });
});
