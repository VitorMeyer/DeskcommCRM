import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { countAs, sql, writeCountAs } from "./gov-helpers";

/**
 * 0659 · o canal hospedado por instância, cobrado no banco que o CLONE recebe.
 *
 * Lê o Postgres descartável que nasce do `supabase/baseline.sql` — o arquivo que
 * o self-hoster aplica. Migration que existe só em `migrations/` não chega a ele.
 *
 * ─── O que está sob prova ───────────────────────────────────────────────────
 *
 *  1. **A união de referências vale para o provider novo.** Sessão sem qualquer
 *     das três colunas da credencial é RECUSADA — senão uma linha sem URL ou sem
 *     token existe e todo envio por ela falha só na hora de enviar.
 *  2. **A instância é única entre as ativas, e a organização só tem uma.** Duas
 *     organizações com a mesma instância remota receberiam, uma da outra, o
 *     tráfego do mesmo número (o resolvedor de credencial é service role e
 *     bypassa RLS). O nome da trava vem no erro: "rejeitou" sozinho não distingue
 *     esta trava de um CHECK ou da RLS.
 *  3. **Isolamento entre tenants nas duas direções**, inclusive o lado `with check`.
 *  4. **O apêndice do baseline é AUTO-CURATIVO.** O `update.sh` re-aplica o
 *     baseline sem `ON_ERROR_STOP`: um clone que já tem duas linhas com a mesma
 *     instância ativa não pode parar no primeiro 23505 ao criar o índice único.
 *     O caso semeia a duplicata, re-aplica o bloco EXTRAÍDO DO ARQUIVO e mede.
 */

const ORG_A = "0659aaaa-0000-4000-8000-000000000001";
const ORG_B = "0659bbbb-0000-4000-8000-000000000002";
const ADMIN_A = "0659aaaa-1111-4000-8000-000000000001";
const ADMIN_B = "0659bbbb-1111-4000-8000-000000000002";
const SERVIDOR = "https://servidor.example.test";

function seed(): void {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN_A}', 'uz-admin-a@invariant.test'),
      ('${ADMIN_B}', 'uz-admin-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'uz-inv-a', 'Uazapi Inv A', 'UZ Inv A'),
      ('${ORG_B}', 'uz-inv-b', 'Uazapi Inv B', 'UZ Inv B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN_A}', '${ORG_A}', 'admin', now()),
      ('${ADMIN_B}', '${ORG_B}', 'admin', now())
      on conflict do nothing;
  `);
}

function inserir(org: string, extra: Record<string, string> = {}): string {
  const cols: Record<string, string> = {
    provider: `'uazapi'`,
    uazapi_instance_id: `'inst-a'`,
    uazapi_server_url: `'${SERVIDOR}'`,
    uazapi_instance_token_encrypted: `'\\x01'::bytea`,
    ...extra,
  };
  const nomes = ["organization_id", "webhook_secret_encrypted", ...Object.keys(cols)];
  const vals = [`'${org}'`, `'\\x00'::bytea`, ...Object.values(cols)];
  return sql(`
    insert into public.channel_sessions (${nomes.join(", ")})
    values (${vals.join(", ")});
    select 'ok';
  `);
}

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
  throw new Error("o INSERT passou — a trava não existe neste banco");
}

function limpar(): void {
  sql(`delete from public.channel_sessions where organization_id in ('${ORG_A}', '${ORG_B}')`);
}

describe("0659 · a sessão hospedada é uma linha completa ou não existe", () => {
  it("o vocabulário do banco conhece o provider (sessão e arquivo de webhooks)", () => {
    seed();
    expect(inserir(ORG_A)).toContain("ok");
    const arquivo = sql(`
      insert into public.webhook_events_log (organization_id, provider, http_method, raw_body, status)
      values ('${ORG_A}', 'uazapi', 'POST', '{}', 'received');
      select 'ok';
    `);
    expect(arquivo).toContain("ok");
    limpar();
  });

  it.each([
    ["uazapi_instance_id", "null"],
    ["uazapi_server_url", "null"],
    ["uazapi_instance_token_encrypted", "null"],
  ])("sessão sem %s é RECUSADA pela união de referências", (coluna, valor) => {
    seed();
    const msg = erroDe(() => inserir(ORG_A, { [coluna]: valor }));
    expect(msg).toMatch(/channel_sessions_provider_ref_check/);
    limpar();
  });
});

describe("0659 · a instância é única entre as ativas", () => {
  it("duas ORGANIZAÇÕES não podem ter a mesma instância no mesmo servidor", () => {
    seed();
    limpar();
    inserir(ORG_A);
    const msg = erroDe(() => inserir(ORG_B));
    expect(msg).toContain("channel_sessions_uazapi_instance_id_ativo_unique");
    limpar();
  });

  it("a MESMA id em servidores DIFERENTES convive — a id não é global", () => {
    seed();
    limpar();
    inserir(ORG_A);
    expect(inserir(ORG_B, { uazapi_server_url: `'https://outro.example.test'` })).toContain("ok");
    limpar();
  });

  it("a organização só tem UMA instância ativa (v1)", () => {
    seed();
    limpar();
    inserir(ORG_A);
    const msg = erroDe(() => inserir(ORG_A, { uazapi_instance_id: `'inst-b'` }));
    expect(msg).toContain("channel_sessions_uazapi_org_ativo_unique");
    limpar();
  });

  it("arquivar LIBERA a instância e a vaga da organização — senão excluir e reconectar trava", () => {
    seed();
    limpar();
    inserir(ORG_A);
    sql(`update public.channel_sessions set archived_at = now() where organization_id = '${ORG_A}'`);
    expect(inserir(ORG_B)).toContain("ok"); // a instância voltou a ser de quem quiser
    expect(inserir(ORG_A, { uazapi_instance_id: `'inst-nova'` })).toContain("ok"); // e a org reconecta
    limpar();
  });
});

describe("0659 · isolamento entre tenants", () => {
  it("admin da org B NÃO vê, NÃO altera e NÃO cria sessão com o organization_id da org A", () => {
    seed();
    limpar();
    inserir(ORG_A);

    expect(
      countAs(ADMIN_B, `select count(*) from public.channel_sessions where organization_id = '${ORG_A}';`),
    ).toBe(0);
    expect(
      writeCountAs(
        ADMIN_B,
        `update public.channel_sessions set status = 'FAILED' where organization_id = '${ORG_A}'`,
      ),
    ).toBe(0);
    // o lado `with check`: escrever na org A estando logado na B
    expect(
      writeCountAs(
        ADMIN_B,
        `insert into public.channel_sessions (organization_id, webhook_secret_encrypted, provider,
           uazapi_instance_id, uazapi_server_url, uazapi_instance_token_encrypted)
         values ('${ORG_A}', '\\x00'::bytea, 'uazapi', 'invadida', '${SERVIDOR}', '\\x01'::bytea)`,
      ),
    ).toBe(0);
    // 0 sozinho não separa "foi barrado" de "foi gravado e o SELECT é que não vê"
    expect(sql(`select count(*) from public.channel_sessions where uazapi_instance_id = 'invadida'`)).toBe("0");
    expect(sql(`select status from public.channel_sessions where organization_id = '${ORG_A}'`)).not.toBe("FAILED");

    // e o dono continua enxergando a própria
    expect(
      countAs(ADMIN_A, `select count(*) from public.channel_sessions where organization_id = '${ORG_A}';`),
    ).toBe(1);
    limpar();
  });
});

describe("0659 · o apêndice do baseline cura o clone que já tem duplicata", () => {
  const MARCA = "-- ---- canal hospedado: instância única e ativa (migration 0659) ----";

  /**
   * O bloco EXTRAÍDO do arquivo, pela ÚLTIMA ocorrência do rótulo. O baseline é
   * dump + apêndice e é aplicado inteiro e em ordem: quem vale é o que está no
   * fim, e `grep` no arquivo inteiro mediria uma definição que o banco já não usa.
   */
  function apendice(): string {
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    const i = baseline.lastIndexOf(MARCA);
    if (i < 0) throw new Error("o rótulo do apêndice sumiu do baseline — o teste ficou cego");
    return baseline.slice(i);
  }

  it("o bloco existe, e vem DEPOIS de `archived_at` existir (senão o install quebra com 42703)", () => {
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    const bloco = baseline.lastIndexOf(MARCA);
    const coluna = baseline.indexOf("-- ---- channel_sessions.archived_at (migration 0106) ----");
    expect(bloco, "apêndice ausente").toBeGreaterThan(0);
    expect(coluna, "não achei a criação de archived_at").toBeGreaterThan(0);
    expect(bloco).toBeGreaterThan(coluna);
  });

  it("duplicata pré-existente: fica a mais ANTIGA (a que opera), a mais nova é renomeada, e a trava volta", () => {
    seed();
    limpar();
    sql(`
      drop index if exists public.channel_sessions_uazapi_instance_id_ativo_unique;
      drop index if exists public.channel_sessions_uazapi_org_ativo_unique;
    `);
    inserir(ORG_A, { created_at: `now() - interval '2 days'` });
    inserir(ORG_B, { created_at: `now() - interval '1 day'` });
    expect(
      sql(`select count(*) from public.channel_sessions where uazapi_instance_id = 'inst-a'
             and organization_id in ('${ORG_A}', '${ORG_B}')`),
    ).toBe("2");

    sql(apendice());

    const orgDaOriginal = sql(
      `select organization_id from public.channel_sessions where uazapi_instance_id = 'inst-a'`,
    );
    expect(orgDaOriginal).toBe(ORG_A); // a mais antiga manteve a instância
    const renomeada = sql(
      `select uazapi_instance_id from public.channel_sessions where organization_id = '${ORG_B}'`,
    );
    expect(renomeada).toMatch(/^inst-a-conflito-[0-9a-f-]{36}$/);
    expect(
      sql(`select count(*) from pg_indexes where schemaname = 'public'
             and indexname in ('channel_sessions_uazapi_instance_id_ativo_unique',
                               'channel_sessions_uazapi_org_ativo_unique')`),
    ).toBe("2");
    limpar();
  });

  it("re-aplicar o bloco é idempotente (é o que o update.sh faz, sem ON_ERROR_STOP)", () => {
    seed();
    limpar();
    inserir(ORG_A);
    expect(() => sql(apendice())).not.toThrow();
    expect(() => sql(apendice())).not.toThrow();
    expect(
      sql(`select uazapi_instance_id from public.channel_sessions where organization_id = '${ORG_A}'`),
    ).toBe("inst-a"); // sem duplicata, nada é renomeado
    limpar();
  });
});
