# Fixtures uazapi

Fixtures sanitizadas de contratos documentados e capturas parciais. Não substituem
validação live dos eventos ainda ausentes no spike.

- Nunca inclua token de instância, URL de webhook, número de telefone ou nome real.
- Nunca inclua URL assinada, `mediaKey`, hash de mídia, `directPath` ou `streamingSidecar`.
- Identificadores usam valores de teste e o token é um marcador sem validade.
- A forma do payload é preservada para testar parser, classificação e remoção de segredo.

## Capturas reais de mensagem pelo celular, edição, reação e grupo

`messages-outbound-*`, `messages-*-editada*`, `messages-*-reacao`, `messages-grupo-*`
e `groups-*` vêm do repositório público de exemplos de webhook citado no PRD 07
(github.com/TitoBahe/uazapi-webhook-events-examples), lidos em 2026-11-17. Telefones,
identificadores opacos (`@lid`), nomes, ids de grupo, token, `BaseUrl`, URLs de mídia,
miniaturas e hashes de mídia foram trocados por valores de teste antes de entrar aqui.
Os ids de mensagem (`AC…`) foram mantidos: são o que liga a edição e a reação à original.
