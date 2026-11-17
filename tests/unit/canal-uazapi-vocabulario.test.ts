import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getAdapter } from "@/lib/channels";
import {
  CHANNEL_PROVIDER_UAZAPI,
  capabilitiesOf,
  transportaMensagem,
} from "@/lib/channels/capabilities";
import { channelBrand } from "@/lib/channels/presentation";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";
import { fonteDeTemplates } from "@/lib/channels/templates-fonte";

const UAZAPI = "uazapi" as const;
const MIGRATION = "supabase/migrations/20261117180233_9412_canal_uazapi.sql";

describe("canal uazapi — vocabulário e seam", () => {
  it("declara perfil de canal livre, com risco de banimento e grupos", () => {
    const caps = capabilitiesOf(CHANNEL_PROVIDER_UAZAPI);
    expect(caps.requiresTemplates).toBe(false);
    expect(caps.freeformOutsideWindow).toBe(true);
    expect(caps.banRisk).toBe(true);
    expect(caps.groups).toBe("full");
    expect(caps.voiceNote).toBe("server-convert");
    expect(caps.alteraMensagemEnviada).toBe(true);
    expect(fonteDeTemplates(UAZAPI)).toBeNull();
  });

  it("é canal de mensagem e se apresenta pela rede, não pela marca", () => {
    expect(transportaMensagem(UAZAPI)).toBe(true);
    expect(channelBrand({ provider: UAZAPI })).toBe("whatsapp");
  });

  it("usa a referência própria da instância", () => {
    expect(resolveSessionRef({ provider: UAZAPI, uazapi_instance_id: "inst-123" })).toBe(
      "inst-123",
    );
    expect(CHANNEL_SESSION_REF_COLUMNS).toContain("uazapi_instance_id");
  });

  it("registra adapter e a porta de sessão", () => {
    const adapter = getAdapter(UAZAPI);
    expect(adapter.provider).toBe(UAZAPI);
    expect(adapter.codes.notConfigured).toBe("uazapi_not_configured");
    expect(adapter.sessao).toBeDefined();
  });

  it("migration, baseline e manifest preservam a tripla do schema", () => {
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    expect(baseline).toMatch(/channel_sessions_provider_check[\s\S]{0,700}'uazapi'::text/);
    expect(baseline).toMatch(/provider = 'uazapi'\s+and uazapi_instance_id\s+is not null/);
    expect(baseline).toMatch(
      /webhook_events_log_provider_check check \(provider in \([^)]*'uazapi'/,
    );
    expect(baseline).toContain("channel_sessions_uazapi_instance_id_ativo_unique");
    expect(baseline.indexOf("add column if not exists uazapi_instance_id")).toBeLessThan(
      baseline.indexOf("(provider = 'uazapi'"),
    );

    const migration = readFileSync(MIGRATION, "utf8");
    expect(migration).toContain("add column if not exists uazapi_instance_id");
    expect(migration).toMatch(/provider = 'uazapi' and uazapi_instance_id is not null/);
    expect(migration).toContain("'uazapi'");
    // A migration se descreve no PRÓPRIO cabeçalho; o MANIFEST.md é histórico e
    // não recebe linha nova (`tests/unit/manifest-x-migrations.test.ts`).
    expect(migration.split("\n")[0]).toMatch(/^-- manifest: /);
    expect(readFileSync("supabase/migrations/MANIFEST.md", "utf8")).not.toContain("_canal_uazapi`");
  });

  it("a migration reescreve os CHECKs com a lista INTEIRA — não apaga quem veio antes", () => {
    const migration = readFileSync(MIGRATION, "utf8");
    // Um drop+add com a lista antiga, rodando depois da 9342, tiraria o robô do vocabulário.
    expect(migration).toMatch(/channel_sessions_provider_check[\s\S]{0,400}'telegram'/);
    expect(migration).toMatch(/provider = 'telegram' and telegram_bot_id is not null/);
    expect(migration).toMatch(/webhook_events_log_provider_check check \(provider in \([\s\S]*'telegram'/);
    expect(migration).toMatch(/'stripe', 'asaas'/);
  });
});
