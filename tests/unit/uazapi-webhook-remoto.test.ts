import { describe, expect, it } from "vitest";

import type { RequisitarUazapi } from "@/lib/channels/uazapi/http";
import {
  caminhoDaConexao,
  definirRecebimentoDeGrupos,
  filtrosDeMensagem,
  registrarWebhookDaConexao,
  removerWebhookDaConexao,
  type WebhookRemoto,
} from "@/lib/channels/uazapi/webhook-remoto";

const NOSSA = "https://crm.exemplo.com/api/v1/webhooks/channel/tok-novo";
const ANTIGA = "https://crm.exemplo.com/api/v1/webhooks/channel/tok-velho";
const DO_CLIENTE = "https://automacao.exemplo.net/hook";
const OUTRO_CRM = "https://outro-crm.exemplo.org/api/v1/webhooks/channel/tok";
const CAMINHO = caminhoDaConexao("tok-novo");

/** Servidor falso: guarda os webhooks e aplica add/update/delete como a API documenta. */
function servidor(iniciais: WebhookRemoto[], opcoes: { recusaEscrita?: boolean; ignoraUpdate?: boolean } = {}) {
  let lista = iniciais.map((w) => ({ ...w }));
  let proximo = 1;
  const posts: Record<string, unknown>[] = [];
  const requisitar: RequisitarUazapi = async (path, init) => {
    expect(path).toBe("/webhook");
    if (!init?.method || init.method === "GET") {
      return { response: new Response(null, { status: 200 }), body: lista.map((w) => ({ ...w })) };
    }
    const corpo = JSON.parse(String(init.body)) as Record<string, unknown>;
    posts.push(corpo);
    if (opcoes.recusaEscrita) return { response: new Response(null, { status: 500 }), body: {} };
    const { action, id, ...resto } = corpo as unknown as { action: string; id?: string } & WebhookRemoto;
    if (action === "add") lista.push({ id: `novo-${proximo++}`, ...resto });
    if (action === "update" && !opcoes.ignoraUpdate) lista = lista.map((w) => (w.id === id ? { id, ...resto } : w));
    if (action === "delete") lista = lista.filter((w) => w.id !== id);
    return { response: new Response(null, { status: 200 }), body: lista };
  };
  return { requisitar, posts, lista: () => lista };
}

describe("registrar o webhook da conexão", () => {
  it("não apaga o webhook que o cliente já tinha na instância", async () => {
    const s = servidor([{ id: "cli", url: DO_CLIENTE, events: ["messages"], excludeMessages: [] }]);
    await expect(registrarWebhookDaConexao(s.requisitar, { url: NOSSA, receberGrupos: false })).resolves.toBe(true);
    expect(s.lista().map((w) => w.url).sort()).toEqual([NOSSA, DO_CLIENTE].sort());
    expect(s.posts[0]).toMatchObject({ action: "add", url: NOSSA });
  });

  it("sem grupo ligado, a instância nem entrega mensagem de grupo; o eco da API sai sempre", async () => {
    const s = servidor([]);
    await registrarWebhookDaConexao(s.requisitar, { url: NOSSA, receberGrupos: false });
    expect(s.lista()[0]!.excludeMessages).toEqual(["wasSentByApi", "isGroupYes"]);
    expect(filtrosDeMensagem(true)).toEqual(["wasSentByApi"]);
  });

  it("reaponta o webhook que sobrou de uma conexão anterior em vez de somar um segundo", async () => {
    const s = servidor([{ id: "velho", url: ANTIGA, events: ["messages"] }]);
    await registrarWebhookDaConexao(s.requisitar, { url: NOSSA, receberGrupos: false });
    expect(s.lista()).toHaveLength(1);
    expect(s.lista()[0]).toMatchObject({ id: "velho", url: NOSSA });
  });

  it("fica com o de URL exata e tira as sobras desta instalação, sem tocar em outro CRM", async () => {
    const s = servidor([
      { id: "velho", url: ANTIGA },
      { id: "atual", url: NOSSA },
      { id: "outro", url: OUTRO_CRM },
    ]);
    await registrarWebhookDaConexao(s.requisitar, { url: NOSSA, receberGrupos: true });
    expect(s.lista().map((w) => w.id).sort()).toEqual(["atual", "outro"]);
    expect(s.posts[0]).toMatchObject({ action: "update", id: "atual" });
  });

  it("escrita recusada pelo servidor = conexão não salva", async () => {
    const s = servidor([], { recusaEscrita: true });
    await expect(registrarWebhookDaConexao(s.requisitar, { url: NOSSA, receberGrupos: false })).resolves.toBe(false);
  });
});

describe("ligar e desligar o recebimento de grupos", () => {
  it("troca só o filtro do nosso webhook e confirma lendo de novo", async () => {
    const s = servidor([
      { id: "nosso", url: NOSSA, events: ["messages", "connection"], excludeMessages: ["wasSentByApi", "isGroupYes"] },
      { id: "cli", url: DO_CLIENTE, excludeMessages: ["isGroupYes"] },
    ]);
    await expect(definirRecebimentoDeGrupos(s.requisitar, { caminho: CAMINHO, receber: true })).resolves.toBe(true);
    const nosso = s.lista().find((w) => w.id === "nosso")!;
    expect(nosso.excludeMessages).toEqual(["wasSentByApi"]);
    expect(nosso.events).toEqual(["messages", "connection"]);
    expect(s.lista().find((w) => w.id === "cli")!.excludeMessages).toEqual(["isGroupYes"]);
  });

  it("já no estado pedido, não escreve nada", async () => {
    const s = servidor([{ id: "nosso", url: NOSSA, excludeMessages: ["isGroupYes", "wasSentByApi"] }]);
    await expect(definirRecebimentoDeGrupos(s.requisitar, { caminho: CAMINHO, receber: false })).resolves.toBe(true);
    expect(s.posts).toHaveLength(0);
  });

  it("sem o nosso webhook na instância, não confirma", async () => {
    const s = servidor([{ id: "cli", url: DO_CLIENTE }]);
    await expect(definirRecebimentoDeGrupos(s.requisitar, { caminho: CAMINHO, receber: true })).resolves.toBe(false);
  });

  it("servidor que aceita a escrita mas não aplica = não confirmado", async () => {
    const s = servidor([{ id: "nosso", url: NOSSA, excludeMessages: ["wasSentByApi", "isGroupYes"] }], { ignoraUpdate: true });
    await expect(definirRecebimentoDeGrupos(s.requisitar, { caminho: CAMINHO, receber: true })).resolves.toBe(false);
  });
});

describe("remover o webhook da conexão", () => {
  it("tira só o nosso", async () => {
    const s = servidor([{ id: "nosso", url: NOSSA }, { id: "cli", url: DO_CLIENTE }]);
    await expect(removerWebhookDaConexao(s.requisitar, CAMINHO)).resolves.toBe(true);
    expect(s.lista().map((w) => w.id)).toEqual(["cli"]);
  });

  it("não lança quando o servidor falha", async () => {
    const quebrado: RequisitarUazapi = async () => {
      throw new Error("rede");
    };
    await expect(removerWebhookDaConexao(quebrado, CAMINHO)).resolves.toBe(false);
  });
});
