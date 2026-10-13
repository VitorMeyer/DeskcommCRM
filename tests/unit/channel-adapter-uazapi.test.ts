import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Credenciais from "@/lib/channels/uazapi/credentials";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/automation/outbound-ip", () => ({
  assertDestinoResolvidoSeguro: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/channels/uazapi/credentials", async (original) => ({
  ...(await original<typeof Credenciais>()),
  resolveUazapiCreds: vi.fn(),
}));

import { uazapiAdapter } from "@/lib/channels/adapters/uazapi";
import { resolveUazapiCreds } from "@/lib/channels/uazapi/credentials";
import type { OutboundEnvelope } from "@/lib/channels/types";

const CREDS = {
  channelSessionId: "sess-1",
  instanceId: "inst-1",
  serverUrl: "https://api.example.test/base",
  token: "token-somente-header",
};

function envelope(over: Partial<OutboundEnvelope> = {}): OutboundEnvelope {
  return {
    organizationId: "org-1",
    sessionRef: "inst-1",
    to: "5531999998888@s.whatsapp.net",
    kind: "text",
    body: "olá",
    ...over,
  };
}

const ORIGINAL = process.env.UAZAPI_ENABLED;
beforeEach(() => {
  process.env.UAZAPI_ENABLED = "true";
  vi.mocked(resolveUazapiCreds).mockReset();
  vi.mocked(resolveUazapiCreds).mockResolvedValue(CREDS);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL === undefined) delete process.env.UAZAPI_ENABLED;
  else process.env.UAZAPI_ENABLED = ORIGINAL;
});

describe("adapter uazapi", () => {
  it("preserva grupos e @lid, e usa o JID nativo para telefone", () => {
    const base = { groupChatId: null, waIdentity: null };
    expect(
      uazapiAdapter.resolveRecipient({
        ...base,
        isGroup: true,
        groupChatId: "123@g.us",
        phoneNumber: null,
      }),
    ).toBe("123@g.us");
    expect(
      uazapiAdapter.resolveRecipient({
        ...base,
        isGroup: false,
        waLid: "123456",
        phoneNumber: "+55 31 99999-8888",
      }),
    ).toBe("123456@lid");
    expect(
      uazapiAdapter.resolveRecipient({
        ...base,
        isGroup: false,
        phoneNumber: "+55 (31) 99999-8888",
      }),
    ).toBe("5531999998888@s.whatsapp.net");
  });

  it("envia texto com token no header, jamais na URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "553199998888:3AABC", messageid: "3AABC" }), {
        status: 200,
      }),
    );

    await expect(uazapiAdapter.send(envelope())).resolves.toEqual({ externalId: "3AABC" });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.example.test/base/send/text");
    expect(String(url)).not.toContain(CREDS.token);
    expect((init?.headers as Record<string, string>).token).toBe(CREDS.token);
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({
      number: "5531999998888@s.whatsapp.net",
      text: "olá",
    });
  });

  it("envia mídia e trata áudio como nota de voz", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ messageid: "3AMIDIA" }), { status: 200 }));
    await uazapiAdapter.send(
      envelope({
        kind: "audio",
        body: undefined,
        media: { url: "https://midia.example/a.ogg", mime: "audio/ogg" },
      }),
    );
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.example.test/base/send/media");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body))).toMatchObject({
      type: "ptt",
      file: "https://midia.example/a.ogg",
    });
  });

  it("envia pino com coordenadas para o endpoint de localização", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ messageid: "3ALOC" }), { status: 200 }));
    await uazapiAdapter.send(
      envelope({
        kind: "location",
        body: "📍 Praça da Sé — https://maps.google.com/?q=-23.55,-46.63",
        location: {
          latitude: -23.55,
          longitude: -46.63,
          nome: "Praça da Sé",
          endereco: "São Paulo",
        },
      }),
    );
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.example.test/base/send/location");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body))).toMatchObject({
      number: "5531999998888@s.whatsapp.net",
      latitude: -23.55,
      longitude: -46.63,
      name: "Praça da Sé",
      address: "São Paulo",
    });
  });

  it("mapeia status remoto e usa o endpoint de presença", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            instance: { status: "connecting", profileName: "Loja" },
            qrcode: "data:image/png;base64,x",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: "ok" }), { status: 200 }));

    await expect(
      uazapiAdapter.sessao!.getStatus({ organizationId: "org-1", sessionRef: "inst-1" }),
    ).resolves.toMatchObject({
      status: "SCAN_QR_CODE",
      qrCode: "data:image/png;base64,x",
    });
    await uazapiAdapter.signalTyping!({
      organizationId: "org-1",
      sessionRef: "inst-1",
      recipient: "55@s.whatsapp.net",
      inboundExternalId: null,
    });
    expect(String(fetchSpy.mock.calls[1]![0])).toBe(
      "https://api.example.test/base/message/presence",
    );
    // `delay` limita o "digitando…" se o turno morrer sem enviar: sem ele a API
    // mantém a presença por até 5 minutos.
    expect(JSON.parse(String(fetchSpy.mock.calls[1]![1]?.body))).toEqual({
      number: "55@s.whatsapp.net",
      presence: "composing",
      delay: 15_000,
    });
  });

  it("sem credencial ou com a integração desligada não tenta enviar", async () => {
    vi.mocked(resolveUazapiCreds).mockResolvedValue(null);
    await expect(uazapiAdapter.send(envelope())).rejects.toThrow(/^uazapi_not_configured/);

    process.env.UAZAPI_ENABLED = "";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(uazapiAdapter.send(envelope())).rejects.toThrow(/^uazapi_not_configured/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mantém timelock e rate-limit distinguíveis", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ provider_code: 463, error: "temporary restriction" }), {
        status: 500,
      }),
    );
    await expect(uazapiAdapter.send(envelope())).rejects.toThrow(/^uazapi_timelock/);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "slow down" }), {
        status: 429,
        headers: { "retry-after": "2" },
      }),
    );
    await expect(uazapiAdapter.send(envelope())).rejects.toThrow(/^uazapi_rate_limited:2000:/);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "slow down" }), { status: 429 }),
    );
    await expect(uazapiAdapter.send(envelope())).rejects.toThrow(/^uazapi_rate_limited::/);
    const limite = uazapiAdapter.deferredErrors?.find(
      (candidate) => candidate.queuedReason === "uazapi_rate_limited",
    );
    expect(limite?.retryAfterMs?.("uazapi_rate_limited:: limite excedido")).toBeNull();

    expect(uazapiAdapter.deferredErrors?.[0]).toMatchObject({
      queuedReason: "uazapi_timelock",
      retryStrategy: "manual",
      operatorNotice: { kind: "channel_number_alert", severity: "warn" },
    });
  });
});
