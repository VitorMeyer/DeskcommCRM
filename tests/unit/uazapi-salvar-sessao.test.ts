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
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

type Op = {
  tabela: string;
  op: string;
  payload?: Record<string, unknown>;
  eqs: Record<string, unknown>;
};
const ops: Op[] = [];
let linhasExistentes: Record<string, unknown>[] = [];
let erroDaGravacao: { code: string; message?: string } | null = null;
/** Quantos grupos a conexão já tem ligados em Conexões › Grupos. */
let gruposLigados = 0;

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
    // Como o supabase-js: `maybeSingle` devolve UMA linha (ou null), não a lista.
    maybeSingle: () =>
      Promise.resolve(resolver(filtros)).then((r) => {
        const res = r as { data: unknown; error: unknown };
        return Array.isArray(res.data) ? { ...res, data: res.data[0] ?? null } : res;
      }),
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
      tabela === "channel_session_groups"
        ? construtor({ tabela, op: "select", eqs: {} }, () => ({ data: null, count: gruposLigados, error: null }))
        : construtor({ tabela, op: "select", eqs: {} }, (filtros) => ({
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
  gruposLigados = 0;
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) =>
      !String(url).endsWith("/webhook")
        ? statusDaInstancia()
        : init?.method === "POST"
          ? new Response("[]", { status: 200 })
          : new Response("[]", { status: 200 }), // a instância ainda sem webhook nenhum
    );
});
afterEach(() => vi.restoreAllMocks());

/** A ESCRITA do webhook (a leitura da lista vem antes, com GET). */
const chamadaDoWebhook = () =>
  fetchSpy.mock.calls.find(([url, init]) => String(url).endsWith("/webhook") && init?.method === "POST");

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
      // `add`, não o modo simples: o webhook de outra automação do cliente fica.
      action: "add",
      enabled: true,
      url: ENTRADA.webhookUrl,
      // Conexão nova não tem grupo ligado: o servidor nem entrega mensagem de grupo.
      excludeMessages: ["wasSentByApi", "isGroupYes"],
    });
    expect(corpo.events).toEqual(["messages", "messages_update", "connection"]);
    expect(corpo.events).not.toContain("presence");
    // a ordem importa: o estado `connected` nunca promete entrada que falhou
    const ordem = fetchSpy.mock.calls.map(([u, i]) => `${i?.method ?? "GET"} ${String(u).split("/").pop()}`);
    expect(ordem).toEqual(["GET status", "GET webhook", "POST webhook"]);
    expect(ops.findIndex((o) => o.op === "insert")).toBeGreaterThan(-1);
  });

  it("trocar o token de uma conexão com grupo LIGADO mantém o recebimento de grupos", async () => {
    linhasExistentes = [{ ...LINHA_SALVA }];
    gruposLigados = 2;
    const r = await salvarUazapiSession(admin, ENTRADA);
    expect(r.ok).toBe(true);
    const corpo = JSON.parse(String(chamadaDoWebhook()![1]?.body));
    expect(corpo.excludeMessages).toEqual(["wasSentByApi"]);
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

  it("depois de removida, reconectar a MESMA instância é linha nova; a arquivada fica com o histórico", async () => {
    linhasExistentes = [{ ...LINHA_SALVA, archived_at: "2026-09-01T00:00:00Z" }];
    const r = await salvarUazapiSession(admin, ENTRADA);
    expect(r.ok).toBe(true);
    expect(ops.some((o) => o.op === "update")).toBe(false);
    expect(ops.find((o) => o.op === "insert")?.payload).toMatchObject({
      organization_id: "org-1",
      uazapi_instance_id: "inst-1",
    });
  });

  it("a conexão removida não conta como ativa: não bloqueia nem recebe a troca", async () => {
    // Arquivada e WORKING no espelho (o arquivamento grava STOPPED, mas a regra
    // não pode depender disso): com o recorte de ativas, ela não é "o número
    // conectado" que recusaria a troca.
    linhasExistentes = [
      {
        ...LINHA_SALVA,
        uazapi_instance_id: "outra-inst",
        status: "WORKING",
        archived_at: "2026-09-01T00:00:00Z",
      },
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

  describe("troca de instância: o webhook desta conexão sai da ANTERIOR (decisão de 2026-11-19)", () => {
    const VELHA = "https://velha.example.test";
    const ANTERIOR = {
      ...LINHA_SALVA,
      uazapi_instance_id: "inst-velha",
      uazapi_server_url: VELHA,
      uazapi_instance_token_encrypted: "enc:velho",
      webhook_path_token: "caminho-velho",
      status: "STOPPED",
      phone_number: null,
    };
    const WEBHOOKS_DA_VELHA = [
      { id: "w-nosso", url: "https://crm.example.test/api/v1/webhooks/channel/caminho-velho" },
      { id: "w-deles", url: "https://automacao.example.test/hook" },
    ];
    /** O servidor novo responde como no `beforeEach`; o velho, com `respostaDaVelha`. */
    function servidores(respostaDaVelha: (init?: RequestInit) => Response) {
      fetchSpy.mockImplementation(async (url, init) => {
        if (String(url).startsWith(VELHA)) return respostaDaVelha(init);
        return !String(url).endsWith("/webhook") ? statusDaInstancia() : new Response("[]", { status: 200 });
      });
    }
    const escritasNaVelha = () =>
      fetchSpy.mock.calls
        .filter(([url, init]) => String(url) === `${VELHA}/webhook` && init?.method === "POST")
        .map(([, init]) => ({
          corpo: JSON.parse(String(init?.body)) as Record<string, unknown>,
          token: new Headers(init?.headers).get("token"),
        }));

    beforeEach(() => {
      vi.mocked(decryptWebhookSecret).mockImplementation(async (_admin: unknown, valor: string) =>
        valor === "enc:velho" ? "tok-velho" : null,
      );
    });

    it("apaga SÓ o webhook desta conexão na anterior, com o token dela, e diz que apagou", async () => {
      linhasExistentes = [{ ...ANTERIOR }];
      servidores((init) =>
        init?.method === "POST"
          ? new Response("{}", { status: 200 })
          : new Response(JSON.stringify(WEBHOOKS_DA_VELHA), { status: 200 }),
      );
      const r = await salvarUazapiSession(admin, ENTRADA);
      expect(r).toMatchObject({ ok: true, webhookAnteriorRemovido: true });
      expect(ops.find((o) => o.op === "update")?.payload).toMatchObject({ uazapi_instance_id: "inst-1" });
      expect(escritasNaVelha()).toEqual([{ corpo: { action: "delete", id: "w-nosso" }, token: "tok-velho" }]);
    });

    it("gravação recusada: a anterior NÃO perde o webhook (a remoção vem depois de salvar)", async () => {
      linhasExistentes = [{ ...ANTERIOR }];
      erroDaGravacao = { code: "XX000", message: "falhou" };
      servidores(() => new Response(JSON.stringify(WEBHOOKS_DA_VELHA), { status: 200 }));
      const r = await salvarUazapiSession(admin, ENTRADA);
      expect(r.ok).toBe(false);
      expect(escritasNaVelha()).toEqual([]);
    });

    it("anterior com o token morto (401): a troca fica salva e o webhook é dado como não removido", async () => {
      linhasExistentes = [{ ...ANTERIOR }];
      servidores(() => new Response("{}", { status: 401 }));
      const r = await salvarUazapiSession(admin, ENTRADA);
      expect(r).toMatchObject({ ok: true, webhookAnteriorRemovido: false });
      expect(ops.some((o) => o.op === "update")).toBe(true);
    });

    it("a MESMA instância e a conexão nova não mexem em instância anterior nenhuma", async () => {
      linhasExistentes = [{ ...LINHA_SALVA, uazapi_instance_token_encrypted: "enc:velho" }];
      expect(await salvarUazapiSession(admin, ENTRADA)).toMatchObject({ ok: true, webhookAnteriorRemovido: null });
      linhasExistentes = [];
      expect(await salvarUazapiSession(admin, ENTRADA)).toMatchObject({ ok: true, webhookAnteriorRemovido: null });
      const deletes = fetchSpy.mock.calls.filter(
        ([, init]) => init?.method === "POST" && String(init?.body).includes('"delete"'),
      );
      expect(deletes).toEqual([]);
    });
  });
});
