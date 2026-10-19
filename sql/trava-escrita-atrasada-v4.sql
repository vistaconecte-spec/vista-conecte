-- ============================================================================
-- TRAVA CONTRA ESCRITA ATRASADA  —  vc_modelos          (versão 4 — 19/10/2026)
-- ============================================================================
-- POR QUE A V4
--
-- Em 16/10/2026, 18:15 UTC, um aparelho com a tela aberta desde 14/10 aplicou
-- cinco envios atrasados e gravou junto o Macacão Amplo, a Pantalona Viscolycra,
-- o Cropped Canelado e a Bolso Frontal como estavam no dia 14: a leva 2 "Em
-- corte" sumiu (prod2 e status2 apagados, leva2=false), a leva 1 perdeu o "Em
-- corte" e o estoque voltou para antes do "Tudo para o estoque" das 11h41. O
-- corte caiu de 157 para 99 peças com o cortador já na mesa.
--
-- Três furos deixaram passar:
--
--   1. A V3 NUNCA FOI APLICADA. O banco devolvia, em 19/10, a mensagem da v2. Na
--      v2 o gatilho se chama trg_vc_modelos_sem_escrita_atrasada e roda DEPOIS do
--      trg_vc_modelos_grade_velha (ordem alfabética): a trava de grade trocava o
--      prod_at velho pelo gravado e a v2 já não via carimbo voltando. Com a v3 no
--      lugar, o prod_at de 06/10 do Macacão teria sido recusado.
--   2. O QUE SOME NÃO TEM CARIMBO. O Macacão velho nem tinha prod2, status2 nem
--      prod2_at. Nenhuma regra olhava campo que desaparece.
--   3. ESTOQUE VELHO COM CARIMBO NOVO. A baixa carimba est_at com a hora de agora,
--      então o estoque de 14/10 entrou como se fosse de hoje.
--
-- A REGRA, EM DUAS PARTES
--
-- (a) PROVA DE LEITURA. Desde 19/10/2026 o app manda em `dados.lido_at` o
--     updated_at da LINHA que ele leu antes de gravar (é a coluna do servidor,
--     não um carimbo do aparelho). Se for igual ao updated_at atual da linha,
--     o aparelho comprovadamente partiu da versão de agora: tudo o que ele manda
--     é decisão de alguém e passa (inclusive tirar status, apagar a 2ª leva,
--     restaurar versão antiga). O campo é tirado antes de gravar.
--
-- (b) SEM PROVA (aba antiga, script, ou leitura que já mudou na nuvem), a
--     gravação é RECUSADA INTEIRA (código 23514; o app traz a nuvem e avisa) se:
--       • um carimbo volta no tempo                                   (v2)
--       • um carimbo muda para uma data > 10 min antes da última gravação (v3)
--       • prod_at, prod2_at ou est_at somem, ou a grade est/prod/prod2 some
--         tendo peças                                                  (nova)
--       • status/status2 trocam e o carimbo da etapa gravada é mais novo que
--         o que chega (ou o que chega vem sem carimbo)                 (nova)
--       • leva2 desliga com a 2ª leva tendo peças ou etapa             (nova)
--       • o estoque muda em mais de uma célula, ou alguma célula SOBE  (nova)
--         (uma baixa é uma célula descendo; contagem, "Tudo para o
--         estoque" e restauração vêm do app novo, com prova de leitura)
--
-- Só vale para linhas de MODELO (as que têm est ou prod). Financeiro, registro
-- de baixas, cartão barrado, notas do Bling, histórico etc. passam direto.
--
-- O QUE PRECISA ESTAR NO AR ANTES DE APLICAR
--   O app com lido_at (commit de 19/10/2026, ?v=2026101901 ou mais novo) e as
--   abas recarregadas. Aba antiga que mudar estoque ou etapa vai ser recusada
--   e avisada para recarregar; é o comportamento desejado.
--   Scripts que gravam modelo (compra-semanal, levas-para-corte, pilotos-costura)
--   mandam lido_at = updated_at lido desde 19/10/2026.
--
-- COMO APLICAR
--   Supabase → SQL Editor → cole tudo → Run. Pode rodar por cima da v2 e da v3.
--   A trava de grade (sql/trava-grade-velha.sql) continua valendo, depois desta.
-- COMO DESFAZER
--   Rodar de novo sql/trava-escrita-atrasada.sql (v2).
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

-- Grade com alguma peça (> 0)? Serve para est, prod e prod2.
create or replace function vc_grade_tem_pecas(g jsonb)
returns boolean
language sql
immutable
as $$
  select coalesce(jsonb_typeof(g) = 'object' and exists (
    select 1
    from jsonb_each(g) as c(cor, v)
    cross join lateral jsonb_array_elements(case when jsonb_typeof(c.v) = 'array' then c.v else '[]'::jsonb end) as x(n)
    where jsonb_typeof(x.n) = 'number' and (x.n)::text::numeric > 0
  ), false);
$$;

-- Quantas células de estoque mudam de `velho` para `novo`, e se alguma SOBE.
create or replace function vc_est_diferenca(velho jsonb, novo jsonb, out celulas int, out subiu boolean)
language plpgsql
immutable
as $$
declare
  cor text;
  a jsonb; b jsonb;
  i int; n int;
  x numeric; y numeric;
begin
  celulas := 0; subiu := false;
  velho := coalesce(velho, '{}'::jsonb);
  novo  := coalesce(novo,  '{}'::jsonb);
  if jsonb_typeof(velho) <> 'object' or jsonb_typeof(novo) <> 'object' then
    if velho is distinct from novo then celulas := 99; subiu := true; end if;
    return;
  end if;
  for cor in select k from jsonb_object_keys(velho) as k union select k from jsonb_object_keys(novo) as k loop
    a := coalesce(velho -> cor, '[]'::jsonb);
    b := coalesce(novo  -> cor, '[]'::jsonb);
    if jsonb_typeof(a) <> 'array' or jsonb_typeof(b) <> 'array' then
      if a is distinct from b then celulas := celulas + 1; subiu := true; end if;
      continue;
    end if;
    n := greatest(jsonb_array_length(a), jsonb_array_length(b));
    for i in 0 .. n - 1 loop
      x := case when jsonb_typeof(a -> i) = 'number' then (a ->> i)::numeric else 0 end;
      y := case when jsonb_typeof(b -> i) = 'number' then (b ->> i)::numeric else 0 end;
      if x <> y then
        celulas := celulas + 1;
        if y > x then subiu := true; end if;
      end if;
    end loop;
  end loop;
end;
$$;

create or replace function vc_bloqueia_escrita_atrasada()
returns trigger
language plpgsql
as $$
declare
  lido      timestamptz;
  carimbo   text;
  campo     text;
  par       text[];
  velho_ts  timestamptz;
  novo_ts   timestamptz;
  upd_velho timestamptz;
  dif       record;
  fim       constant text := ' Tela desatualizada: recarregue o painel (Ctrl+F5) nesse aparelho.';
begin
  if new.id like 'hist:%' or old.dados is null or new.dados is null
     or jsonb_typeof(old.dados) <> 'object' or jsonb_typeof(new.dados) <> 'object' then
    return new;
  end if;

  -- (a) Prova de leitura: sai do documento sempre, e libera se for a linha de agora.
  lido := vc_ts_ou_nulo(new.dados ->> 'lido_at');
  new.dados := new.dados - 'lido_at';
  if lido is not null and lido = old.updated_at then
    return new;
  end if;

  -- Só linhas de modelo.
  if not (old.dados ? 'est' or old.dados ? 'prod') then
    return new;
  end if;

  upd_velho := vc_ts_ou_nulo(old.dados ->> 'updated_at');

  -- (b1) carimbos: voltando no tempo (v2) ou mudando para data velha (v3)
  foreach carimbo in array array['status_at', 'status2_at', 'prod_at', 'prod2_at', 'est_at'] loop
    velho_ts := vc_ts_ou_nulo(old.dados ->> carimbo);
    novo_ts  := vc_ts_ou_nulo(new.dados ->> carimbo);
    if velho_ts is not null and novo_ts is not null and novo_ts < velho_ts then
      raise exception 'vc_modelos[%]: escrita recusada — % voltaria de % para %.%',
        new.id, carimbo, velho_ts, novo_ts, fim using errcode = '23514';
    end if;
    if upd_velho is not null and novo_ts is not null and novo_ts is distinct from velho_ts
       and novo_ts < upd_velho - interval '10 minutes' then
      raise exception 'vc_modelos[%]: escrita recusada — % chegaria com data velha (%), anterior à última gravação (%).%',
        new.id, carimbo, novo_ts, upd_velho, fim using errcode = '23514';
    end if;
  end loop;

  -- (b2) carimbo de grade que some (status_at pode virar vazio: é o fim de rodada)
  foreach carimbo in array array['prod_at', 'prod2_at', 'est_at'] loop
    if vc_ts_ou_nulo(old.dados ->> carimbo) is not null and vc_ts_ou_nulo(new.dados ->> carimbo) is null then
      raise exception 'vc_modelos[%]: escrita recusada — % sumiria (era %).%',
        new.id, carimbo, old.dados ->> carimbo, fim using errcode = '23514';
    end if;
  end loop;

  -- (b3) grade que some tendo peças
  foreach campo in array array['est', 'prod', 'prod2'] loop
    if vc_grade_tem_pecas(old.dados -> campo) and jsonb_typeof(new.dados -> campo) is distinct from 'object' then
      raise exception 'vc_modelos[%]: escrita recusada — a grade % sumiria com peças dentro.%',
        new.id, campo, fim using errcode = '23514';
    end if;
  end loop;

  -- (b4) etapa trocada por quem não viu a etapa de agora
  foreach par slice 1 in array array[['status', 'status_at'], ['status2', 'status2_at']] loop
    if coalesce(new.dados ->> par[1], '') is distinct from coalesce(old.dados ->> par[1], '') then
      velho_ts := vc_ts_ou_nulo(old.dados ->> par[2]);
      novo_ts  := vc_ts_ou_nulo(new.dados ->> par[2]);
      if velho_ts is not null and (novo_ts is null or novo_ts <= velho_ts) then
        raise exception 'vc_modelos[%]: escrita recusada — % passaria de "%" (de %) para "%" sem ter visto essa etapa.%',
          new.id, par[1], old.dados ->> par[1], velho_ts, coalesce(new.dados ->> par[1], ''), fim using errcode = '23514';
      end if;
    end if;
  end loop;

  -- (b5) 2ª leva desligada com coisa dentro
  if coalesce(old.dados ->> 'leva2', '') = 'true' and coalesce(new.dados ->> 'leva2', '') <> 'true'
     and (coalesce(old.dados ->> 'status2', '') <> '' or vc_grade_tem_pecas(old.dados -> 'prod2')) then
    raise exception 'vc_modelos[%]: escrita recusada — a 2ª leva (%) seria desligada.%',
      new.id, coalesce(nullif(old.dados ->> 'status2', ''), 'com peças'), fim using errcode = '23514';
  end if;

  -- (b6) estoque: sem prova de leitura, só passa uma baixa (uma célula descendo)
  if (new.dados -> 'est') is distinct from (old.dados -> 'est') then
    select * into dif from vc_est_diferenca(old.dados -> 'est', new.dados -> 'est');
    if dif.celulas > 1 or dif.subiu then
      raise exception 'vc_modelos[%]: escrita recusada — o estoque mudaria em % célula(s)% sem prova de que a linha lida é a de agora.%',
        new.id, dif.celulas, case when dif.subiu then ', com peça voltando' else '' end, fim using errcode = '23514';
    end if;
  end if;

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
