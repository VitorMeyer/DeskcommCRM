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

type Op = { tabela: string; op: string; payload?: Record<string, unknown> };
const ops: Op[] = [];
let linhasExistentes: Record<string, unknown>[] = [];
let erroDoInsert: { code: string } | null = null;

function chain(op: Op, resultado: () => unknown): Record<string, unknown> {
  ops.push(op);
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (ok: (v: unknown) => unknown) => ok(resultado());
        if (prop === "single" || prop === "maybeSingle") {
          return () => Promise.resolve(resultado());
        }
        return () => proxy;
      },
    },
  ) as Record<string, unknown>;
  return proxy;
}

const LINHA_SALVA = {
  id: "sess-1",
  uazapi_instance_id: "inst-1",
  uazapi_server_url: "https://uazapi.example.test",
  uazapi_instance_token_encrypted: "enc:tok",
  phone_number: "5531999998888",
  display_name: "Comercial",
  status: "WORKING",
  webhook_path_token: "caminho",
};

const admin = {
  from: (tabela: string) => ({
    select: () => chain({ tabela, op: "select" }, () => ({ data: linhasExistentes, error: null })),
    insert: (payload: Record<string, unknown>) =>
      chain({ tabela, op: "insert", payload }, () =>
        erroDoInsert ? { data: null, error: erroDoInsert } : { data: LINHA_SALVA, error: null },
      ),
    update: (payload: Record<string, unknown>) =>
      chain({ tabela, op: "update", payload }, () => ({ data: LINHA_SALVA, error: null })),
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
  erroDoInsert = null;
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

  it("organização com OUTRA instância ativa não troca em silêncio", async () => {
    linhasExistentes = [{ ...LINHA_SALVA, uazapi_instance_id: "outra-inst", archived_at: null }];
    const r = await salvarUazapiSession(admin, ENTRADA);
    expect(r).toMatchObject({ ok: false, motivo: expect.stringContaining("já tem uma instância") });
    expect(chamadaDoWebhook()).toBeUndefined(); // nem chegou a mexer no servidor remoto
    expect(ops.some((o) => o.op === "insert" || o.op === "update")).toBe(false);
  });

  it("a MESMA instância reconectada atualiza a linha e desarquiva", async () => {
    linhasExistentes = [{ ...LINHA_SALVA, archived_at: "2026-09-01T00:00:00Z" }];
    const r = await salvarUazapiSession(admin, ENTRADA);
    expect(r.ok).toBe(true);
    const update = ops.find((o) => o.op === "update")!;
    expect(update.payload).toMatchObject({ archived_at: null, uazapi_instance_id: "inst-1" });
    expect(ops.some((o) => o.op === "insert")).toBe(false);
  });

  it("instância já ligada a OUTRA organização é recusada pelo índice único, com texto claro", async () => {
    erroDoInsert = { code: "23505" };
    const r = await salvarUazapiSession(admin, ENTRADA);
    expect(r).toEqual({
      ok: false,
      motivo: "Esta instância já está conectada a outra organização.",
    });
  });

  it("token recusado pelo servidor não chega ao banco nem ao webhook", async () => {
    fetchSpy.mockImplementation(async () => new Response("{}", { status: 401 }));
    const r = await salvarUazapiSession(admin, ENTRADA);
    expect(r).toEqual({ ok: false, motivo: "Token recusado pelo servidor." });
    expect(ops).toHaveLength(0);
  });
});
