import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * SALVAR A CONEXÃO: O QUE VAI PARA O BANCO E O QUE VAI PARA O SERVIDOR REMOTO.
 *
 * A credencial é da organização, cifrada na própria linha. O que estes casos
 * prendem é o que não se enxerga na tela: o token nunca vai em claro, o webhook
 * é registrado ANTES de a conexão ser dada como salva, e a lista de eventos não
 * traz o que o CRM ignora (cada "digitando…" viraria uma linha no arquivo de
 * webhooks).
 */
vi.mock("@/lib/automation/outbound-ip", () => ({
  assertDestinoResolvidoSeguro: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: vi.fn(async (_admin: unknown, valor: string) => `enc:${valor}`),
  decryptWebhookSecret: vi.fn(),
}));

import { salvarUazapiSession } from "@/lib/channels/uazapi/session";

type Op = {
  tabela: string;
  op: string;
  payload?: Record<string, unknown>;
  eqs: Record<string, unknown>;
};
const ops: Op[] = [];
let linhasExistentes: Record<string, unknown>[] = [];
let erroDaGravacao: { code: string; message?: string } | null = null;

/**
 * Banco falso que APLICA os filtros: a pergunta "qual linha recebe a
 * credencial?" depende de a consulta da ativa (`archived_at is null`) e a da
 * arquivada da instância (`not archived_at is null`) devolverem coisas
 * diferentes — um falso que ignora filtro responderia as duas com a mesma linha.
 */
function construtor(op: Op, resolver: (filtros: ((l: Record<string, unknown>) => boolean)[]) => unknown) {
  ops.push(op);
  const filtros: ((l: Record<string, unknown>) => boolean)[] = [];
  const b: Record<string, unknown> = {
    eq: (coluna: string, valor: unknown) => {
      op.eqs[coluna] = valor;
      filtros.push((l) => l[coluna] === valor);
      return b;
    },
    is: (coluna: string, valor: unknown) => {
      filtros.push((l) => (l[coluna] ?? null) === valor);
      return b;
    },
    not: (coluna: string, _op: string, valor: unknown) => {
      filtros.push((l) => (l[coluna] ?? null) !== valor);
      return b;
    },
    order: () => b,
    limit: () => b,
    select: () => b,
    single: () => Promise.resolve(resolver(filtros)),
    maybeSingle: () => Promise.resolve(resolver(filtros)),
    then: (ok: (v: unknown) => unknown) => ok(resolver(filtros)),
  };
  return b;
}

const LINHA_SALVA = {
  id: "sess-1",
  organization_id: "org-1",
  provider: "uazapi",
  uazapi_instance_id: "inst-1",
  uazapi_server_url: "https://uazapi.example.test",
  uazapi_instance_token_encrypted: "enc:tok",
  phone_number: "5531999998888",
  display_name: "Comercial",
  status: "WORKING",
  webhook_path_token: "caminho",
  archived_at: null,
};

const admin = {
  from: (tabela: string) => ({
    select: () =>
      construtor({ tabela, op: "select", eqs: {} }, (filtros) => ({
        data: linhasExistentes.filter((l) => filtros.every((f) => f(l))),
        error: null,
      })),
    insert: (payload: Record<string, unknown>) =>
      construtor({ tabela, op: "insert", payload, eqs: {} }, () =>
        erroDaGravacao
          ? { data: null, error: erroDaGravacao }
          : { data: { ...LINHA_SALVA, ...payload, id: "sess-nova" }, error: null },
      ),
    update: (payload: Record<string, unknown>) =>
      construtor({ tabela, op: "update", payload, eqs: {} }, () =>
        erroDaGravacao
          ? { data: null, error: erroDaGravacao }
          : { data: { ...LINHA_SALVA, ...payload }, error: null },
      ),
  }),
} as never;

const ENTRADA = {
  organizationId: "org-1",
  serverUrl: "https://uazapi.example.test",
  token: "tok",
  webhookPathToken: "caminho",
  webhookUrl: "https://crm.example.test/api/v1/webhooks/channel/caminho",
  basePublicUrl: "https://crm.example.test",
};

const statusDaInstancia = (extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      instance: { id: "inst-1", status: "connected", profileName: "Comercial" },
      status: { connected: true, loggedIn: true, jid: { user: "5531999998888" } },
      ...extra,
    }),
    { status: 200 },
  );

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  ops.length = 0;
  linhasExistentes = [];
  erroDaGravacao = null;
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url) =>
      String(url).endsWith("/webhook") ? new Response("{}", { status: 200 }) : statusDaInstancia(),
    );
});
afterEach(() => vi.restoreAllMocks());

const chamadaDoWebhook = () =>
  fetchSpy.mock.calls.find(([url]) => String(url).endsWith("/webhook"));

describe("salvarUazapiSession", () => {
  it("grava a linha da organização com o token CIFRADO e o número só em dígitos", async () => {
    const r = await salvarUazapiSession(admin, ENTRADA);
    expect(r.ok).toBe(true);

    const insert = ops.find((o) => o.op === "insert")!;
    expect(insert.tabela).toBe("channel_sessions");
    expect(insert.payload).toMatchObject({
      organization_id: "org-1",
      provider: "uazapi",
      uazapi_instance_id: "inst-1",
      uazapi_server_url: "https://uazapi.example.test",
      uazapi_instance_token_encrypted: "enc:tok",
      phone_number: "5531999998888", // sem "+": a trava de número único compara texto
      status: "WORKING",
    });
    expect(JSON.stringify(insert.payload)).not.toContain('"tok"'); // nunca em claro
  });

  it("registra o webhook ANTES de salvar, sem `presence` e filtrando o eco da própria API", async () => {
    await salvarUazapiSession(admin, ENTRADA);

    const [url, init] = chamadaDoWebhook()!;
    expect(String(url)).toBe("https://uazapi.example.test/webhook");
    expect(init?.redirect).toBe("error");
    const corpo = JSON.parse(String(init?.body));
    expect(corpo).toMatchObject({
      enabled: true,
      url: ENTRADA.webhookUrl,
      excludeMessages: ["wasSentByApi"],
    });
    expect(corpo.events).toEqual(["messages", "messages_update", "connection"]);
    expect(corpo.events).not.toContain("presence");
    // a ordem importa: o estado `connected` nunca promete entrada que falhou
    const ordem = fetchSpy.mock.calls.map(([u]) => String(u).split("/").pop());
    expect(ordem).toEqual(["status", "webhook"]);
  });

  it("webhook recusado pelo servidor: NADA é gravado", async () => {
    fetchSpy.mockImplementation(async (url) =>
      String(url).endsWith("/webhook") ? new Response("{}", { status: 500 }) : statusDaInstancia(),
    );
    const r = await salvarUazapiSession(admin, ENTRADA);
    expect(r).toMatchObject({ ok: false });
    expect(ops.some((o) => o.op === "insert" || o.op === "update")).toBe(false);
  });

  it("OUTRA instância com o número atual CONECTADO não troca em silêncio", async () => {
    linhasExistentes = [{ ...LINHA_SALVA, uazapi_instance_id: "outra-inst", status: "WORKING" }];
    const r = await salvarUazapiSession(admin, ENTRADA);
    expect(r).toEqual({
      ok: false,
      motivo: "O número atual está conectado. Desconecte-o antes de trocar de instância.",
    });
    expect(chamadaDoWebhook()).toBeUndefined(); // nem chegou a mexer no servidor remoto
    expect(ops.some((o) => o.op === "insert" || o.op === "update")).toBe(false);
  });

  it("instância anterior caída: o token de OUTRA instância troca a conexão NA MESMA LINHA", async () => {
    // O beco do primeiro teste vivo: a instância gratuita expirou, o token morreu,
    // e a tela recusava o token novo até a antiga ser desconectada — o que exigia
    // o token morto.
    linhasExistentes = [
      { ...LINHA_SALVA, uazapi_instance_id: "inst-expirada", status: "FAILED", phone_number: null },
    ];
    const r = await salvarUazapiSession(admin, ENTRADA);
    expect(r.ok).toBe(true);

    const update = ops.find((o) => o.op === "update")!;
    expect(update.eqs).toMatchObject({ organization_id: "org-1", id: "sess-1" });
    expect(update.payload).toMatchObject({
      uazapi_instance_id: "inst-1",
      uazapi_instance_token_encrypted: "enc:tok",
      webhook_path_token: "caminho",
      status: "WORKING",
      archived_at: null,
    });
    expect(ops.some((o) => o.op === "insert")).toBe(false);
    expect(chamadaDoWebhook()).toBeDefined(); // o webhook vai para a instância NOVA
  });

  it("a MESMA instância com token novo (trocado no painel) atualiza a linha, mesmo conectada", async () => {
    linhasExistentes = [{ ...LINHA_SALVA, uazapi_instance_token_encrypted: "enc:velho" }];
    const r = await salvarUazapiSession(admin, { ...ENTRADA, token: "tok" });
    expect(r.ok).toBe(true);
    const update = ops.find((o) => o.op === "update")!;
    expect(update.eqs).toMatchObject({ id: "sess-1" });
    expect(update.payload).toMatchObject({ uazapi_instance_token_encrypted: "enc:tok" });
  });

  it("a MESMA instância reconectada depois de removida desarquiva a linha dela", async () => {
    linhasExistentes = [{ ...LINHA_SALVA, archived_at: "2026-09-01T00:00:00Z" }];
    const r = await salvarUazapiSession(admin, ENTRADA);
    expect(r.ok).toBe(true);
    const update = ops.find((o) => o.op === "update")!;
    expect(update.eqs).toMatchObject({ organization_id: "org-1", id: "sess-1" });
    expect(update.payload).toMatchObject({ archived_at: null, uazapi_instance_id: "inst-1" });
    expect(ops.some((o) => o.op === "insert")).toBe(false);
  });

  it("linha arquivada de OUTRA instância não volta: a conexão nova é linha nova", async () => {
    linhasExistentes = [
      { ...LINHA_SALVA, uazapi_instance_id: "outra-inst", archived_at: "2026-09-01T00:00:00Z" },
    ];
    const r = await salvarUazapiSession(admin, ENTRADA);
    expect(r.ok).toBe(true);
    expect(ops.some((o) => o.op === "update")).toBe(false);
    expect(ops.find((o) => o.op === "insert")?.payload).toMatchObject({
      uazapi_instance_id: "inst-1",
    });
  });

  it("instância já ligada a OUTRA organização é recusada pelo índice único, com texto claro", async () => {
    erroDaGravacao = {
      code: "23505",
      message:
        'duplicate key value violates unique constraint "channel_sessions_uazapi_instance_id_ativo_unique"',
    };
    const r = await salvarUazapiSession(admin, ENTRADA);
    expect(r).toEqual({
      ok: false,
      motivo: "Esta instância já está conectada a outra organização.",
    });
  });

  it("número já ligado a outro canal desta organização é dito como tal, não como outra organização", async () => {
    erroDaGravacao = {
      code: "23505",
      message:
        'duplicate key value violates unique constraint "channel_sessions_phone_per_org_unique"',
    };
    const r = await salvarUazapiSession(admin, ENTRADA);
    expect(r).toMatchObject({
      ok: false,
      motivo: expect.stringContaining("já está conectado em outro canal ativo desta organização"),
    });
  });

  it("token recusado pelo servidor não chega ao banco nem ao webhook", async () => {
    fetchSpy.mockImplementation(async () => new Response("{}", { status: 401 }));
    const r = await salvarUazapiSession(admin, ENTRADA);
    expect(r).toEqual({ ok: false, motivo: "Token recusado pelo servidor." });
    expect(ops).toHaveLength(0);
  });
});
