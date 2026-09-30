-- Trava no banco contra tela velha (30/09/2026).
-- Um aparelho com a tela aberta havia dias gravou a grade do Macacão Amplo de 23/09 por cima
-- da de 29/09. O app novo já descarta isso, mas aba antiga continua rodando o código velho
-- até recarregar. Esta trava vale para qualquer aparelho: se a grade (est, prod, prod2) que
-- chega é diferente da gravada E o carimbo dela (est_at, prod_at, prod2_at) é mais de 10 min
-- mais velho que o gravado, o banco mantém a grade que estava. O resto da gravação passa.
create or replace function vc_modelos_grade_velha() returns trigger
language plpgsql as $$
declare
  par text[];
  campo text; carimbo text;
  novo_at timestamptz; velho_at timestamptz;
begin
  if new.id like 'hist:%' or old.dados is null or new.dados is null then
    return new;
  end if;
  foreach par slice 1 in array array[['est','est_at'],['prod','prod_at'],['prod2','prod2_at']] loop
    campo := par[1]; carimbo := par[2];
    if (new.dados -> campo) is distinct from (old.dados -> campo)
       and (new.dados ->> carimbo) is not null and (old.dados ->> carimbo) is not null then
      begin
        novo_at  := (new.dados ->> carimbo)::timestamptz;
        velho_at := (old.dados ->> carimbo)::timestamptz;
      exception when others then
        continue;
      end;
      if novo_at < velho_at - interval '10 minutes' then
        new.dados := jsonb_set(new.dados, array[campo], old.dados -> campo, true);
        new.dados := jsonb_set(new.dados, array[carimbo], old.dados -> carimbo, true);
        raise warning 'vc_modelos %: % velho (% < %) mantido o gravado', new.id, campo, novo_at, velho_at;
      end if;
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists trg_vc_modelos_grade_velha on vc_modelos;
create trigger trg_vc_modelos_grade_velha
  before update on vc_modelos
  for each row execute function vc_modelos_grade_velha();
