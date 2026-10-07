-- ============================================================================
-- TRAVA CONTRA ESCRITA ATRASADA  —  vc_modelos          (versão 3 — 07/10/2026)
-- ============================================================================
-- POR QUE A V3
--
-- Em 06/10/2026, 11:53, uma tela aberta desde antes da transferência da costura
-- regravou a Calça Pantalona Viscolycra e o Moletom Gola Alta: a leva em corte
-- saiu do corte, as peças que vieram da costura sumiram do estoque e o
-- faturamento do corte lançou as levas como pagas. A v2 estava ativa e não
-- segurou por dois furos:
--
--   1. ORDEM DOS GATILHOS. O Postgres roda os gatilhos em ordem alfabética. O
--      `trg_vc_modelos_grade_velha` (que só devolve a grade antiga e deixa o
--      resto passar) rodava ANTES deste. No Gola Alta ele trocou o prod_at velho
--      pelo gravado, e quando este gatilho olhou já não havia carimbo voltando:
--      o status vazio e o estoque velho passaram. Agora este gatilho se chama
--      `trg_vc_modelos_0_...` e roda primeiro: escrita velha é RECUSADA inteira.
--
--   2. CARIMBO QUE ESTAVA VAZIO. Na Pantalona o status_at gravado era NULL (a
--      leva tinha acabado de sair da costura) e a tela velha mandou status_at de
--      18/09. "Vazio → 18/09" não é "voltar no tempo" para a v2, então passou.
--      Regra nova: um carimbo que MUDA tem que mudar para uma hora recente. Se
--      ele passa a valer uma data mais de 10 min anterior ao updated_at gravado,
--      é conteúdo velho e a escrita é recusada.
--
-- O que continua passando: gravação comum (carimbo novo = agora), carimbo que
-- não muda, fim de rodada (carimbo vira NULL), restaurar versão (updated_at
-- também volta) e documentos sem esses campos.
--
-- COMO APLICAR
--   Supabase → SQL Editor → cole tudo → Run. Pode rodar por cima da v2.
-- ============================================================================

create or replace function vc_ts_ou_nulo(txt text)
returns timestamptz
language plpgsql
immutable
as $$
begin
  if txt is null or txt = '' then
    return null;
  end if;
  return txt::timestamptz;
exception when others then
  return null;
end;
$$;

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
  if new.id like 'hist:%' then
    return new;
  end if;

  upd_velho := vc_ts_ou_nulo(old.dados->>'updated_at');
  upd_novo  := vc_ts_ou_nulo(new.dados->>'updated_at');

  if upd_velho is null or upd_novo is null then
    return new;
  end if;

  -- Restaurar versão antiga traz o updated_at antigo junto: decisão deliberada.
  if upd_novo <= upd_velho then
    return new;
  end if;

  foreach carimbo in array array['status_at', 'status2_at', 'prod_at', 'prod2_at', 'est_at']
  loop
    velho_ts := vc_ts_ou_nulo(old.dados->>carimbo);
    novo_ts  := vc_ts_ou_nulo(new.dados->>carimbo);

    -- Regra da v2: carimbo andando para trás.
    if velho_ts is not null and novo_ts is not null and novo_ts < velho_ts then
      raise exception
        'vc_modelos[%]: escrita recusada — % voltaria de % para %. Tela desatualizada: recarregue o painel (Ctrl+F5) nesse aparelho.',
        new.id, carimbo, velho_ts, novo_ts
        using errcode = '23514';
    end if;

    -- Regra nova: carimbo que muda (inclusive saindo do vazio) tem que ser recente.
    if novo_ts is not null
       and novo_ts is distinct from velho_ts
       and novo_ts < upd_velho - interval '10 minutes' then
      raise exception
        'vc_modelos[%]: escrita recusada — % chegaria com data velha (%), anterior à última gravação (%). Tela desatualizada: recarregue o painel (Ctrl+F5) nesse aparelho.',
        new.id, carimbo, novo_ts, upd_velho
        using errcode = '23514';
    end if;
  end loop;

  return new;
end;
$$;

-- Nome com "0" para rodar ANTES do trg_vc_modelos_grade_velha (ordem alfabética).
drop trigger if exists trg_vc_modelos_sem_escrita_atrasada on vc_modelos;
drop trigger if exists trg_vc_modelos_0_sem_escrita_atrasada on vc_modelos;
create trigger trg_vc_modelos_0_sem_escrita_atrasada
  before update on vc_modelos
  for each row
  execute function vc_bloqueia_escrita_atrasada();
