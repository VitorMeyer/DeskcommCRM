import { beforeEach, describe, expect, it } from "vitest";

import { sincronizarEstadoDaSessaoPareada } from "@/lib/channels/estado-da-sessao-pareada";

/**
 * O QUE A CONEXÃO PAREADA GRAVA QUANDO O TRANSPORTE RESPONDE.
 *
 * Dois defeitos que esta função existe para não repetir:
 *
 *  - desconectada, a API devolve `jid: null`; gravar isso apagava o número que
 *    dá nome ao aviso da Central ("QUAL conexão caiu?");
 *  - o número lido já pode pertencer a OUTRO canal ativo da organização (quem
 *    troca de transporte mantendo o número). O 23505 não pode virar 502 eterno,
 *    nem deixar o resto do estado sem gravar.
 */
type Escrita = { payload: Record<string, unknown>; filtros: [string, unknown][] };

const escritas: Escrita[] = [];
let respostas: ({ code: string; message: string } | null)[] = [];

const admin = {
  from: () => ({
    update: (payload: Record<string, unknown>) => {
      const filtros: [string, unknown][] = [];
      escritas.push({ payload, filtros });
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) => ok({ error: respostas.shift() ?? null });
            }
            return (...args: unknown[]) => {
              filtros.push([String(prop), args[1]]);
              return proxy;
            };
          },
        },
      ) as Record<string, unknown>;
      return proxy;
    },
  }),
} as never;

const SESSAO = {
  id: "s1",
  organization_id: "org-1",
  status: "WORKING",
  phone_number: "5531999998888",
  display_name: "Comercial",
};

beforeEach(() => {
  escritas.length = 0;
  respostas = [];
});

describe("sincronizarEstadoDaSessaoPareada", () => {
  it("desconectada (sem jid) NÃO apaga o número gravado", async () => {
    await sincronizarEstadoDaSessaoPareada(admin, SESSAO, {
      status: "STOPPED",
      phoneNumber: null,
    });
    expect(escritas).toHaveLength(1);
    expect(escritas[0]!.payload).toMatchObject({ status: "STOPPED" });
    expect(escritas[0]!.payload).not.toHaveProperty("phone_number");
  });

  it("só grava o número lido quando a conexão está de pé, e só se mudou", async () => {
    await sincronizarEstadoDaSessaoPareada(admin, { ...SESSAO, status: "STOPPED" }, {
      status: "WORKING",
      phoneNumber: "5511977776666",
    });
    expect(escritas[0]!.payload).toMatchObject({
      status: "WORKING",
      phone_number: "5511977776666",
    });

    escritas.length = 0;
    // mesmo estado, mesmo número, mesmo nome: nenhuma escrita
    await sincronizarEstadoDaSessaoPareada(admin, SESSAO, {
      status: "WORKING",
      phoneNumber: "5531999998888",
      displayName: "Comercial",
    });
    expect(escritas).toHaveLength(0);
  });

  it("escopa a escrita por organização E por id — service role não filtra sozinho", async () => {
    await sincronizarEstadoDaSessaoPareada(admin, SESSAO, { status: "STOPPED" });
    expect(escritas[0]!.filtros).toEqual([
      ["eq", "org-1"],
      ["eq", "s1"],
    ]);
  });

  it("carimba `last_status_change_at` só quando o status muda", async () => {
    await sincronizarEstadoDaSessaoPareada(admin, SESSAO, { status: "STOPPED" });
    expect(escritas[0]!.payload).toHaveProperty("last_status_change_at");

    escritas.length = 0;
    await sincronizarEstadoDaSessaoPareada(admin, SESSAO, {
      status: "WORKING",
      displayName: "Novo nome",
    });
    expect(escritas[0]!.payload).not.toHaveProperty("last_status_change_at");
    expect(escritas[0]!.payload).toMatchObject({ display_name: "Novo nome" });
  });

  it("número já ocupado por outro canal ativo: regrava SEM o telefone e devolve o conflito", async () => {
    respostas = [{ code: "23505", message: "channel_sessions_phone_per_org_unique" }, null];
    const r = await sincronizarEstadoDaSessaoPareada(admin, { ...SESSAO, status: "STOPPED", phone_number: null }, {
      status: "WORKING",
      phoneNumber: "5511977776666",
    });
    expect(r).toEqual({ phoneConflict: true });
    expect(escritas).toHaveLength(2);
    expect(escritas[0]!.payload).toHaveProperty("phone_number");
    // o estado não fica refém do conflito
    expect(escritas[1]!.payload).toMatchObject({ status: "WORKING" });
    expect(escritas[1]!.payload).not.toHaveProperty("phone_number");
  });

  it("outro erro do banco sobe — não é conflito de número", async () => {
    respostas = [{ code: "XX000", message: "boom" }];
    await expect(
      sincronizarEstadoDaSessaoPareada(admin, SESSAO, { status: "STOPPED" }),
    ).rejects.toThrow(/channel_session_status_update_failed/);
  });

  it("23505 numa escrita que nem tocava no telefone também sobe", async () => {
    respostas = [{ code: "23505", message: "outra unique" }];
    await expect(
      sincronizarEstadoDaSessaoPareada(admin, SESSAO, { status: "STOPPED" }),
    ).rejects.toThrow();
  });
});
