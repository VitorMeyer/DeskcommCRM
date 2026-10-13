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
const MIGRATION = "supabase/migrations/20261014100000_0659_canal_uazapi.sql";

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

    expect(readFileSync("supabase/migrations/MANIFEST.md", "utf8")).toContain(
      "`0659_canal_uazapi`",
    );
  });
});
