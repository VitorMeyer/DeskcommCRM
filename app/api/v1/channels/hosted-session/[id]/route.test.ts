/**
 * A rota de ESTADO e AÇÕES da conexão hospedada, no caso que o primeiro teste
 * vivo revelou: o servidor passou a recusar o token gravado (a instância gratuita
 * expirou cerca de 1 h depois de criada).
 *
 * Com o token morto, a tela consultava o estado a cada 5 s e colecionava 502;
 * desconectar falhava, e a troca de instância — que exige o número desconectado
 * — ficava presa junto. O que estes casos prendem: credencial recusada é estado
 * dito, não erro; desconectar não depende dela; e excluir não é ação daqui.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { sincronizarEstadoDaSessaoPareada } from "@/lib/channels/estado-da-sessao-pareada";
import { CredencialRecusadaError } from "@/lib/channels/credencial-recusada";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: vi.fn(async () => false) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/channels/estado-da-sessao-pareada", () => ({
  sincronizarEstadoDaSessaoPareada: vi.fn(async () => ({ phoneConflict: false })),
}));

const sessao = { connect: vi.fn(), getStatus: vi.fn(), disconnect: vi.fn() };
vi.mock("@/lib/channels", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/channels");
  return { ...real, getAdapter: () => ({ sessao }) };
});

const ORG = "22222222-2222-4222-8222-222222222222";
const ID = "44444444-4444-4444-8444-444444444444";

const LINHA = {
  id: ID,
  organization_id: ORG,
  provider: "uazapi",
  uazapi_instance_id: "inst-1",
  status: "WORKING",
  display_name: null,
  phone_number: "5531999998888",
  archived_at: null,
};

function banco(linha: Record<string, unknown> | null = LINHA) {
  const consulta: Record<string, unknown> = {
    eq: () => consulta,
    maybeSingle: async () => ({ data: linha, error: null }),
  };
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => ({ select: () => consulta }),
  } as never);
}

const ctx = { params: Promise.resolve({ id: ID }) };
const URL_ROTA = `http://localhost/api/v1/channels/hosted-session/${ID}`;
const post = (corpo: unknown) =>
  new NextRequest(URL_ROTA, { method: "POST", body: JSON.stringify(corpo) });
const estadoGravado = () =>
  vi.mocked(sincronizarEstadoDaSessaoPareada).mock.calls.map(([, , estado]) => estado.status);

beforeEach(() => {
  vi.clearAllMocks();
  banco();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u-1", idioma: "pt-BR" },
    org: { orgId: ORG, name: "Org", role: "admin" },
  } as never);
});

describe("GET — estado da conexão", () => {
  it("⭐ token recusado é ESTADO dito (200), não 502 a cada consulta, e o banco fica FAILED", async () => {
    sessao.getStatus.mockRejectedValue(new CredencialRecusadaError("Invalid token"));
    const { GET } = await import("./route");
    const res = await GET(new NextRequest(URL_ROTA), ctx);

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      status: "FAILED",
      credential_rejected: true,
      qrCode: null,
    });
    expect(estadoGravado()).toEqual(["FAILED"]);
  });

  it("outra falha do servidor continua sendo 502 — só a credencial ganhou nome", async () => {
    sessao.getStatus.mockRejectedValue(new Error("uazapi_500: boom"));
    const { GET } = await import("./route");
    expect((await GET(new NextRequest(URL_ROTA), ctx)).status).toBe(502);
    expect(estadoGravado()).toEqual([]);
  });
});

describe("POST — ações", () => {
  it("⭐ desconectar com o token morto desconecta aqui: STOPPED, e a auditoria diz por quê", async () => {
    sessao.disconnect.mockRejectedValue(new CredencialRecusadaError("Invalid token"));
    const { POST } = await import("./route");
    const res = await POST(post({ action: "disconnect" }), ctx);

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ status: "STOPPED", credential_rejected: true });
    expect(estadoGravado()).toEqual(["STOPPED"]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.disconnected",
        metadata: { remoto: "credencial_recusada" },
      }),
    );
  });

  it("gerar QR com o token morto → 422 que diz o que fazer, e o banco fica FAILED", async () => {
    sessao.connect.mockRejectedValue(new CredencialRecusadaError("Invalid token"));
    const { POST } = await import("./route");
    const res = await POST(post({ action: "connect" }), ctx);

    expect(res.status).toBe(422);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("credential_rejected");
    expect(corpo.error.message).toMatch(/Cole o token de uma instância válida/);
    expect(estadoGravado()).toEqual(["FAILED"]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("excluir não é ação desta rota: é a exclusão comum da Central", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ action: "delete" }), ctx);

    expect(res.status).toBe(422);
    expect(sessao.disconnect).not.toHaveBeenCalled();
    expect(estadoGravado()).toEqual([]);
  });
});
