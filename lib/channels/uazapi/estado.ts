/**
 * O estado da instância, no vocabulário de `channel_sessions.status`.
 *
 * Um só lugar para a tabela de tradução: o webhook de conexão, a leitura de
 * status do adapter e a validação da credencial recebem o MESMO estado remoto,
 * e três cópias da tabela divergem na primeira vez que a API ganhar um estado.
 *
 * `hibernated` e `disconnected` viram `STOPPED` de propósito, e `FAILED` nunca é
 * inferido de um estado vivo: `FAILED` é o que o vigia de conexão trata como
 * "pode ser banimento, não religue sozinho".
 */
export type EstadoDoCanal = "WORKING" | "STOPPED" | "SCAN_QR_CODE" | "STARTING" | "FAILED";

/**
 * `null` = a API disse algo que este código não conhece. Quem chama decide: o
 * webhook recusa como violação de contrato; a leitura de status, que precisa
 * devolver ALGUM estado, assume `FAILED` (o conservador).
 *
 * `conectado` é o `status.loggedIn` que `GET /instance/status` devolve ao lado do
 * estado textual, e vale mais que ele. Não o `status.connected`: esse fica `true`
 * com o socket aberto durante o QR, antes de haver número autenticado.
 */
export function estadoDoCanalUazapi(
  remoto: unknown,
  conectado: boolean = false,
): EstadoDoCanal | null {
  const estado = typeof remoto === "string" ? remoto.trim().toLowerCase() : "";
  if (conectado || estado === "connected") return "WORKING";
  switch (estado) {
    case "connecting":
      return "SCAN_QR_CODE";
    case "registering":
      return "STARTING";
    case "disconnected":
    case "hibernated":
      return "STOPPED";
    case "registration_conflict":
      return "FAILED";
    default:
      return null;
  }
}

/**
 * O número do aparelho pareado, só em dígitos, lido da resposta de
 * `GET /instance/status`. `null` quando a resposta não traz um número.
 *
 * Três formas, nesta ordem, porque a API real e a especificação discordam:
 *   - `status.jid` em TEXTO, `"<número>:<aparelho>@s.whatsapp.net"` — o que o
 *     servidor real devolve (medido na instalação de teste, 2026-11-17);
 *   - `status.jid.user` — o objeto que a especificação v2.6.9 documenta;
 *   - `instance.owner` — o número limpo, presente nas duas respostas.
 * Ler só a forma documentada deixava a conexão "conectada" e sem número.
 *
 * Quem decide se o número VALE (só com a sessão conectada) é quem grava
 * (`numeroObservadoDaSessao`); aqui só se lê.
 */
export function numeroDaInstancia(body: unknown): string | null {
  const raiz = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const status = raiz.status && typeof raiz.status === "object" ? (raiz.status as Record<string, unknown>) : {};
  const instancia =
    raiz.instance && typeof raiz.instance === "object" ? (raiz.instance as Record<string, unknown>) : {};
  const jid = status.jid;
  const candidatos = [
    typeof jid === "string" ? jid : null,
    jid && typeof jid === "object" ? (jid as Record<string, unknown>).user : null,
    instancia.owner,
  ];
  for (const candidato of candidatos) {
    if (typeof candidato !== "string") continue;
    const digitos = candidato.replace(/[:@].*$/, "").replace(/\D/g, "");
    if (digitos.length >= 8 && digitos.length <= 15) return digitos;
  }
  return null;
}
