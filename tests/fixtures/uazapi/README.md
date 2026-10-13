# Fixtures uazapi

Fixtures sanitizadas de contratos documentados e capturas parciais. Não substituem
validação live dos eventos ainda ausentes no spike.

- Nunca inclua token de instância, URL de webhook, número de telefone ou nome real.
- Nunca inclua URL assinada, `mediaKey`, hash de mídia, `directPath` ou `streamingSidecar`.
- Identificadores usam valores de teste e o token é um marcador sem validade.
- A forma do payload é preservada para testar parser, classificação e remoção de segredo.
