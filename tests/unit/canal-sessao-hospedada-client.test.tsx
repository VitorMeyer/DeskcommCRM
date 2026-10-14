import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A TELA DE CONEXÃO DA SESSÃO HOSPEDADA: O QUE QUEM OPERA VÊ EM CADA ESTADO.
 *
 * ⚠️ Isto é comportamento do componente em jsdom, com o `apiClient` simulado —
 * NÃO é a prova pela tela que a doutrina de QA visual pede (navegador real,
 * banco fresco do baseline, envs opcionais ausentes). Ela prende a lógica que
 * decide o que aparece: quando o botão habilita, qual ação existe em cada
 * estado, que o token nunca é exibido nem fica no campo depois de salvar, e que
 * o conflito de número é dito em vez de engolido.
 */
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/connections/ChannelAiAccess", () => ({ ChannelAiAccess: () => null }));
// O diálogo de exclusão é o COMUM da Central (preflight + DELETE da rota de
// canais); aqui só importa que esta aba o abre com a conexão certa e reage ao fim.
vi.mock("@/components/connections/ConnectionsClient", () => ({
  ExcluirCanalDialog: (p: {
    canal: { id: string };
    onCancel: () => void;
    onDeleted: () => void;
  }) => (
    <div role="dialog" data-canal={p.canal.id}>
      <button onClick={p.onCancel}>Cancelar</button>
      <button onClick={p.onDeleted}>Confirmar exclusão</button>
    </div>
  ),
}));
vi.mock("@/components/connections/PairingOptions", () => ({
  PairingOptions: (p: { sessionId: string; pairingCodeUrl?: string; qr: React.ReactNode }) => (
    <div data-testid="pairing" data-session={p.sessionId} data-url={p.pairingCodeUrl}>
      {p.qr}
    </div>
  ),
}));

import { CanalSessaoHospedadaClient } from "@/components/connections/CanalSessaoHospedadaClient";
import { apiClient } from "@/lib/api/client";

const ROTA = "/api/v1/channels/hosted-session";
const ID = "11111111-1111-4111-8111-111111111111";

const sessao = (extra: Record<string, unknown> = {}) => ({
  id: ID,
  instanceId: "inst-1",
  serverUrl: "https://servidor.example.test",
  phoneNumber: null,
  displayName: null,
  status: "STOPPED",
  hasToken: true,
  webhookUrl: "https://crm.example.test/api/v1/webhooks/channel/x",
  archivedAt: null,
  ...extra,
});

/** Roteia o GET do apiClient: a sessão e, depois, o estado do pareamento. */
function api(session: Record<string, unknown> | null, estado: Record<string, unknown> = {}) {
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    if (url === ROTA) return { data: { session } } as never;
    return {
      data: {
        status: session?.status ?? "STOPPED",
        qrCode: null,
        pairingCode: null,
        phoneNumber: null,
        displayName: null,
        ...estado,
      },
    } as never;
  });
}

function montar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CanalSessaoHospedadaClient label="Serviço" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.post).mockReset();
});

describe("sem conexão", () => {
  it("o botão só habilita com URL E token, e o token é um campo de senha", async () => {
    api(null);
    montar();
    const botao = await screen.findByRole("button", { name: "Validar e conectar" });
    expect(botao).toBeDisabled();

    const token = screen.getByLabelText("Token da instância");
    expect(token).toHaveAttribute("type", "password"); // nunca exibido
    await userEvent.type(screen.getByLabelText("URL do servidor"), "https://servidor.example.test");
    expect(botao).toBeDisabled(); // só a URL não basta
    await userEvent.type(token, "segredo");
    expect(botao).toBeEnabled();
  });

  it("não oferece ação de uma conexão que não existe", async () => {
    api(null);
    montar();
    await screen.findByRole("button", { name: "Validar e conectar" });
    for (const nome of ["Gerar QR Code", "Desconectar", "Remover conexão", "Trocar token"]) {
      expect(screen.queryByRole("button", { name: nome })).toBeNull();
    }
    expect(screen.queryByTestId("pairing")).toBeNull();
  });

  it("conecta com URL e token e limpa o campo do token — ele não fica na tela", async () => {
    api(null);
    vi.mocked(apiClient.post).mockResolvedValue({ data: { session: sessao() } } as never);
    montar();
    await userEvent.type(await screen.findByLabelText("URL do servidor"), "https://servidor.example.test");
    await userEvent.type(screen.getByLabelText("Token da instância"), "segredo");
    await userEvent.click(screen.getByRole("button", { name: "Validar e conectar" }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith(ROTA, {
        server_url: "https://servidor.example.test",
        token: "segredo",
      }),
    );
    await waitFor(() => expect(screen.getByLabelText("Token da instância")).toHaveValue(""));
  });
});

describe("com conexão parada", () => {
  it("mostra que ainda não há número, oferece QR/remover, e diz que o token já está gravado", async () => {
    api(sessao());
    montar();
    expect(await screen.findByText("Número ainda não pareado")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gerar QR Code" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remover conexão" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Trocar token" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Desconectar" })).toBeNull();
    expect(screen.getByPlaceholderText("Cole o token novo para trocar")).toBeInTheDocument();
  });

  it("o pareamento por código usa a rota DESTA sessão, não a do outro transporte", async () => {
    api(sessao());
    montar();
    const pareamento = await screen.findByTestId("pairing");
    expect(pareamento).toHaveAttribute("data-session", ID);
    expect(pareamento).toHaveAttribute("data-url", `${ROTA}/${ID}`);
  });

  it("gerar QR chama a ação `connect` da sessão", async () => {
    api(sessao());
    vi.mocked(apiClient.post).mockResolvedValue({ data: {} } as never);
    montar();
    await userEvent.click(await screen.findByRole("button", { name: "Gerar QR Code" }));
    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith(`${ROTA}/${ID}`, { action: "connect" }),
    );
  });

  it("sem QR, diz o que fazer; com QR, mostra a imagem (base64 vira data URL)", async () => {
    api(sessao());
    const { unmount } = montar();
    expect(await screen.findByText("Gere o QR Code para iniciar o pareamento.")).toBeInTheDocument();
    unmount();

    api(sessao(), { status: "SCAN_QR_CODE", qrCode: "QUJD" });
    montar();
    const img = await screen.findByAltText("QR Code para conectar o WhatsApp");
    expect(img.getAttribute("src")).toContain("data:image/png;base64,QUJD");
  });
});

describe("com conexão de pé", () => {
  it("troca 'Gerar QR Code' por 'Desconectar' e some o pareamento", async () => {
    api(sessao({ status: "WORKING", phoneNumber: "5531999998888" }));
    montar();
    expect(await screen.findByRole("button", { name: "Desconectar" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Gerar QR Code" })).toBeNull();
    expect(screen.queryByTestId("pairing")).toBeNull();
    // o número aparece como nome do canal e na linha de baixo
    expect(screen.getAllByText("5531999998888").length).toBeGreaterThanOrEqual(1);
  });

  it("desconectar chama a ação `disconnect`", async () => {
    api(sessao({ status: "WORKING", phoneNumber: "5531999998888" }));
    vi.mocked(apiClient.post).mockResolvedValue({ data: {} } as never);
    montar();
    await userEvent.click(await screen.findByRole("button", { name: "Desconectar" }));
    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith(`${ROTA}/${ID}`, { action: "disconnect" }),
    );
  });
});

describe("número já em uso por outro canal", () => {
  it("é dito em voz alta, e só quando há conflito", async () => {
    api(sessao({ status: "WORKING" }), { status: "WORKING", phone_number_conflict: true });
    const { unmount } = montar();
    const aviso = await screen.findByRole("alert");
    expect(aviso).toHaveTextContent(/já está conectado em outro canal ativo/);
    unmount();

    api(sessao({ status: "WORKING" }), { status: "WORKING", phone_number_conflict: false });
    montar();
    await screen.findByRole("button", { name: "Desconectar" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("trocar o token", () => {
  it("a URL gravada já vem no campo: trocar pede só o token novo", async () => {
    api(sessao({ status: "FAILED" }));
    vi.mocked(apiClient.post).mockResolvedValue({ data: { session: sessao() } } as never);
    montar();
    const url = await screen.findByLabelText("URL do servidor");
    await waitFor(() => expect(url).toHaveValue("https://servidor.example.test"));

    const botao = screen.getByRole("button", { name: "Trocar token" });
    expect(botao).toBeDisabled(); // sem token novo não há o que trocar
    await userEvent.type(screen.getByLabelText("Token da instância"), "token-novo");
    await userEvent.click(botao);
    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith(ROTA, {
        server_url: "https://servidor.example.test",
        token: "token-novo",
      }),
    );
  });

  it("a recusa do servidor fica escrita na tela, não só num aviso que some", async () => {
    api(sessao({ status: "WORKING", phoneNumber: "5531999998888" }));
    vi.mocked(apiClient.post).mockRejectedValue(
      new Error("O número atual está conectado. Desconecte-o antes de trocar de instância."),
    );
    montar();
    await userEvent.type(await screen.findByLabelText("Token da instância"), "outro");
    await userEvent.click(screen.getByRole("button", { name: "Trocar token" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Desconecte-o antes de trocar/);
  });
});

describe("token salvo recusado pelo servidor", () => {
  it("diz o que fazer, e não oferece QR nem pareamento com um token morto", async () => {
    api(sessao({ status: "FAILED" }), { status: "FAILED", credential_rejected: true });
    montar();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /recusou o token salvo.*trocar, ou remova a conexão/,
    );
    expect(screen.queryByRole("button", { name: "Gerar QR Code" })).toBeNull();
    expect(screen.queryByTestId("pairing")).toBeNull();
    // as duas saídas continuam ao alcance
    expect(screen.getByRole("button", { name: "Trocar token" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remover conexão" })).toBeEnabled();
  });
});

describe("remover a conexão", () => {
  it("abre o diálogo comum de exclusão para ESTA conexão, e nada é apagado sem confirmar", async () => {
    api(sessao({ status: "FAILED" }));
    montar();
    await userEvent.click(await screen.findByRole("button", { name: "Remover conexão" }));
    expect(screen.getByRole("dialog")).toHaveAttribute("data-canal", ID);
    expect(apiClient.post).not.toHaveBeenCalled(); // a rota desta aba não apaga mais nada

    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("excluída, a conexão sai da tela e o formulário volta a ser o de conectar", async () => {
    api(sessao({ status: "FAILED" }));
    montar();
    await userEvent.click(await screen.findByRole("button", { name: "Remover conexão" }));
    api(null); // o servidor já não devolve a conexão removida
    await userEvent.click(screen.getByRole("button", { name: "Confirmar exclusão" }));

    expect(await screen.findByRole("button", { name: "Validar e conectar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remover conexão" })).toBeNull();
    expect(screen.getByLabelText("URL do servidor")).toHaveValue("");
  });
});
