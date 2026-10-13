import { describe, expect, it } from "vitest";

import { abrirArquivoDoWebhook } from "@/lib/channels/arquivo-de-webhook";
import { corpoSeguroParaArquivoWebhook } from "@/lib/channels/inbound";

/**
 * O TOKEN DA INSTÂNCIA NÃO FICA NO ARQUIVO DE WEBHOOKS.
 *
 * Este canal não assina o corpo: a credencial viaja em claro dentro do evento
 * (o objeto `instance` do evento de conexão a carrega) e o arquivo guarda o
 * corpo cru para reprocessar. O token abre a instância inteira — enviar, apagar,
 * desconectar —, então quem lê `webhook_events_log` não pode encontrá-lo lá.
 */
const TOKEN = "tok-secreto-da-instancia-0123456789";

const evento = {
  BaseUrl: "https://example.invalid",
  EventType: "connection",
  token: TOKEN,
  instance: { name: "spike", status: "connected", token: TOKEN, admintoken: "adm-secreto" },
  lista: [{ token: TOKEN, ok: 1 }],
};

describe("corpo seguro para o arquivo", () => {
  it("remove token, admintoken e afins em qualquer profundidade, inclusive em listas", () => {
    const seguro = corpoSeguroParaArquivoWebhook("uazapi", JSON.stringify(evento));
    expect(seguro).not.toContain(TOKEN);
    expect(seguro).not.toContain("adm-secreto");
    expect(JSON.parse(seguro)).toEqual({
      BaseUrl: "https://example.invalid",
      EventType: "connection",
      instance: { name: "spike", status: "connected" },
      lista: [{ ok: 1 }],
    });
  });

  it("não mexe no conteúdo: só as CHAVES de segredo saem, o texto do cliente fica", () => {
    const corpo = JSON.stringify({
      EventType: "messages",
      message: { messageid: "M1", text: "meu token de acesso é 123", content: "mensagem de teste" },
    });
    expect(JSON.parse(corpoSeguroParaArquivoWebhook("uazapi", corpo))).toEqual(JSON.parse(corpo));
  });

  it("corpo que NÃO é JSON também perde o token — 'não consegui ler' não vira 'gravei como veio'", () => {
    const quebrado = `{"EventType":"connection","token":"${TOKEN}", "admintoken" : "adm-secreto", oops`;
    const seguro = corpoSeguroParaArquivoWebhook("uazapi", quebrado);
    expect(seguro).not.toContain(TOKEN);
    expect(seguro).not.toContain("adm-secreto");
    // o resto continua ali: é justamente o caso que o arquivo quer guardar
    expect(seguro).toContain("EventType");
    expect(seguro).toContain("oops");
  });

  it("outros canais passam byte a byte — a regra é deste transporte, não do arquivo", () => {
    const corpo = JSON.stringify(evento);
    expect(corpoSeguroParaArquivoWebhook("zernio", corpo)).toBe(corpo);
    expect(corpoSeguroParaArquivoWebhook("datafy", corpo)).toBe(corpo);
  });
});

describe("o que a linha do arquivo recebe", () => {
  function adminQueCaptura() {
    const inseridos: Record<string, unknown>[] = [];
    const admin = {
      from: () => ({
        insert: (linha: Record<string, unknown>) => {
          inseridos.push(linha);
          return { select: () => ({ maybeSingle: async () => ({ data: { id: "log-1" }, error: null }) }) };
        },
      }),
    } as never;
    return { admin, inseridos };
  }

  it("`raw_body` e `payload_parsed` saem sem o token, e os cabeçalhos de credencial nem entram", async () => {
    const { admin, inseridos } = adminQueCaptura();
    const headers = new Headers({ token: TOKEN, admintoken: "adm-secreto", "content-type": "application/json" });

    await abrirArquivoDoWebhook(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      provider: "uazapi",
      rawBody: corpoSeguroParaArquivoWebhook("uazapi", JSON.stringify(evento)),
      headers,
    });

    const linha = inseridos[0]!;
    expect(JSON.stringify(linha)).not.toContain(TOKEN);
    expect(JSON.stringify(linha)).not.toContain("adm-secreto");
    expect(linha.headers).toEqual({ "content-type": "application/json" });
    expect(linha.payload_parsed).toMatchObject({ EventType: "connection" });
  });
});
