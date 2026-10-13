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
 * `conectado` é o booleano `status.connected`/`loggedIn` que `GET /instance/status`
 * devolve ao lado do estado textual, e vale mais que ele.
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
