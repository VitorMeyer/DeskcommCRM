import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/automation/outbound-ip", () => ({
  assertDestinoResolvidoSeguro: vi.fn().mockResolvedValue(undefined),
}));

import { validarCredenciaisUazapi } from "@/lib/channels/uazapi/validate-credentials";

afterEach(() => vi.restoreAllMocks());

describe("validarCredenciaisUazapi", () => {
  it("não segue redirects com o token da instância e traduz registering como STARTING", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ instance: { id: "instance-1", status: "registering" } }),
        { status: 200 },
      ),
    );
    const result = await validarCredenciaisUazapi({
      serverUrl: "https://uazapi.example.test",
      token: "instance-secret",
    });
    expect(result).toMatchObject({ ok: true, status: "STARTING", instanceId: "instance-1" });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://uazapi.example.test/instance/status");
    expect(init?.redirect).toBe("error");
    expect((init?.headers as Record<string, string>).token).toBe("instance-secret");
  });

  it("recusa token ausente antes de abrir rede", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      validarCredenciaisUazapi({ serverUrl: "https://uazapi.example.test", token: " " }),
    ).resolves.toEqual({ ok: false, motivo: "Informe o token da instância." });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("instância já conectada: grava o número pela resposta REAL (`jid` em texto)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(readFileSync("tests/fixtures/uazapi/instance-status-connected.json", "utf8"), { status: 200 }),
    );
    await expect(
      validarCredenciaisUazapi({ serverUrl: "https://uazapi.example.test", token: "t" }),
    ).resolves.toMatchObject({ ok: true, status: "WORKING", phoneNumber: "5511900000001" });
  });

  it("instância ainda não pareada: o `owner` antigo não vira número da conexão", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ instance: { id: "i", status: "disconnected", owner: "5511900000001" }, status: { jid: null } }),
        { status: 200 },
      ),
    );
    await expect(
      validarCredenciaisUazapi({ serverUrl: "https://uazapi.example.test", token: "t" }),
    ).resolves.toMatchObject({ ok: true, status: "STOPPED", phoneNumber: null });
  });
});

