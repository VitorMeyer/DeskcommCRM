# PRD 07 — Canal uazapi (WhatsApp não-oficial)

**Status:** Em implementação — aceite ainda não demonstrado | **Versão:** 1.1 | **Data:** 2026-10-13

> **Estado de execução em 2026-10-13.** Legenda: ✅ provado por teste automatizado (unitário ou de banco); 🟡 implementado, **sem** prova contra a API viva nem pela tela; `[ ]` não feito.
>
> - **Onde está o código.** Branch `feat/canal-uazapi`, worktree `~/orca/DeskcommCRM-uazapi`, base `upstream/main`. Commitado em `origin/feat/canal-uazapi` (o fork), **sem PR**; instalação de teste no ar desde 2026-10-13. A migration já foi renumerada cinco vezes porque o canônico anda ~200 commits/dia e não há reserva de número: `0444` → `0485` → `0501` → `0505` → `0594` → hoje **`20261014100000_0659_canal_uazapi.sql`** (em 2026-10-13 a `main` ia até `0654`/`20261014000001` e os PRs abertos reivindicavam até `0658`/`20261014090000`, ambos do #2820; a `0594` virou `assumir_interrompe_turno_autonomo` no canônico). Sincronizada com o canônico em 2026-10-13 (`0c05ca348`, v1.80.0, 1.125 commits depois da sincronização de 2026-10-07), por stash nomeado, fast-forward e reaplicação do trabalho não commitado; três conflitos resolvidos à mão: `lib/channels/arquivo-de-webhook.ts` (a lista de cabeçalhos proibidos soma `asaas-access-token` do upstream com `token`/`admintoken` nossos), `dicionario.ts` (soma) e `baseline.sql` (o apêndice soma; e o `webhook_events_log_provider_check` une `'uazapi'` com `'stripe'`/`'asaas'` da 0601). Fusão semântica corrigida fora do conflito: a migration nossa redefine esse mesmo CHECK e, por rodar depois da 0601, estreitaria a lista — ganhou `'stripe'` e `'asaas'`. Na sincronização de 2026-10-07 o ponto equivalente foi o `send-ledger` (o caminho pela PK passou a devolver também o prazo de nova tentativa; sem isso o 463/429 perderia o `retry_after_at`), que desta vez o upstream não tocou. Antes de abrir PR: `git fetch upstream && git merge upstream/main` e `pnpm checar:colisao-de-migration` mais `gh pr list --repo melgarafael/DeskcommCRM --state open --limit 500 --json number,files` (o `checar` só enxerga migration commitada).
> - **O que tem prova.** Baseline em INSTALL e UPDATE com `ON_ERROR_STOP=1` e invariantes de banco (`pnpm test:db`; a nova é `tests/invariants/canal-uazapi.test.ts`: união de referências, unicidade, isolamento entre tenants e auto-cura do apêndice); parser contra fixtures de formato real; ACK e apagamento pelo mesmo passo dos outros canais; token fora do arquivo de webhooks; envio, sessão e credencial com o `fetch` simulado; corpos e respostas conferidos contra a especificação OpenAPI v2.4.2 (seção abaixo).
> - **O que NÃO tem prova.** Nenhuma chamada a uma instância real (as fixtures são sanitizadas de capturas parciais do spike); nenhuma prova pela tela (`curl` e teste de rota não contam); nenhum E2E; instalação fresca com o canal ligado.
> - **Achados desta rodada, já corrigidos** (todos por gate que os testes de unidade sozinhos não pegariam): o baseline **não instalava** num banco novo (índice único antes de `archived_at` existir, 42703); um 463 deixava o job de posse do worker, que o reagendava e, ao esgotar as tentativas, abria alerta crítico `job_dead`; recibo de leitura do próprio dono virava "lida" na linha do cliente; desconectar apagava o número da conexão; o ACK ignorava a regra de tique único do passo comum.

---

## Visão geral (1 parágrafo)

Integrar a **uazapi** como sexto transporte de WhatsApp do DeskcommCRM, ao lado do WAHA. A uazapi é um serviço SaaS que pareia por QR ou código, detecta ban por número novo e hospeda a sessão deles — não é imagem Docker. Entra **opcional e desligada por padrão**, com credencial por conexão (URL + token da instância, cifrados), e herda o anti-ban e os horários que o seam de canais já cobre. O trabalho de verdade está em normalizar a entrada (ingest), o ciclo de sessão (QR/código/reconectar/excluir) e o vigia do worker.

---

## Por que agora

1. **Demanda de alternativa ao WAHA.** O WAHA é instável em escala (medido em produção: desconexões frequentes). A uazapi oferece estabilidade comparável à Cloud API, com motor bem mais barato (whatsmeow em Go, não Node).
2. **Modelo de distribuição.** DeskcommCRM é self-host, e o cliente é quem paga a infra. Pedir que instale mais um contêiner (WAHA) é um ônus. A uazapi tira isso: é SaaS, o cliente já contrata um servidor com eles.
3. **Tempo de implementação curto.** O seam de canais já existe. Faltam peças de sessão e entrada que são genéricas — fiz o mapa de acoplamento. Duas sessões paralelas conseguem fechar em 3–4 sprints.
4. **Sem nova dependência crítica.** O WAHA continua como default e padrão. Quem não contratar uazapi não muda nada no `.env` nem no compose.

---

## Escopo

### Entra (MVP)

- ✅ Registro do provider em `lib/channels/` (tipo, matriz de capabilities, ADAPTERS, session-ref, apresentação). Provider sem linha na matriz não compila (`Record<ProviderDeMensagem, …>`).
- ✅ Schema: colunas aditivas, CHECKs do provider, índices únicos parciais (instância entre ativas; uma por organização) e dedup que preserva a linha mais antiga. Tripla migration + apêndice + MANIFEST; `pnpm test:db` verde em install e update.
- 🟡 Credencial por conexão: URL do servidor + token da instância, cifrados em `channel_sessions`. Testada com `fetch` simulado (token nunca em claro, webhook registrado antes de salvar, troca de instância); sem instância real.
- ✅ **Trocar o token e remover não dependem do token antigo** (achado do primeiro teste vivo, 2026-10-14: a instância gratuita expirou ~1 h depois de criada, o servidor passou a recusar o token, e a conexão não saía mais da tela — remover pedia ao servidor, com o token morto, que apagasse a instância; o token de outra instância era recusado com "desconecte antes", e Desconectar só aparecia com o número conectado). Agora:
  - credencial recusada (401/403) nas operações de sessão é desfecho com nome (`CredencialRecusadaError`): a tela diz "o servidor recusou o token salvo — troque ou remova", para de consultar e esconde QR/código;
  - **trocar o token** grava na MESMA linha (mesmo canal, mesmo acesso da IA e histórico): mesma instância com token novo, ou OUTRA instância quando o número atual não está conectado. Com o número conectado, a troca de instância é recusada — desconectar primeiro, e desconectar não depende do token estar vivo;
  - **remover** é a exclusão comum da Central (`DELETE /api/v1/channel-sessions/[id]`, com o diálogo que mostra o que fica guardado): desconecta o número na instância em best-effort, rotaciona a URL do webhook e arquiva ou apaga a linha. **A instância não é apagada no serviço**: quem a criou foi o cliente, no painel deles;
  - a conexão removida sai da aba (a tela mostrava a linha arquivada, com botões que respondiam "Este canal foi excluído"); reconectar a mesma instância depois desarquiva a linha dela.
- 🟡 Tela "Conectar uazapi": colar URL e token de uma instância já criada no painel deles, validar na hora, guardar cifrado; sem prova visual E2E.
- 🟡 Métodos de sessão no `ChannelAdapter` (novo grupo opcional `sessao?`):
  - `connect(QR|code)`: abre o fluxo de pareamento.
  - `getStatus`: consulta estado (`disconnected`, `connecting`, `connected`, etc.), traduz para o vocabulário do banco (`SCAN_QR_CODE`, `WORKING`, `STOPPED`, `FAILED`).
  - `disconnect`: encerra a sessão, exige novo QR.
  - Sem `delete`: apagar a instância no serviço não é papel do CRM (ver o item acima). Excluir o canal é a rota comum, que desconecta pelo `disconnect`.
- 🟡 Rotas de QR e pareamento que testam se o método existe, reutilizando o `PairingOptions` para WAHA e uazapi; falta E2E.
- 🟡 Webhook: registra via `POST /webhook` (instância token). Filtro automático `excludeMessages: ["wasSentByApi"]` para cortar eco; falta comprovação contra API real.
- 🟡 Parser + processador normalizado de eventos em `lib/channels/uazapi/`:
  - Dedup por `(organization_id, messageid)` (não é `id`).
  - Echo (`wasSentByApi:false` + filtro).
  - Grupos (`isGroup:true` → `@g.us`).
  - LID (resolve do `sender_lid` quando houver).
  - ACK: `messages_update` → `status_message_sent/read`, relógio em segundos.
  - Edição e apagamento.
  - Presença (digitando/gravando).
  - Eventos de conexão → sincroniza saúde e warm-up.
- Estado observado: mensagens, dedup compartilhada, identidade PN/LID, localização recebida, ACKs (pelo passo de desfecho comum), apagar-para-todos (`revoked_at`, a linha permanece) e transições de conexão (com `last_status_change_at` só quando o status muda). **Ignorados de propósito:** presença (o webhook nem a assina — cada "digitando…" seria uma linha no arquivo de webhooks), reação (`reaction` preenchido), recibo que partiu do próprio número (`IsFromMe`, é leitura de mensagem *recebida*) e tipo sem texto nem mídia (o corpo fica em `webhook_events_log`; o reprocessador automático hoje só atende o WAHA, então recuperar é manual). **Pendente:** edição feita pelo cliente — a especificação não diz em que evento chega e não há payload real capturado; não vou adivinhar.
- 🟡 Adapter de envio (`send`, `resolveRecipient`): texto, mídia, contato e localização estão implementados; reação ainda não está integrada ao contrato de mensagens. 463 fica `queued`, abre aviso deduplicado na Central e encerra o job sem reenvio automático; 429 persiste `Retry-After` e agenda o reenvio durável no caminho de agente/automação. Os dois caminhos têm testes unitários; prova E2E ainda pendente.
- 🟡 Métodos opcionais do adapter:
  - `fetchInboundMedia`: chama `POST /message/download`, retorna URL pública por 2 dias.
  - `checkHealth`: `GET /instance/status`.
  - `signalTyping`: `POST /message/presence`.
  - `editMessage` / `revokeMessage`: `POST /message/edit` e `POST /message/delete`.
- 🟡 Vigia: o `channel-health` (genérico, via `checkHealth` do adapter) **já cobre** o uazapi — corrige o espelho e abre o aviso. O `session-reconciler` (worker) segue só WAHA e **não** religa sessão uazapi; o redrive dele já exclui sessões sem `waha_session_name`. Religar `STOPPED` é decisão em aberto (seção abaixo).
- ✅ Testes de matriz, vocabulário, isolamento RLS (invariante de banco) e `lint:channels`. `[ ]` E2E: um dublê HTTP local **não serve** aqui — a URL do servidor é entrada do tenant e o app recusa `http:` e IP privado em produção (guarda anti-SSRF); enfraquecê-la só para teste seria pior que não ter o E2E. Ver "Próximos passos".
- 🟡 Flag de instalação `UAZAPI_ENABLED` (desligada por padrão, como `DATAFY_ENABLED`): ausente, a aba some e as rotas respondem 404; clone fresco e fluxo de instalação por provar pela tela.
- ✅ Changelog com fragmento `.changes/` (`pnpm release:conferir` valida a forma). O texto vira nota pública: revisão humana antes do corte.

### Não entra (V2 ou nunca)

- ❌ Criar instância automaticamente com `admintoken`. (Requer decisão sobre privilégio mínimo e armazenamento de token do servidor.)
- ❌ Usar filas, campanhas ou `delay` da uazapi direto. (Pularia `before_send` e o anti-ban.)
- ❌ Chatbot ou agente embutido da uazapi. (Ambição fora do escopo do MVP.)
- ❌ Exportar para o CRM deles (kanban, leads de tag). (Integração bidirecional, complexa.)
- ❌ Retirar o WAHA de `required()` ou do compose. (Risco de quebra retroativa.)

---

## Contrato conferido contra a especificação (OpenAPI v2.4.2, 2026-09-28)

Conferido campo a campo contra `https://docs.uazapi.com/openapi-bundled.json` (v2.4.2), não contra memória:

| O que o código faz | O que a especificação diz |
|---|---|
| `POST /send/{text,media,contact,location}`, `/message/{presence,edit,delete,download}`, `/instance/{connect,disconnect}`, `DELETE /instance`, `GET /instance/status`, `POST /webhook` | Todos existem, no método usado, com os corpos que o adapter monta (`number`, `text`, `replyid`, `type`/`file`/`mimetype`/`docName`, `fullName`/`phoneNumber`, `latitude`/`longitude`/`name`/`address`, `presence`, `id`, `phone`). |
| Estados `disconnected`/`connecting`/`connected`/`hibernated` → vocabulário do banco | É exatamente o enum documentado de `instance.status`. `registering`/`registration_conflict` (que o mapa também trata) **não** estão no enum. |
| `excludeMessages: ["wasSentByApi"]`; eventos `messages`, `messages_update`, `connection` | Ambos válidos; a própria documentação manda usar o filtro para evitar laço. `presence` existe como evento, mas **não** é assinado. |
| `external_id = messageid` (curto) | Edit, delete e download aceitam o `messageid` curto **ou** o id completo (`owner:messageid`). |
| Apagar para todos | Gera `messages_update` com o estado `"Deleted"` — é o que vira `revoked_at`. |
| Reação | `POST /message/react` só precisa de `id` e `text`. Não integrada: o CRM não tem envio de reação em **nenhum** canal (decisão de produto). |
| Erro 463 | `provider_code: 463` no corpo; existe `GET /instance/wa_messages_limits` (restrição temporária/limite de novas conversas) — oportunidade futura de detalhar o aviso. |
| Relógios | Mensagem em **milissegundos**, recibo (`messages_update`) em **segundos** (visto nas fixtures reais); o parser aceita os dois. |

---

## Decisões em aberto (do dono do produto)

1. **Religar sessão `STOPPED` sozinho?** O Fase 2 pede "reconecta sessões `STOPPED`", mas aqui `STOPPED` mistura `disconnected` (quase sempre deslogado — `connect` só gera um QR novo, que expira e volta a `STOPPED`, alternando `SCAN_QR_CODE`/`STOPPED` a cada minuto e gerando aviso à toa) e `hibernated` (sem endpoint de reativação; o próprio PRD já decidiu congelar). **Recomendação:** não religar automaticamente na v1; o `channel-health` já avisa e a pessoa clica em "Gerar QR Code". Implementado assim.
2. **Reação (enviar e receber).** Sem modelo de reação no CRM para nenhum canal; fazer só para este seria um recurso novo do produto. **Recomendação:** fora do MVP; a reação recebida é ignorada.
3. **Edição feita pelo cliente.** Depende de capturar o payload real (Fase 0). Enquanto isso, a mensagem editada mantém o texto original no CRM.

---

## Critérios de aceite

### Decidido (conforme a pesquisa da API)

| Critério | Prova |
|---|---|
| Webhook sem HMAC → autenticação por token opaco no path + comparação em memória | Teste de isolamento RLS: token de org A não pode escrever em B |
| Mídia recebida chega criptografada → chamar `POST /message/download` | Teste e2e: imagem/áudio/documento recebidos aparecem na conversa |
| `messageid` curto em acks, `id` longo em respostas de envio → guardar `external_id = messageid` | Ack correlaciona com `messages.external_id`, edição e apagar funcionam |
| Echo filtrado por `excludeMessages: ["wasSentByApi"]` | Mensagem do atendente pelo telefone não duplica |
| Erro 463 (TIMELOCK) → `queued` com flag, sem retry automático | Aviso na Central, mensagem entra em retardo visível |
| Estados: `disconnected`, `connecting`, `connected`, `hibernated`, `registering` → traduzem para CHECK do banco | Status ao vivo reflete no banco |
| Token em claro no payload → removido antes de gravar em `webhook_events_log` | Audit log não expõe credencial |
| LGPD: mídia fica 2 dias no CDN, histórico 7 dias no banco deles | Termos de processamento atualizados, política de retenção documentada |

### Incerto (decidir no spike)

| Questão | Opções | Bloqueador? |
|---|---|---|
| Suportar múltiplas instâncias por servidor (e.g., `org_a` e `org_b` ligadas a servidores uazapi diferentes)? | (A) Uma instância por servidor, guardar URL+token em `env` como WAHA. (B) Uma instância por organização, guardar em `channel_sessions`. | Não (v1 é B, v2 é A) |
| Transcodificar PTT para opus-only ou deixar vir como ogg? | (A) Deixar como está (já é ogg/opus no upload). (B) Confirmar com spike e colocar capabilities `voiceNote:"opus-only"`. | Não (estético) |
| Limpar sessões hibernadas? | (A) Congelar em estado `hibernated`, não tentar reativar. (B) Deletar após N dias. | Não (v1 é A) |
| Entrega de templates (fora da janela de 24h)? | A uazapi não tem templates. Resposta: templates é só Meta/Datafy. Uazapi sempre freeform. | Não (resolvido) |

---

## Decisões arquiteturais

### D1: Credencial por conexão (não por servidor)

**Decisão:** Guardar URL + token cifrados em `channel_sessions`, não em `.env`.

**Por quê:**
- Cada organização traz sua própria instância uazapi → isolamento por construção.
- Nenhuma mudança em packaging: `lib/env.ts`, `install.sh`, compose ficam iguais.
- Menor privilégio: um token comprometido afeta uma organização, não todas.

**Custo:** Operador cria a instância no painel da uazapi antes de conectar no CRM. (V2 pode automatizar com `admintoken` se houver demanda.)

### D2: Ao lado do WAHA, não no lugar

**Decisão:** O WAHA continua default e instalação padrão.

**Por quê:**
- Retrocompatibilidade: clones existentes não se quebram.
- WAHA é a opção saudável quando o cliente roda Docker. Uazapi é a alternativa quando não quer contêiner.
- Permite o cliente escolher na tela.

### D3: Processador normalizado (não cópia de ingest)

**Decisão:** Criar `lib/channels/uazapi/ingest.ts` com eventos traduzidos para um formato intermediário, reutilizando `pos-entrada` e workers genéricos.

**Por quê:**
- Elimina duplicação de dedup, eco, comandos, acks, edição, apagamento.
- O WAHA segue como está; migração dele vira PR separado (Fase 3b do seam).
- Menos oportunidade de divergência entre implementações.

### D4: Sessão no adapter (método opcional)

**Decisão:** `ChannelAdapter` ganha um grupo opcional `sessao?: { connect, getStatus, disconnect }`. (Tinha `delete`, que apagava a instância remota; saiu em 2026-10-14 — a instância é do cliente, e a exclusão do canal é da rota comum da Central.)

**Por quê:**
- WAHA continua com as rotas atuais, não é tocado.
- Rotas de QR e pareamento testam presença do método.
- O compilador garante que provider novo declara ou não tem sessão.
- Abre porta para `wacalls` (voz, também tem QR).

---

## Fases

### Fase 0: Spike (1 sprint)

**Entrega:** Validação de incertezas, fixtures de payloads, decisão final sobre questões do D3.

**Atividades:**
1. Criar servidor de teste na uazapi (instância grátis expira em 1h — só para capturar exemplos).
2. Capturar payloads reais: mensagem de texto, imagem, áudio/PTT, vídeo, contato, reação, edição, apagamento, ack, presença.
3. Testar cada erro: 463 (TIMELOCK), 429 (rate limit), timeout de QR/code.
4. Confirmar: conversão de áudio (fica ogg ou precisa transcodificar?), retenção de história (7 dias mesmo?), validade de URL de mídia (2 dias?).
5. Documentar incertezas resolvidas, criar issue com proposta final.

**Prova:** Fixtures versionadas em `tests/fixtures/uazapi/`, issue aberta e referenciada nos PEGs.

---

### Fase 1: Conexão (1 sprint)

**Entrega:** Instância uazapi pode ser conectada na tela, número aparece `WORKING`.

**Atividades:**
1. Registrar provider: `ChannelProvider`, matriz (banRisk:true, groups:full, …), ADAPTERS, session-ref, `channelBrand`.
2. Schema: migrations 0XXX com colunas aditivas, CHECKs de `provider` / `provider_ref`, índice único parcial, apêndice no baseline.
3. Tela: "Colar URL e token" com validação `GET /instance/status` na hora.
4. Adapters: stub do `send`, `resolveRecipient`, métodos de sessão (`connect`, `getStatus`, `disconnect`, `delete`).
5. Registro de webhook: `POST /webhook` com filtro `excludeMessages: ["wasSentByApi"]`.

**Prova:** 
- Número conectado aparece em "Conexões" → "Números ativos" (UI).
- Tela de QR e pareamento funcionam.
- Status `WORKING` gravado no banco, refletido no retrato (`lib/instalacao/retrato.ts`).
- Teste de integração: criar sessão, QR aparece, desconectar.

---

### Fase 2: Saída (1 sprint)

**Entrega:** Agente e automação conseguem enviar por uazapi.

**Atividades:**
1. Implementar `send()` completo: texto, mídia (imagem, áudio/PTT, vídeo, documento), contato, localização, reação, edição, apagamento.
2. Mapear erros: 463 (TIMELOCK) → `queued`, 429 (rate limit) → retry com backoff.
3. Mapear JID: número puro → `...@s.whatsapp.net`, `@lid`, `@g.us`, preservar opaco.
4. `echoExternalIds`: comparar `messageid` nos dois sentidos (enviado vs. webhook).
5. Vigia do worker: testa presença de `connect()`, reconecta sessões `STOPPED`.

**Prova:**
- Mensagem de agente e automação saem pela UI, e2e.
- Erro 463 gera aviso na Central e entra em fila (não dispara retry).
- 429 rerespetta `Retry-After` e reinsere em fila.

---

### Fase 3: Entrada (2 sprints)

**Entrega:** Conversa bidirecional com cliente, acks, edição, apagamento, eventos de saúde.

**Atividades:**
1. Parser: `lib/channels/uazapi/envelope.ts` (Zod do contrato).
2. Ingest: `lib/channels/uazapi/ingest.ts` com dedup, echo, LID, grupos, acks, edição, apagamento, presença, eventos de conexão.
3. Reuso: `pos-entrada`, `comando-de-canal`, `sincronizarSaudeDaConexao`, worker de mídia (`fetchInboundMedia` retorna URL pública de 2 dias).
4. Testes: spike de 42 cenários (texto, mídia, LID, grupos, acks, edição, apagamento, presença, conexão).

**Prova:**
- Conversa completa com agente e atendente.
- Imagem/áudio/documento recebidos são persistidos e aparecem na UI.
- Ack (entregue/lido) reflete status.
- Edição e apagamento funcionam.
- Presença "digitando…" aparece no cliente.
- Status `DISCONNECTED` / `FAILED` alimenta o warm-up e desativa o envio.

---

### Fase 4: Opcional (V2)

**Entrega:** Automatizar criação de instância; retirar WAHA de obrigatório; migrar WAHA para ingest normalizado.

**Atividades:**
1. Guardar `admintoken` do servidor em `environment` ou `organizations.settings`, validar privilégio.
2. Rota `POST /instance/create` com `admintoken`.
3. Remover `required()` de `WAHA_*` em `lib/env.ts`, substituir com guarda de "nenhum transporte configurado".
4. Migrar `lib/waha/ingest.ts` para o processador normalizado.

---

## Restrições (Não-negociáveis)

| Restrição | Razão |
|---|---|
| SaaS hospedado por eles; cliente não instala | Modelo de receita deles, fora do controle nosso. Temos que aceitar ou não trabalhar com eles. |
| Webhook sem HMAC; token em claro no payload | Arquitetura deles. Compensamos com token opaco no path e leitura de memória. |
| Mídia fica 2 dias no CDN, história 7 dias no banco deles | LGPD: eles são suboperadores, cliente é o controlador. Documentar e avisar. |
| Erro 463 é bloqueio do WhatsApp, não nosso | Sem controle nosso. Resposta: aviso e fila visível. |
| Termos de uso inacessíveis (URL offline) | Risco: não confirmamos revenda/white-label. Mitigation: abrir issue com mantenedor antes de publicar. |

---

## Métricas de sucesso

| Métrica | Target | Medida |
|---|---|---|
| Instâncias criadas / mês (instalação com uazapi ativa) | ≥ 5 | Dashboard interno |
| Mensagens por uazapi / mês (clientes pagando) | ≥ 10k | `messages.provider = 'uazapi'` |
| Taxa de sucesso de envio | ≥ 98% | `messages.status = 'delivered'` / total |
| Tempo médio de ack | ≤ 30s | `messages_update.Timestamp - messages.messageTimestamp` |
| Uptime percebido (sem desconexão > 5min) | ≥ 99.5% | Monitoramento de health check |
| Taxa de defeito crítico por mês | ≤ 1 | Issues de produção ligadas a uazapi |

---

## Riscos

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Política de assinatura muda, ficamos fora do SaaS deles | Média | Alto | Acompanhar releases, manter contato com time deles. |
| Webhook fica indisponível, eventos não chegam | Baixa | Alto | Implementar SSE como fallback (já têm suporte). |
| Instância hibernada não volta (não há endpoint) | Média | Médio | Reconectar automaticamente ao notificar saúde = false. |
| Cliente não consegue criar instância (intuitivo?) | Média | Médio | Documentar com print do painel, vídeo. |
| ID vs messageid confundindo em acks | Média | Médio | Testes de spike com payload real capturado. |
| Credencial cifrada em `channel_sessions` vaza | Baixa | Alto | RLS por `organization_id` (invariante `canal-uazapi.test.ts`). O texto cifrado é legível pelos membros da organização pela API REST, **como nos demais canais** (mesma tabela); o que o protege é a chave de cifra, que é do servidor. Coluna separada/`revoke` de coluna seria mudança de postura para todos os canais. |
| Comportamento real difere das fixtures sanitizadas (edição, mídia grande, grupos, LID) | Média | Médio | Validação viva pendente (Próximos passos); tipo desconhecido é ignorado e o corpo fica em `webhook_events_log`. |
| Banco fora por minutos = mensagem recebida perdida | Baixa | Alto | A rota grava o corpo em `webhook_events_log` **antes** de processar e devolve 500; mas o serviço remoto tenta a entrega poucas vezes (a especificação mostra `attempts: 3`, histórico só em memória) e o cron `webhook-replay` só reprocessa `provider = 'waha'`. Comportamento herdado da rota genérica, não introduzido aqui. **Seguimento:** estender o replay ao provider (contrato próprio, marca `transitoria:` no arquivo). |
| SSRF: a URL do servidor é entrada do administrador da organização | Baixa | Médio | Só HTTPS em produção, sem credencial/fragmento, `redirect: "error"`, DNS checado na validação e a cada chamada, URL de mídia checada antes do download. **Janela de DNS rebinding** entre checagem e `fetch` (mesmo padrão do webhook de saída; as extensões amarram o endereço). Registrado em `docs/threat-model.md`; seguimento: primitiva de fetch com endereço amarrado, em PR próprio. |
| Mesmo número ativo em WAHA e neste canal (migração) | Média | Médio | O banco recusa ("um número vive em UM canal ativo"); a tela avisa com `phone_number_conflict`. O número é gravado só em dígitos, como o WAHA, senão a trava não pega. |

---

## Entregáveis

| Artefato | Fase | Responsável |
|---|---|---|
| Spike report + fixtures | 0 | Developer |
| Issue de proposta (decisões D1–D4) | 0 | Developer |
| Migration + baseline + MANIFEST | 1 | Developer |
| Tela de conexão + adapter de stub | 1 | Developer |
| Adapter de envio completo | 2 | Developer |
| Processador de entrada + testes | 3 | Developer |
| Documentação de LGPD + DPO | 3 | Product / Legal |
| Changelog com fragmentos `.changes/` | 3 | Developer |
| Playbook de troubleshooting | 3 | Documentation |
| Vídeo de onboarding (conectar instância) | 3 | Content |

---

## Definição de Pronto (DoD)

1. [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` passam zerados. Medido em 2026-10-13, depois da sincronização com `0c05ca348`: typecheck 0 erros (precisa de `NODE_OPTIONS=--max-old-space-size=12288` no Node 24), lint 0 erros (537 avisos; os dois em arquivo nosso, `inbound-turn.ts` linhas 7 e 1301, são do upstream), `lint:channels` sem dívida nova (62 conhecidas). `pnpm test:unit`: exit 1, 2209 arquivos (2 vermelhos, 1 pulado) e 23.065 casos (12 vermelhos, sem linha `Errors`; rodapé e `grep FAIL` batem em 12). Os dois vermelhos NÃO são desta branch: `tests/unit/instalador-idioma-da-cli.test.ts` (11 casos, ambiental: o `/bin/bash` do macOS é a 3.2 e o instalador usa arrays associativos; passa no CI Linux) e `tests/unit/conversao-pelo-canal.test.ts` (1 caso, "com a conexão direta ligada, a etapa segue por ela": o teste fixa `2026-10-06T16:32:50Z` e passou a falhar quando a data fez 7 dias — reproduzido igual num worktree de controle em `upstream/main` limpo). `pnpm test:db` verde (install, update e os 441 arquivos de invariantes, 3.445 casos, com `CONFERENCIA_KIT_RELEASE=v1.80.0`).
2. ✅ RLS testada: admin da organização B não vê, não altera e não cria sessão com o `organization_id` da A (`tests/invariants/canal-uazapi.test.ts`). O webhook resolve a organização pelo token do caminho, nunca pelo corpo, e os efeitos filtram por ela (`uazapi-inbound-desfecho.test.ts`).
3. ✅ Token removido de `webhook_events_log` (corpo, JSON quebrado e cabeçalhos: `uazapi-arquivo-sem-token.test.ts`). O audit de envio é o do handler comum, que não mudou; `channel.connected/reconnected/disconnected/archived` auditados nas rotas de sessão.
4. [ ] Teste e2e em ambiente fresco: conexão, envio, recebimento, ack, edição.
5. ✅ Migration versionada + apêndice idempotente no baseline + linha no MANIFEST; `pnpm test:db` verde (install, update e invariantes).
6. [x] Lint (canais) não menciona provider fora de `lib/channels/` (gate executado: `lint-channels: ok`, 62 débitos conhecidos e nenhum novo).
7. ✅ Matriz de capabilities testada; provider novo = erro de compilação se faltar linha.
8. [ ] Entrega comprovada pela tela (UI de conexões, inbox, agente).
9. [x] Fragmento `.changes/` descrevendo o efeito no operador (presente; revisão final ainda pendente).
10. [ ] Artefato versionado na `main` com attribution das sessões (Opus 5.5 e Haiku 4.5).

---

## Próximos passos

1. **Validação viva (Fase 0 que ficou pela metade).** Com uma instância real: conectar pela tela, mandar e receber texto/áudio/imagem, ver entregue/lido, apagar uma mensagem, provocar um 463 se possível, e capturar os payloads que faltam (edição, reação, grupo). Cada captura vira fixture sanitizada em `tests/fixtures/uazapi/`.
2. **Prova pela tela em ambiente fresco** (DoD 8 e 4): banco do `baseline.sql` + `bootstrap-owner`, `UAZAPI_ENABLED=true` e também **ausente**, Playwright. O servidor→uazapi só se prova com uma instância real (HTTPS público); o dublê local é barrado pelo guarda anti-SSRF de propósito.
3. **Antes do PR:** `git fetch upstream && git merge upstream/main`; `pnpm checar:colisao-de-migration`; suíte inteira; `pnpm test:db` e `pnpm test:db:update`; `pnpm build`; sabotar o que o PR corrige. Identidade dos commits e "O que NÃO medi" no corpo.
4. Decidir as três questões abertas acima.

---

## Referências

- API docs: https://docs.uazapi.com/openapi-bundled.json (v2.4.2)
- Payloads reais: https://github.com/TitoBahe/uazapi-webhook-events-examples
- Os dois relatórios de subagente citados na v1.0 estavam em `/tmp` e foram descartados; a pesquisa da API foi refeita contra o OpenAPI v2.4.2 (seção "Contrato conferido").
- Mapa vivo: `docs/architecture/canal-uazapi.architecture.json`
- Doutrina do seam: `docs/handoffs/HANDOFF-canais-oficial.md`
- Restrição de canal: `docs/doctrine/restricao-de-canal.md`
