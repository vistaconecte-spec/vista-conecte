-- Atendimento próprio, etapa 3 (19/10/2026): a Vi passa a mandar direto pela Meta.
-- origem: quem mandou a mensagem de saída ('vi', 'template', 'painel'); vazio = só status (veio do Wati).
alter table public.wa_mensagens add column if not exists origem text;
-- Chave do caminho da Vi, lida pelo worker (lerCanal): 'wati' até a troca, 'meta' depois.
-- canal_meta_teste: números que já vão pela Meta antes da troca geral.
alter table public.wati_ia_config add column if not exists canal_whatsapp text not null default 'wati';
alter table public.wati_ia_config add column if not exists canal_meta_teste text[] not null default '{}';
