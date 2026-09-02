-- ============================================================================
-- TRAVA CONTRA ESCRITA ATRASADA  —  vc_modelos
-- ============================================================================
-- POR QUE ISTO EXISTE
--
-- Em 02/09/2026, 01:38, cinco modelos voltaram sozinhos para agosto: o Macacão
-- Amplo e a Calça Pantalona Viscolycra saíram da costura, o Cropped Canelado
-- perdeu a etapa inteira, e as contagens de estoque voltaram a valores antigos.
--
-- A causa NÃO estava no código publicado: estava numa ABA ANTIGA do painel,
-- aberta desde agosto, rodando uma versão da página anterior a 11/08/2026. Nessa
-- versão a baixa automática de estoque lia o modelo do localStorage e devolvia o
-- DOCUMENTO INTEIRO para a nuvem. Como o localStorage daquela aba era de agosto,
-- cada baixa regravava agosto por cima de tudo. O código atual lê da nuvem antes
-- de baixar, justamente por causa de um episódio idêntico em 11/08/2026 — mas
-- correção em código não alcança uma aba que não recarregou.
--
-- Esta trava vive no BANCO. Vale para qualquer cliente, de qualquer versão,
-- inclusive uma aba que ninguém sabe que está aberta.
--
-- A REGRA
--
-- Recusa a gravação quando `updated_at` AVANÇA (é uma escrita nova) mas algum
-- carimbo de etapa/contagem ANDA PARA TRÁS. Isso é exatamente a assinatura de
-- "escrita nova carregando conteúdo velho".
--
-- O que continua passando normalmente:
--   • gravação comum          — updated_at avança, carimbos avançam ou ficam;
--   • fim de rodada           — carimbo vira NULL (não é andar para trás);
--   • restaurar versão antiga — updated_at TAMBÉM volta, então não é bloqueado;
--   • documentos de config    — financeiro, precificação, histórico etc. nem
--                               entram na regra (não têm esses campos).
--
-- COMO APLICAR
--   Supabase → SQL Editor → cole tudo → Run.
--   Para remover: DROP TRIGGER trg_vc_modelos_sem_escrita_atrasada ON vc_modelos;
-- ============================================================================

create or replace function vc_bloqueia_escrita_atrasada()
returns trigger
language plpgsql
as $$
declare
  carimbo   text;
  velho_ts  timestamptz;
  novo_ts   timestamptz;
  upd_velho timestamptz;
  upd_novo  timestamptz;
begin
  -- Histórico não entra: ele guarda versões antigas de propósito.
  if new.id like 'hist:%' then
    return new;
  end if;

  upd_velho := (old.dados->>'updated_at')::timestamptz;
  upd_novo  := (new.dados->>'updated_at')::timestamptz;

  -- Sem updated_at nos dois lados não dá para saber a ordem: deixa passar.
  if upd_velho is null or upd_novo is null then
    return new;
  end if;

  -- Só interessa a escrita que se apresenta como NOVA. Restaurar versão antiga
  -- traz o updated_at antigo junto e é uma decisão deliberada da dona.
  if upd_novo <= upd_velho then
    return new;
  end if;

  foreach carimbo in array array['status_at', 'status2_at', 'prod_at', 'prod2_at', 'est_at']
  loop
    velho_ts := (old.dados->>carimbo)::timestamptz;
    novo_ts  := (new.dados->>carimbo)::timestamptz;

    -- NULL é fim de rodada (o app zera o carimbo de propósito), não é regressão.
    if velho_ts is not null and novo_ts is not null and novo_ts < velho_ts then
      raise exception
        'vc_modelos[%]: escrita recusada — % voltaria de % para %. Escrita nova com conteudo velho (aba desatualizada). Recarregue o painel (Ctrl+F5) nesse aparelho.',
        new.id, carimbo, velho_ts, novo_ts
        using errcode = '23514';
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_vc_modelos_sem_escrita_atrasada on vc_modelos;

create trigger trg_vc_modelos_sem_escrita_atrasada
  before update on vc_modelos
  for each row
  execute function vc_bloqueia_escrita_atrasada();
