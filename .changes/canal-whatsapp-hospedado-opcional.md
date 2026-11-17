---
impacto: capacidade_nova
secao: adicionado
titulo: Conexão opcional com um número de WhatsApp hospedado na uazapi
---

Quem administra o servidor pode ligar, em Administração › Sistema, o módulo "WhatsApp hospedado (uazapi)", que vem desligado. Ligado, cada empresa ganha em Conexões uma aba para conectar um número por uma instância já criada no painel da uazapi, sem contêiner do WhatsApp no servidor. A empresa cola a URL do servidor e o token da instância: os dois são validados antes de salvar e o token fica cifrado, só dela. Depois é possível parear por QR ou por código, ver o estado da conexão, desconectar, trocar o token (inclusive por outra instância, quando a anterior expirou) e remover a conexão. Remover não apaga a instância no painel da uazapi, e um webhook que a empresa já tinha naquela instância para outra ferramenta continua lá.

Mensagens de texto, mídia, contato e localização chegam e saem pelas mesmas regras de ritmo, janela e aviso dos outros canais. A resposta dada pelo celular entra na conversa do cliente certo e pausa a IA, como no número conectado por QR. Edições feitas pelo cliente atualizam a mensagem original, reações aparecem sobre a mensagem reagida e podem ser enviadas pelo Inbox, e quando o cliente apaga uma mensagem para todos ela continua no histórico, marcada como apagada. Grupos funcionam como no número por QR: nenhum grupo entra até ser ligado em Conexões › Grupos, e a IA só responde num grupo em que isso foi ligado. Entregue e lido aparecem uma vez só e nunca voltam atrás.

Se o WhatsApp limitar temporariamente o número, a mensagem fica na fila com um aviso na Central e não é reenviada sozinha; se o servidor pedir para esperar, o reenvio respeita o prazo. Se o número já estiver ativo em outro canal da empresa, a tela avisa em vez de falhar em silêncio. Enquanto o agente prepara a resposta, o cliente vê "digitando…".

As demais conexões não mudam e nenhuma variável nova é obrigatória. Desligar o módulo esconde a aba e impede conexões novas; uma conexão já feita segue atendendo até a empresa removê-la. Uma sessão parada não é religada sozinha: continua exigindo alguém na Central.
