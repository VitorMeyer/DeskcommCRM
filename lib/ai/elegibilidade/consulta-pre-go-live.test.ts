import { describe, expect, it, vi } from "vitest";

import { decidirPreGoLiveDoCanalViaSupabase } from "./consulta-pre-go-live";

function adminStub(resposta: { data: unknown; error: { message: string } | null }) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(() => Promise.resolve(resposta)),
  };
  return { client: { from: vi.fn(() => chain) } as never, chain };
}

const input = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  channelSessionId: "22222222-2222-4222-8222-222222222222",
  contactPhoneNumber: "+5585987654321",
};

describe("decidirPreGoLiveDoCanalViaSupabase", () => {
  it("não interfere num canal aberto ou num allowlist legado", async () => {
    for (const metadata of [{}, { ai_gate: "allowlist" }]) {
      const { client } = adminStub({ data: { metadata }, error: null });
      await expect(decidirPreGoLiveDoCanalViaSupabase(client, input)).resolves.toMatchObject({
        ativo: false,
        permite: true,
      });
    }
  });

  it("permite o testador e barra outro número", async () => {
    const metadata = {
      ai_gate: "allowlist",
      ai_gate_mode: "pre_go_live",
      ai_test_phone_numbers: [input.contactPhoneNumber],
    };
    const { client } = adminStub({ data: { metadata }, error: null });
    await expect(decidirPreGoLiveDoCanalViaSupabase(client, input)).resolves.toMatchObject({
      ativo: true,
      permite: true,
      motivo: "numero_de_teste",
    });

    const segundo = adminStub({ data: { metadata }, error: null }).client;
    await expect(
      decidirPreGoLiveDoCanalViaSupabase(segundo, {
        ...input,
        contactPhoneNumber: "+5585987654000",
      }),
    ).resolves.toMatchObject({
      ativo: true,
      permite: false,
      motivo: "fora_da_lista_de_teste",
    });
  });

  it("filtra canal por organização e falha fechado quando não consegue ler", async () => {
    const { client, chain } = adminStub({ data: null, error: { message: "indisponível" } });
    await expect(decidirPreGoLiveDoCanalViaSupabase(client, input)).rejects.toThrow(/indisponível/);
    expect(chain.eq).toHaveBeenCalledWith("organization_id", input.organizationId);
    expect(chain.eq).toHaveBeenCalledWith("id", input.channelSessionId);
  });
});

describe("envio para grupo no modo de teste (decisão de 2026-11-19)", () => {
  const metadata = { ai_gate: "allowlist", ai_gate_mode: "pre_go_live", ai_test_phone_numbers: [] };
  function adminPorTabela(grupo: { data: unknown; error: { message: string } | null }) {
    const from = vi.fn((tabela: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve(tabela === "channel_session_groups" ? grupo : { data: { metadata }, error: null }),
      };
      return chain;
    });
    return { client: { from } as never, from };
  }
  const paraGrupo = { ...input, contactPhoneNumber: "", groupChatId: "120363000000000000@g.us" };

  it("grupo com a chave da IA ligada passa; desligada, continua barrado", async () => {
    await expect(
      decidirPreGoLiveDoCanalViaSupabase(adminPorTabela({ data: { ia_responde: true }, error: null }).client, paraGrupo),
    ).resolves.toEqual({ ativo: true, permite: true, motivo: "grupo_liberado" });
    await expect(
      decidirPreGoLiveDoCanalViaSupabase(adminPorTabela({ data: { ia_responde: false }, error: null }).client, paraGrupo),
    ).resolves.toMatchObject({ permite: false, motivo: "fora_da_lista_de_teste" });
  });

  it("sem `groupChatId` a tabela de grupos nem é lida; erro nela é exceção", async () => {
    const individual = adminPorTabela({ data: { ia_responde: true }, error: null });
    await expect(decidirPreGoLiveDoCanalViaSupabase(individual.client, { ...input, contactPhoneNumber: "" })).resolves.toMatchObject({
      permite: false,
    });
    expect(individual.from).not.toHaveBeenCalledWith("channel_session_groups");
    await expect(
      decidirPreGoLiveDoCanalViaSupabase(adminPorTabela({ data: null, error: { message: "fora" } }).client, paraGrupo),
    ).rejects.toThrow(/grupo/);
  });
});

