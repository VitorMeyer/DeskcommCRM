import { describe, expect, it, vi } from "vitest";

import { registrarAvisoDeEnvioAdiado } from "@/lib/channels/registrar-aviso-envio-adiado";
import type { SupabaseClient } from "@supabase/supabase-js";

function adminComAviso(existente: { id: string } | null) {
  const insert = vi.fn().mockResolvedValue({ error: null });
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    maybeSingle: vi.fn().mockResolvedValue({ data: existente, error: null }),
    insert,
  };
  return {
    client: { from: vi.fn(() => builder) } as unknown as SupabaseClient,
    builder,
    insert,
  };
}

const INPUT = {
  organizationId: "org-a",
  channelSessionId: "session-a",
  aviso: {
    kind: "channel_number_alert" as const,
    severity: "warn" as const,
    title: "Envio temporariamente limitado",
    body: "Revise a situação do número.",
  },
};

describe("registrarAvisoDeEnvioAdiado", () => {
  it("cria aviso da Central escopado à organização e conexão", async () => {
    const admin = adminComAviso(null);

    await expect(registrarAvisoDeEnvioAdiado(admin.client, INPUT)).resolves.toBe("criado");

    expect(admin.builder.eq.mock.calls).toEqual([
      ["organization_id", "org-a"],
      ["kind", "channel_number_alert"],
      ["title", "Envio temporariamente limitado"],
      ["ref_kind", "channel_session"],
      ["ref_id", "session-a"],
      ["status", "open"],
    ]);
    expect(admin.insert).toHaveBeenCalledWith({
      organization_id: "org-a",
      kind: "channel_number_alert",
      severity: "warn",
      title: "Envio temporariamente limitado",
      body: "Revise a situação do número.",
      ref_kind: "channel_session",
      ref_id: "session-a",
    });
  });

  it("não duplica um aviso já aberto para a conexão", async () => {
    const admin = adminComAviso({ id: "notice-a" });

    await expect(registrarAvisoDeEnvioAdiado(admin.client, INPUT)).resolves.toBe("ja_aberto");
    expect(admin.insert).not.toHaveBeenCalled();
  });
});
