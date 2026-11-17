/**
 * A única porta HTTP do canal hospedado por instância.
 *
 * Toda chamada sai daqui com as mesmas três garantias: `redirect: "error"` (a
 * URL do servidor é entrada do tenant e um 3xx poderia levar o token para outra
 * origem), prazo de 15 s e o token no cabeçalho — nunca na URL.
 *
 * Quem chama já validou `serverUrl` contra SSRF (`validarUazapiServerUrl`): este
 * módulo não decide se o destino é seguro, só fala com ele.
 */
export interface DestinoUazapi {
  serverUrl: string;
  token: string;
}

export interface RespostaUazapi {
  response: Response;
  /** O JSON da resposta; `{}` quando o corpo não é JSON. Nunca lança por isso. */
  body: unknown;
}

export type RequisitarUazapi = (path: string, init?: RequestInit) => Promise<RespostaUazapi>;

export function enderecoDaApi(serverUrl: string, path: string): string {
  return `${serverUrl.replace(/\/+$/, "")}${path}`;
}

export async function requisitarUazapi(
  destino: DestinoUazapi,
  path: string,
  init: RequestInit = {},
): Promise<RespostaUazapi> {
  const response = await fetch(enderecoDaApi(destino.serverUrl, path), {
    ...init,
    redirect: "error",
    headers: {
      token: destino.token,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  const body: unknown = await response.json().catch(() => ({}));
  return { response, body };
}

/** A mesma porta, presa a um destino — o formato que os módulos de regra recebem. */
export function requisitarNo(destino: DestinoUazapi): RequisitarUazapi {
  return (path, init) => requisitarUazapi(destino, path, init);
}
