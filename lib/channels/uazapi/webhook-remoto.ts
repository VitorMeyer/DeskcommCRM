/**
 * O webhook DESTA instalação dentro da instância hospedada — e só ele.
 *
 * ─── Por que não o "modo simples" ──────────────────────────────────────────
 *
 * `POST /webhook` sem `action` gerencia "o" webhook da instância: cria ou
 * SOBRESCREVE o único que ela tem. Quem já tinha uma automação apontada para lá
 * (o cliente cria a instância no painel do serviço e costuma ligar outras
 * ferramentas nela) a perdia em silêncio no instante em que conectava o CRM. A
 * instância aceita vários webhooks (`action: add | update | delete`, com `id`),
 * então o CRM acha o PRÓPRIO pela URL e mexe só nele.
 *
 * ─── Qual é o nosso ────────────────────────────────────────────────────────
 *
 * O da URL exata desta conexão (`/api/v1/webhooks/channel/<token do caminho>`).
 * Ao registrar, conta também como nosso o que tem a MESMA origem e a mesma rota
 * com outro token: é o que sobrou de uma conexão anterior desta instalação (o
 * token do caminho gira quando a conexão é removida), e ele passa a apontar para
 * a URL nova em vez de virar um segundo webhook entregando para um 404. Webhook
 * de outra origem nunca é tocado — nem o de outra instalação do CRM.
 *
 * ─── O filtro de grupos ────────────────────────────────────────────────────
 *
 * `excludeMessages: ["isGroupYes"]` corta mensagem de grupo NA ORIGEM: sem
 * nenhum grupo ligado em Conexões › Grupos, o servidor nem as entrega. É a mesma
 * régua do canal por QR (um grupo ligado = a sessão recebe grupos), e a entrada
 * ainda confere grupo a grupo (`gravarMensagemDeGrupo`), então o filtro é
 * economia e defesa em profundidade, não a única barreira.
 */
import type { RequisitarUazapi } from "./http";

export const ROTA_DE_ENTRADA = "/api/v1/webhooks/channel/";

/** Sem `presence`: cada "digitando…" viraria uma linha no arquivo de webhooks, para um evento que o CRM ignora. */
export const EVENTOS_ASSINADOS = ["messages", "messages_update", "connection"] as const;

const SEM_ECO_DA_API = "wasSentByApi";
const SEM_GRUPO = "isGroupYes";

export interface WebhookRemoto {
  id?: string;
  enabled?: boolean;
  url?: string;
  events?: string[];
  excludeMessages?: string[];
  addUrlEvents?: boolean;
  addUrlTypesMessages?: boolean;
}

/** Os filtros de mensagem que o CRM quer na instância. O eco da API sai sempre: sem ele, cada envio voltaria como mensagem nova. */
export function filtrosDeMensagem(receberGrupos: boolean): string[] {
  return receberGrupos ? [SEM_ECO_DA_API] : [SEM_ECO_DA_API, SEM_GRUPO];
}

function mesmoConjunto(a: readonly string[] | undefined, b: readonly string[]): boolean {
  const x = new Set(a ?? []);
  return x.size === b.length && b.every((v) => x.has(v));
}

function origemDe(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function ehDestaInstalacao(webhook: WebhookRemoto, urlNossa: string): boolean {
  if (!webhook.url) return false;
  if (webhook.url === urlNossa) return true;
  const origem = origemDe(urlNossa);
  return origem !== null && origemDe(webhook.url) === origem && webhook.url.includes(ROTA_DE_ENTRADA);
}

export async function lerWebhooks(requisitar: RequisitarUazapi): Promise<WebhookRemoto[]> {
  const { response, body } = await requisitar("/webhook");
  if (!response.ok) throw new Error(`uazapi_webhook_list_${response.status}`);
  return Array.isArray(body) ? (body as WebhookRemoto[]) : [];
}

function corpoDoNosso(url: string, receberGrupos: boolean): Required<Omit<WebhookRemoto, "id">> {
  return {
    enabled: true,
    url,
    events: [...EVENTOS_ASSINADOS],
    excludeMessages: filtrosDeMensagem(receberGrupos),
    addUrlEvents: false,
    addUrlTypesMessages: false,
  };
}

async function postar(requisitar: RequisitarUazapi, corpo: Record<string, unknown>): Promise<boolean> {
  const { response } = await requisitar("/webhook", { method: "POST", body: JSON.stringify(corpo) });
  return response.ok;
}

/**
 * Registra (ou reaponta) o webhook desta conexão. `true` só quando o servidor
 * aceitou a escrita do nosso; a limpeza dos que sobraram é best-effort.
 */
export async function registrarWebhookDaConexao(
  requisitar: RequisitarUazapi,
  input: { url: string; receberGrupos: boolean },
): Promise<boolean> {
  const existentes = await lerWebhooks(requisitar);
  const nossos = existentes.filter((w) => ehDestaInstalacao(w, input.url));
  // O de URL exata primeiro: é ele que fica, e os outros nossos saem.
  nossos.sort((a, b) => Number(b.url === input.url) - Number(a.url === input.url));
  const [principal, ...sobras] = nossos;
  const corpo = corpoDoNosso(input.url, input.receberGrupos);

  const gravou = principal?.id
    ? await postar(requisitar, { action: "update", id: principal.id, ...corpo })
    : await postar(requisitar, { action: "add", ...corpo });
  if (!gravou) return false;

  for (const sobra of sobras) {
    if (!sobra.id) continue;
    await postar(requisitar, { action: "delete", id: sobra.id }).catch(() => false);
  }
  return true;
}

/** O caminho de entrada desta conexão — é por ele que o webhook é reconhecido sem saber o domínio. */
export function caminhoDaConexao(webhookPathToken: string): string {
  return `${ROTA_DE_ENTRADA}${webhookPathToken}`;
}

function apontaPara(webhook: WebhookRemoto, caminho: string): boolean {
  if (!webhook.url) return false;
  try {
    return new URL(webhook.url).pathname === caminho;
  } catch {
    return false;
  }
}

/**
 * Liga ou desliga o recebimento de grupos no webhook desta conexão.
 *
 * Lê antes e só escreve quando difere; depois lê de novo e só devolve `true` com
 * a troca CONFIRMADA — o contrato de `setGroupIntake`. Sem o nosso webhook na
 * instância não há o que trocar: `false`, e quem chama não liga nada.
 *
 * Reconhece pelo CAMINHO (`caminhoDaConexao`) e mantém a URL que já está lá: o
 * adapter não tem a requisição em mãos para saber o domínio público, e não
 * precisa — quem o gravou foi a conexão.
 */
export async function definirRecebimentoDeGrupos(
  requisitar: RequisitarUazapi,
  input: { caminho: string; receber: boolean },
): Promise<boolean> {
  const desejado = filtrosDeMensagem(input.receber);
  const achar = (lista: WebhookRemoto[]) => lista.find((w) => apontaPara(w, input.caminho));

  const nosso = achar(await lerWebhooks(requisitar));
  if (!nosso?.id || !nosso.url) return false;
  if (mesmoConjunto(nosso.excludeMessages, desejado)) return true;

  // Só `excludeMessages` muda: eventos e estado ficam como estão.
  const gravou = await postar(requisitar, {
    action: "update",
    id: nosso.id,
    ...corpoDoNosso(nosso.url, input.receber),
    events: nosso.events?.length ? nosso.events : [...EVENTOS_ASSINADOS],
    enabled: nosso.enabled ?? true,
  });
  if (!gravou) return false;

  const confirmado = achar(await lerWebhooks(requisitar));
  return mesmoConjunto(confirmado?.excludeMessages, desejado);
}

/** Tira o webhook desta conexão da instância (exclusão do canal). Best-effort: `false` sem lançar. */
export async function removerWebhookDaConexao(
  requisitar: RequisitarUazapi,
  caminho: string,
): Promise<boolean> {
  try {
    const nosso = (await lerWebhooks(requisitar)).find((w) => apontaPara(w, caminho));
    if (!nosso?.id) return true;
    return await postar(requisitar, { action: "delete", id: nosso.id });
  } catch {
    return false;
  }
}
