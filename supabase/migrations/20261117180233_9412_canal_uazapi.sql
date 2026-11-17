-- manifest: canal WhatsApp hospedado por instância (uazapi), opcional — `channel_sessions` ganha id da instância (sessionRef), URL do servidor e token cifrado; os CHECKs de provider, da união de referências e do arquivo de webhooks recebem `'uazapi'` sem perder nenhum valor do canônico; índices únicos parciais (instância entre ativas, uma por organização) com dedup que preserva a linha mais antiga.
-- 9412 · Canal uazapi — sessão hospedada com credencial por conexão.
--
-- A instância pertence à organização, não à instalação: URL e token são
-- cifrados na própria linha de channel_sessions. Assim uma credencial exposta
-- não dá acesso aos números das demais organizações e a instalação padrão não
-- ganha variável obrigatória nem serviço Docker novo.
--
-- O id da instância é o sessionRef. Ele é o único identificador estável que a
-- API devolve para correlacionar status, envio e webhook; URL é endereço e
-- token é segredo, portanto nenhum dos dois pode cumprir esse papel.

alter table public.channel_sessions
  add column if not exists uazapi_instance_id text,
  add column if not exists uazapi_server_url text,
  add column if not exists uazapi_instance_token_encrypted bytea;

comment on column public.channel_sessions.uazapi_instance_id is
  'Identificador opaco da instância hospedada. É o sessionRef do canal e é único entre sessões ativas.';
comment on column public.channel_sessions.uazapi_server_url is
  'URL base HTTPS da API da instância. Validada contra SSRF antes de gravar; não inclui token.';
comment on column public.channel_sessions.uazapi_instance_token_encrypted is
  'Token da instância, cifrado por fn_encrypt_oauth. Nunca é devolvido pela API do CRM.';

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  -- A lista inteira, não só o valor novo: um drop+add com a lista antiga
  -- apagaria do vocabulário quem entrou depois (o 'telegram' da 9342).
  check (provider in ('waha', 'meta_cloud', 'zernio', 'zernio_social', 'wacalls', 'datafy', 'telegram', 'uazapi'));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha' and waha_session_name is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls' and wacalls_session_id is not null) or
    (provider = 'datafy' and datafy_phone_number_id is not null) or
    (provider = 'telegram' and telegram_bot_id is not null) or
    (provider = 'uazapi' and uazapi_instance_id is not null
      and uazapi_server_url is not null and uazapi_instance_token_encrypted is not null)
  );

alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;
alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'datafy', 'uazapi',
    -- 'stripe' e 'asaas' vieram da 0601 (cobrança do revendedor) e 'telegram'
    -- da 9342: esta migration roda DEPOIS delas e não pode estreitar a lista.
    'stripe', 'asaas', 'telegram'
  ));

-- A deduplicação acontece ANTES da trava para a atualização de clone não
-- interromper no primeiro 23505. Fica com a instância a linha MAIS ANTIGA: é a
-- que já está operando, e renomear o `sessionRef` dela quebraria o envio sem
-- aviso. A mais nova permanece visível e inoperante, preservando qualquer
-- histórico que a referencie.
with ativos as (
  select id,
         row_number() over (
           partition by uazapi_server_url, uazapi_instance_id
           order by created_at asc nulls last, id asc
         ) as posicao
    from public.channel_sessions
   where archived_at is null
     and uazapi_instance_id is not null
)
update public.channel_sessions s
   set uazapi_instance_id = s.uazapi_instance_id || '-conflito-' || s.id::text
  from ativos a
 where a.id = s.id
   and a.posicao > 1;

create unique index if not exists channel_sessions_uazapi_instance_id_ativo_unique
  on public.channel_sessions (uazapi_server_url, uazapi_instance_id)
  where archived_at is null
    and uazapi_server_url is not null
    and uazapi_instance_id is not null;

create unique index if not exists channel_sessions_uazapi_org_ativo_unique
  on public.channel_sessions (organization_id)
  where provider = 'uazapi' and archived_at is null;

notify pgrst, 'reload schema';
