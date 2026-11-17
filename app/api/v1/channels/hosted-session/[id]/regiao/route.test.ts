import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A região de saída do número hospedado: a cidade vem do CATÁLOGO do transporte
 * (texto livre seria salvo e só falharia no próximo ciclo da conexão), a escrita
 * é de administrador, e cada troca fica auditada.
 */
const h = vi.hoisted(() => ({
  definidas: [] as unknown[],
  auditorias: [] as unknown[],
  sessao: { id: "s1", provider: "uazapi", uazapi_instance_id: "inst-1", archived_at: null } as Record<string, unknown> | null,
}));

const CIDADES = [
  { valor: "belohorizonte", nome: "Belo Horizonte", estado: "mg", estadoNome: "Minas Gerais" },
  { valor: "abaete", nome: "Abaeté", estado: "mg", estadoNome: "Minas Gerais" },
  { valor: "goiania", nome: "Goiânia", estado: "go", estadoNome: "Goiás" },
];
const ATUAL = { pais: "br", estado: null, cidade: null, emUso: "regional", erro: null };

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "cccccccc-0000-4000-8000-0000000000ee", idioma: "pt-BR" },
    org: { orgId: "cccccccc-0000-4000-8000-000000000001", role: "admin" },
  }),
}));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: async (e: unknown) => void h.auditorias.push(e) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: h.sessao, error: null }),
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/channels", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAdapter: () => ({
    sessao: {
      regiao: {
        cidades: async ({ estado }: { estado?: string | null }) =>
          estado ? CIDADES.filter((c) => c.estado === estado) : CIDADES,
        atual: async () => ATUAL,
        definir: async (input: Record<string, unknown>) => {
          h.definidas.push(input);
          return { ...ATUAL, estado: input.estado, cidade: input.cidade };
        },
      },
    },
  }),
}));

import { GET, PUT } from "./route";

const params = { params: Promise.resolve({ id: "s1" }) };
const url = "http://localhost/api/v1/channels/hosted-session/s1/regiao";
const salvar = (corpo: unknown) =>
  PUT(new NextRequest(url, { method: "PUT", body: JSON.stringify(corpo) }), params);

beforeEach(() => {
  h.definidas = [];
  h.auditorias = [];
  h.sessao = { id: "s1", provider: "uazapi", uazapi_instance_id: "inst-1", archived_at: null };
});

describe("GET /regiao", () => {
  it("devolve a região atual e os estados do catálogo, sem repetição e em ordem", async () => {
    const r = await GET(new NextRequest(url), params);
    expect(r.status).toBe(200);
    const { data } = (await r.json()) as { data: { atual: unknown; estados: { sigla: string }[] } };
    expect(data.atual).toEqual(ATUAL);
    expect(data.estados.map((e) => e.sigla)).toEqual(["go", "mg"]);
  });

  it("com ?estado devolve só as cidades daquele estado; sigla fora do formato é recusada", async () => {
    const r = await GET(new NextRequest(`${url}?estado=mg`), params);
    const { data } = (await r.json()) as { data: { cidades: { valor: string }[] } };
    expect(data.cidades.map((c) => c.valor)).toEqual(["belohorizonte", "abaete"]);
    expect((await GET(new NextRequest(`${url}?estado=minas`), params)).status).toBe(422);
  });

  it("canal excluído não tem região", async () => {
    h.sessao = { ...h.sessao!, archived_at: "2026-11-17T00:00:00Z" };
    expect((await GET(new NextRequest(url), params)).status).toBe(404);
  });
});

describe("PUT /regiao", () => {
  it("cidade do catálogo: grava pelo canal e audita a troca", async () => {
    const r = await salvar({ estado: "MG", cidade: "belohorizonte" });
    expect(r.status).toBe(200);
    expect(h.definidas).toEqual([
      expect.objectContaining({ pais: "br", estado: "mg", cidade: "belohorizonte", sessionRef: "inst-1" }),
    ]);
    expect(h.auditorias).toEqual([
      expect.objectContaining({ action: "channel.region_updated", resourceId: "s1" }),
    ]);
  });

  it("cidade fora do catálogo daquele estado é recusada SEM gravar nada", async () => {
    const r = await salvar({ estado: "mg", cidade: "goiania" });
    expect(r.status).toBe(422);
    expect(h.definidas).toEqual([]);
    expect(h.auditorias).toEqual([]);
  });

  it("corpo fora do formato é recusado antes de qualquer consulta", async () => {
    expect((await salvar({ estado: "mg" })).status).toBe(422);
    expect((await salvar({ estado: "mg", cidade: "../etc" })).status).toBe(422);
    expect(h.definidas).toEqual([]);
  });
});
