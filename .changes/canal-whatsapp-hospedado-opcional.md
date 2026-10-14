---
impacto: capacidade_nova
secao: adicionado
titulo: Conexão opcional com uma sessão WhatsApp hospedada por instância
---

A Central de Conexões passa a oferecer, quando a instalação a liga (`UAZAPI_ENABLED=true`, desligada por padrão), a conexão com uma sessão WhatsApp hospedada já criada no painel do serviço. Cada empresa cola a URL do servidor e o token da instância: os dois são validados antes de salvar e o token fica cifrado, só dela. Depois é possível parear por QR ou por código, ver o estado da conexão, desconectar, trocar o token (inclusive por outra instância, quando a anterior expirou) e remover a conexão — remover não apaga a instância no painel do serviço.

Mensagens de texto, mídia, contato e localização chegam e saem pelas mesmas regras de ritmo, janela e aviso dos outros canais. Entregue e lido aparecem uma vez só e nunca voltam atrás; quando o cliente apaga uma mensagem para todos, ela continua no histórico, marcada como apagada. Se o WhatsApp limitar temporariamente o número, a mensagem fica na fila com um aviso na Central e não é reenviada sozinha; se o servidor pedir para esperar, o reenvio respeita o prazo. Se o número já estiver ativo em outro canal da empresa, a tela avisa em vez de falhar em silêncio.

WAHA e as demais conexões não mudam, e nenhuma variável nova é obrigatória.

Enquanto o agente prepara a resposta, o cliente vê "digitando…", como nos outros canais. Ainda não coberto por esta entrega: reações e edição de mensagem feita pelo cliente; e o religamento automático de uma sessão parada, que continua exigindo alguém na Central.
