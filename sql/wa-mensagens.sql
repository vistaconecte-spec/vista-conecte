-- Atendimento próprio, etapa 1 (19/10/2026): o app Meta "claude" recebe o webhook do número
-- oficial (+55 48 7400-2390) em PARALELO com o Wati e grava aqui. Nada lê estas tabelas ainda;
-- servem para conferir que chega tudo o que chega no Wati antes de desligar ele.
--
-- Mesmas permissões da wati_ia_mensagens: RLS ligado, nada para anon/authenticated (tem
-- telefone de cliente e o repo é público), tudo para a service_role que as functions usam.

create table if not exists public.wa_mensagens (
  wamid        text primary key,              -- id da mensagem na Meta
  telefone     text not null,                 -- wa_id da cliente, só dígitos
  direcao      text not null check (direcao in ('entrada', 'saida')),
  tipo         text,                          -- text, image, audio, document, button, reaction...
  texto        text,                          -- corpo, legenda ou título do botão
  midia_id     text,                          -- id da mídia na Meta (vale ~30 dias)
  midia_mime   text,
  nome_contato text,                          -- nome do perfil do WhatsApp
  resposta_a   text,                          -- wamid da mensagem citada
  status       text,                          -- saída: sent, delivered, read, failed
  status_rank  int not null default 0,        -- só deixa o status andar pra frente
  status_em    timestamptz,
  erro         jsonb,
  enviada_em   timestamptz,                   -- hora da Meta
  recebida_em  timestamptz not null default now(),
  bruto        jsonb
);
create index if not exists wa_mensagens_tel_idx on public.wa_mensagens (telefone, enviada_em desc);
create index if not exists wa_mensagens_em_idx on public.wa_mensagens (recebida_em desc);

-- Corpo cru de cada POST, para auditoria da fase em paralelo. Pode ser apagado depois.
create table if not exists public.wa_eventos (
  id          bigserial primary key,
  recebido_em timestamptz not null default now(),
  corpo       jsonb not null
);

alter table public.wa_mensagens enable row level security;
alter table public.wa_eventos enable row level security;
revoke all on public.wa_mensagens, public.wa_eventos from anon, authenticated;
grant select, insert, update, delete on public.wa_mensagens, public.wa_eventos to service_role;
grant usage, select on sequence public.wa_eventos_id_seq to service_role;
