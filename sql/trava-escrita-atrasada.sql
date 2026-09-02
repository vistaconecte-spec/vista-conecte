-- ============================================================================
-- TRAVA CONTRA ESCRITA ATRASADA  —  vc_modelos          (versão 2 — 02/09/2026)
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
-- O QUE MUDOU NA VERSÃO 2
--
-- A v1 quebrava numa linha real: o `conjunto-peace` tinha `updated_at` gravado
-- como NÚMERO (1787343044041) em vez de data. A conversão estourava e o banco
-- recusava QUALQUER gravação naquele modelo — trava boa virando defeito. Agora
-- todo carimbo passa por `vc_ts_ou_nulo`, que devolve NULL quando o valor não é
-- uma data legível. Carimbo ilegível = desconhecido = não bloqueia nada. A trava
-- só age quando tem certeza, que é como uma trava tem que se comportar.
--
-- COMO APLICAR
--   Supabase → SQL Editor → cole tudo → Run.  Pode rodar por cima da v1.
--   Para remover: DROP TRIGGER trg_vc_modelos_sem_escrita_atrasada ON vc_modelos;
-- ============================================================================

-- Converte texto em data SEM estourar: valor ilegível vira NULL.
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
  return null;   -- número solto, texto qualquer, data fora de faixa: desconhecido
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
  -- Histórico não entra: ele guarda versões antigas de propósito.
  if new.id like 'hist:%' then
    return new;
  end if;

  upd_velho := vc_ts_ou_nulo(old.dados->>'updated_at');
  upd_novo  := vc_ts_ou_nulo(new.dados->>'updated_at');

  -- Sem updated_at legível nos dois lados não dá para saber a ordem: deixa passar.
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
    velho_ts := vc_ts_ou_nulo(old.dados->>carimbo);
    novo_ts  := vc_ts_ou_nulo(new.dados->>carimbo);

    -- NULL é fim de rodada (o app zera o carimbo de propósito) ou valor ilegível:
    -- nos dois casos não há regressão comprovada, então não bloqueia.
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
