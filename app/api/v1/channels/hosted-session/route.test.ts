import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O WhatsApp hospedado é módulo opcional da instalação (`canal_uazapi`, ligado em
 * /admin/sistema — antes era `UAZAPI_ENABLED` no `.env`). Desligado, a rota de
 * conectar responde 404 antes de ler o corpo ou o banco. Ligado, ela segue o fluxo.
 */
const h = vi.hoisted(() => ({
  ligado: false,
  modulosPerguntados: [] as string[],
  lidas: 0,
  gravacoes: 0,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "cccccccc-0000-4000-8000-0000000000ee", idioma: "pt-BR" },
    org: { orgId: "cccccccc-0000-4000-8000-000000000001", role: "admin" },
  }),
}));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/instalacao/modulos", () => ({
  moduloLigado: async (_db: unknown, modulo: string) => {
    h.modulosPerguntados.push(modulo);
    return h.ligado;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/webhooks/url-publica", () => ({ basePublicaDaInstalacao: () => "https://crm.exemplo.com.br" }));
vi.mock("@/lib/channels/uazapi/session", () => ({
  findUazapiSession: async () => {
    h.lidas++;
    return null;
  },
  salvarUazapiSession: async () => {
    h.gravacoes++;
    return {
      ok: true,
      session: {
        id: "s1",
        instanceId: "inst-1",
        serverUrl: "https://servidor.exemplo.com",
        phoneNumber: null,
        displayName: null,
        status: "SCAN_QR_CODE",
        hasToken: true,
        webhookUrl: "u",
        archivedAt: null,
      },
    };
  },
}));

import { GET, POST } from "./route";

const url = "http://localhost/api/v1/channels/hosted-session";
const conectar = () =>
  POST(
    new NextRequest(url, {
      method: "POST",
      body: JSON.stringify({ server_url: "https://servidor.exemplo.com", token: "token-da-instancia" }),
    }),
  );

beforeEach(() => {
  h.ligado = false;
  h.modulosPerguntados = [];
  h.lidas = 0;
  h.gravacoes = 0;
});

describe("/api/v1/channels/hosted-session com o módulo desligado", () => {
  it("GET e POST respondem 404, sem ler a conexão nem gravar credencial", async () => {
    expect((await GET(new NextRequest(url))).status).toBe(404);
    expect((await conectar()).status).toBe(404);
    expect(h.lidas).toBe(0);
    expect(h.gravacoes).toBe(0);
    expect(h.modulosPerguntados).toEqual(["canal_uazapi", "canal_uazapi"]);
  });

  it("a variável antiga do `.env` não liga mais nada", async () => {
    process.env.UAZAPI_ENABLED = "true";
    try {
      expect((await GET(new NextRequest(url))).status).toBe(404);
    } finally {
      delete process.env.UAZAPI_ENABLED;
    }
  });
});

describe("/api/v1/channels/hosted-session com o módulo ligado (controle)", () => {
  it("GET devolve a conexão e POST grava", async () => {
    h.ligado = true;
    expect((await GET(new NextRequest(url))).status).toBe(200);
    expect(h.lidas).toBe(1);
    expect((await conectar()).status).toBe(201);
    expect(h.gravacoes).toBe(1);
  });
});
