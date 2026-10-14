/**
 * O transporte recusou a credencial gravada para a sessão (401/403): a instância
 * expirou, foi apagada no painel do serviço ou teve o token trocado por lá.
 *
 * É um desfecho com nome, e não um erro qualquer, porque muda o que a tela pode
 * oferecer. Com a credencial morta não há QR, código nem desconexão remota a
 * pedir, e quem opera precisa ouvir "troque o token ou remova a conexão" — não
 * um 502 a cada consulta de estado.
 *
 * Nasceu do primeiro teste vivo do canal hospedado (2026-10-14): a instância
 * gratuita expirou cerca de 1 h depois de criada, e REMOVER e TROCAR O TOKEN
 * dependiam, os dois, do token que tinha morrido. Nenhum dos dois pode depender.
 */
export class CredencialRecusadaError extends Error {
  constructor(detalhe: string) {
    super(`credencial_recusada: ${detalhe}`);
    this.name = "CredencialRecusadaError";
  }
}
