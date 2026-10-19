-- Atendimento próprio, etapa 2 (19/10/2026): lista de conversas da sub-aba WhatsApp.
-- Junta o que chega direto da Meta (wa_mensagens, desde 19/10/2026 21:16 UTC) com o histórico
-- da Vi (wati_ia_mensagens: cliente, Vi e equipe pelo Wati), porque enquanto o Wati estiver
-- ligado o texto do que a Vi e a equipe mandam só existe lá.
--
-- A mesma cliente aparece com e sem o 9 (556293161442 e 5562993161442): wa_chave() junta as duas.
-- O telefone que a lista devolve é o da última mensagem DELA, que é o endereço que a Meta usa.
--
-- Tudo numa passada só (a 1ª versão, com subconsulta por conversa, levava 18 s).
-- security_invoker: sem isso a view roda como dona (postgres) e passaria por cima do RLS.

create or replace function public.wa_chave(t text) returns text language sql immutable as $$
  select case when length(t) = 13 and t like '55%' and substr(t, 5, 1) = '9'
              then substr(t, 1, 4) || substr(t, 6) else t end
$$;

drop view if exists public.wa_conversas;
create view public.wa_conversas with (security_invoker = true) as
with msgs as (
  select public.wa_chave(telefone) as chave, telefone, coalesce(enviada_em, recebida_em) as em,
         direcao, texto, tipo, nome_contato as nome
    from public.wa_mensagens
   where direcao = 'entrada' or texto is not null
  union all
  select public.wa_chave(wa_id), wa_id, created_at,
         case when role = 'user' then 'entrada' else 'saida' end, texto, 'text', null
    from public.wati_ia_mensagens
   where wa_id ~ '^[0-9]+$'
), marcado as (
  select m.*,
         row_number() over (partition by chave order by em desc) as n,
         max(em) filter (where direcao = 'entrada') over (partition by chave) as ultima_entrada_em,
         first_value(telefone) over (partition by chave order by (direcao = 'entrada') desc, em desc) as tel_cliente,
         first_value(nome) over (partition by chave order by (nome is not null) desc, em desc) as nome_perfil,
         max(em) filter (where direcao = 'saida') over (partition by chave) as ultima_saida_em
    from msgs m
), contado as (
  -- quantas mensagens dela chegaram depois da última resposta da loja (a bolinha verde da lista)
  select k.*,
         count(*) filter (where direcao = 'entrada' and (ultima_saida_em is null or em > ultima_saida_em))
           over (partition by chave) as pendentes
    from marcado k
), sess as (
  select distinct on (public.wa_chave(wa_id)) public.wa_chave(wa_id) as chave, nome, pausada_ate
    from public.wati_ia_sessions order by public.wa_chave(wa_id), updated_at desc nulls last
)
select k.chave,
       k.tel_cliente        as telefone,
       k.em                 as ultima_em,
       k.direcao            as ultima_direcao,
       left(k.texto, 140)   as ultimo_texto,
       k.tipo               as ultimo_tipo,
       coalesce(k.nome_perfil, s.nome) as nome,
       s.pausada_ate,
       k.ultima_entrada_em,
       k.pendentes
  from contado k
  left join sess s on s.chave = k.chave
 where k.n = 1;

revoke all on public.wa_conversas from anon, authenticated;
grant select on public.wa_conversas to service_role;
grant execute on function public.wa_chave(text) to service_role;
