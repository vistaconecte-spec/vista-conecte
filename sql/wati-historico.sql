-- Etapa 4b da saída do Wati (20/10/2026): cópia do histórico do Wati antes de cancelar.
-- Só leitura no Wati (API v1 getContacts / getMessages); o script fica fora do repo, em
-- C:\Users\barba\.claude\wati-historico\copiar.mjs. Rodar de novo não duplica (upsert por id).
-- Mídias (fotos, áudios, documentos) ainda NÃO são baixadas: fica só o link do Wati em `midia`,
-- que para de funcionar quando a conta do Wati for cancelada.
-- Mesmas permissões das tabelas do atendimento: RLS ligado, só a service_role.

create table if not exists public.wati_hist_contatos (
  wa_id         text primary key,
  id_wati       text,
  nome          text,
  primeiro_nome text,
  atributos     jsonb,        -- customParams do Wati, nome → valor
  fonte         text,
  status        text,
  criado        text,         -- vem do Wati como "Oct-20-2026"
  copiado_em    timestamptz not null default now()
);

create table if not exists public.wati_hist_mensagens (
  id         text primary key,          -- id do item no Wati
  wa_id      text not null,
  quando     timestamptz,
  evento     text,                      -- message, broadcastMessage, ticket...
  direcao    text,                      -- entrada (cliente) | saida (loja) | null (evento)
  autor      text,                      -- cliente | vi | equipe | bot | template | sistema
  operador   text,                      -- operatorName do Wati (ex.: "Vi da Vista Conecte")
  tipo       text,
  texto      text,
  status     text,
  midia      text,                      -- link do arquivo no Wati
  extras     jsonb                      -- eventDescription, ticketId, templateId, failedDetail...
);
create index if not exists wati_hist_msg_wa_idx on public.wati_hist_mensagens (wa_id, quando);

alter table public.wati_hist_contatos enable row level security;
alter table public.wati_hist_mensagens enable row level security;
revoke all on public.wati_hist_contatos, public.wati_hist_mensagens from anon, authenticated;
grant select, insert, update, delete on public.wati_hist_contatos, public.wati_hist_mensagens to service_role;
