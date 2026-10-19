// Teste da trava v4 (sql/trava-escrita-atrasada-v4.sql) num Postgres em memória, sem tocar
// no Supabase. Monta a vc_modelos com o carimbo de updated_at do servidor (como o
// trg_vc_modelos_touch), a trava de grade e a v4, e confere: o caso de 16/10 é recusado e o
// que o app faz no dia a dia continua passando.
//
// Rodar (fora da suíte do npm test, precisa do PGlite):
//   npm i --no-save @electric-sql/pglite@0.2.17 && node sql/testar-trava-v4.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pasta = dirname(fileURLToPath(import.meta.url));
const db = new PGlite();
await db.exec(`create table vc_modelos (id text primary key, dados jsonb, updated_at timestamptz default now());
create or replace function vc_touch() returns trigger language plpgsql as $$ begin new.updated_at := clock_timestamp(); return new; end $$;
create trigger trg_vc_modelos_touch before update on vc_modelos for each row execute function vc_touch();`);
await db.exec(readFileSync(join(pasta, 'trava-grade-velha.sql'), 'utf8'));
await db.exec(readFileSync(join(pasta, 'trava-escrita-atrasada-v4.sql'), 'utf8'));

const agora = () => new Date().toISOString();
const linha = async id => (await db.query('select dados, updated_at from vc_modelos where id = $1', [id])).rows[0];
const lidoDe = async id => { const r = (await db.query(`select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') as em from vc_modelos where id = $1`, [id])).rows[0]; return r.em; };
const criar = async (id, dados) => { await db.query('delete from vc_modelos where id = $1', [id]); await db.query('insert into vc_modelos (id, dados) values ($1, $2)', [id, dados]); };
// Igual ao app: upsert merge-duplicates (troca a coluna dados inteira)
const gravar = async (id, dados) => {
  try { await db.query('insert into vc_modelos (id, dados) values ($1, $2) on conflict (id) do update set dados = excluded.dados', [id, dados]); return 'passou'; }
  catch (e) { return e.code === '23514' ? 'recusada' : 'ERRO ' + e.message; }
};

let falhas = 0; const ok = (n, a, b) => { const p = JSON.stringify(a) === JSON.stringify(b); if (!p) falhas++; console.log((p ? '  ✓ ' : '  ✗ ') + n, p ? '' : '\n      obtido: ' + JSON.stringify(a) + '  esperado: ' + JSON.stringify(b)); };
const clone = x => JSON.parse(JSON.stringify(x));

// Macacão Amplo às 18:14 de 16/10 (como na nuvem) e o retrato de 14/10 do aparelho velho
const certo = () => ({
  nome: 'Macacão Amplo',
  est: { Preto: [2, 1, 3, 1, 1], Marrom: [1, 2, 2, 0, 1] }, est_at: '2026-10-16T14:41:17.114Z',
  prod: { Preto: [0, 0, 0, 0, 0], Marrom: [0, 0, 0, 0, 0] }, prod_at: '2026-10-16T14:41:17.114Z',
  status: 'Em corte', status_at: '2026-10-16T15:38:59.948Z',
  leva2: true, prod2: { Preto: [1, 3, 3, 2, 1], Marrom: [0, 2, 3, 1, 0] }, prod2_at: '2026-10-16T15:38:59.948Z',
  status2: 'Em corte', status2_at: '2026-10-16T15:38:59.948Z',
  updated_at: agora(),
});
const velho14 = () => ({
  nome: 'Macacão Amplo',
  est: { Preto: [2, 0, 0, 1, 0], Marrom: [1, 2, 0, 0, 1] }, est_at: '2026-10-14T21:20:57.621Z',
  prod: { Preto: [1, 1, 1, 0, 1], Marrom: [0, 0, 0, 0, 0] }, prod_at: '2026-10-06T11:42:17.774Z',
  status: 'Em costura', status_at: '2026-10-08T20:48:29.075Z', leva2: false,
  updated_at: '2026-10-14T21:20:57.621Z',
});
const M = 'macacao-amplo';

console.log('1) O caso de 16/10: baixa de aparelho com o retrato de 14/10');
await criar(M, certo());
{ const d = velho14(); d.est.Preto[0] = 1; d.est_at = d.updated_at = agora(); ok('recusada', await gravar(M, d), 'recusada'); }
ok('a leva 2 continua Em corte com 20 peças', [(await linha(M)).dados.status2, (await linha(M)).dados.leva2], ['Em corte', true]);
{ // mesmo com carimbos "consertados", o que some e o estoque velho seguram
  const d = velho14(); d.est.Preto[0] = 1; const t = agora();
  Object.assign(d, { est_at: t, updated_at: t, prod_at: t, status_at: t });
  ok('sem prod2/status2/leva2 e com carimbos novos: recusada', await gravar(M, d), 'recusada');
}
{ const d = certo(); d.updated_at = agora(); delete d.prod2; delete d.prod2_at; delete d.status2; delete d.status2_at; d.leva2 = false;
  ok('só a 2ª leva some (resto certo): recusada', await gravar(M, d), 'recusada'); }
{ const d = certo(); d.updated_at = agora(); d.status = ''; d.status_at = null;
  ok('só o "Em corte" da leva 1 some: recusada', await gravar(M, d), 'recusada'); }
{ const d = certo(); d.updated_at = d.est_at = agora(); d.est = velho14().est;
  ok('estoque volta para o de antes, carimbo novo: recusada', await gravar(M, d), 'recusada'); }

console.log('2) Quem prova que leu a linha de agora passa (app desde 19/10)');
await criar(M, certo());
{ const d = clone((await linha(M)).dados); d.lido_at = await lidoDe(M); d.updated_at = agora();
  delete d.prod2; delete d.status2; delete d.status2_at; delete d.prod2_at; d.leva2 = false;
  ok('Remover 2ª leva', await gravar(M, d), 'passou');
  ok('o lido_at não fica gravado', 'lido_at' in (await linha(M)).dados, false); }
await criar(M, certo());
{ const d = clone((await linha(M)).dados); d.lido_at = await lidoDe(M); d.updated_at = agora(); d.status = ''; d.status_at = null;
  ok('"— Sem status —" no dropdown', await gravar(M, d), 'passou'); }
await criar(M, certo());
{ const d = clone((await linha(M)).dados); d.lido_at = await lidoDe(M); const t = agora();
  d.est.Preto = d.est.Preto.map((v, i) => v + d.prod2.Preto[i]); d.prod2.Preto = [0, 0, 0, 0, 0];
  Object.assign(d, { status2: '', status2_at: null, prod2_at: t, est_at: t, updated_at: t });
  ok('"→ Estoque" da 2ª leva (várias células sobem)', await gravar(M, d), 'passou'); }
await criar(M, certo());
{ const d = clone((await linha(M)).dados); d.lido_at = await lidoDe(M); d.est.Preto = [5, 5, 5, 5, 5]; d.est.Marrom = [0, 0, 0, 0, 0]; d.est_at = d.updated_at = agora();
  ok('contagem da arara (várias células)', await gravar(M, d), 'passou'); }
await criar(M, certo());
{ const d = velho14(); d.lido_at = await lidoDe(M); d.updated_at = agora(); const t = agora(); d.est_at = d.prod_at = t;
  ok('restaurar versão antiga (decisão dela, lida a linha de agora)', await gravar(M, d), 'passou'); }

console.log('3) Prova de leitura que já mudou na nuvem vale como sem prova');
await criar(M, certo());
{ const lido = await lidoDe(M);
  const outro = clone((await linha(M)).dados); outro.est.Marrom[0] = 0; outro.est_at = outro.updated_at = agora(); await gravar(M, outro); // outro aparelho baixa uma peça
  const d = clone((await linha(M)).dados); d.lido_at = lido; d.updated_at = agora(); d.status = ''; d.status_at = null;
  ok('tirar status com leitura de antes de outra gravação: recusada (o app relê e refaz)', await gravar(M, d), 'recusada'); }

console.log('4) Sem prova, o que não é estrago continua passando (aba antiga, scripts)');
await criar(M, certo());
{ const d = clone((await linha(M)).dados); d.est.Preto[2] = 2; d.est_at = d.updated_at = agora();
  ok('baixa de uma peça (uma célula descendo)', await gravar(M, d), 'passou'); }
{ const d = clone((await linha(M)).dados); d.est.Preto[2] = 1; d.est.Preto[3] = 0; d.est_at = d.updated_at = agora();
  ok('duas células de uma vez: recusada', await gravar(M, d), 'recusada'); }
{ const d = clone((await linha(M)).dados); d.est.Preto[4] = 9; d.est_at = d.updated_at = agora();
  ok('uma célula subindo: recusada', await gravar(M, d), 'recusada'); }
{ const d = clone((await linha(M)).dados); const t = agora(); d.status = 'Em costura'; d.status_at = t; d.updated_at = t;
  ok('levar a leva para "Em costura" (carimbo de agora): passa', await gravar(M, d), 'passou'); }
{ const d = clone((await linha(M)).dados); d.prazo = '2026-10-30'; d.updated_at = agora();
  ok('mudar prazo ou outra configuração: passa', await gravar(M, d), 'passou'); }
await criar('cropped-x', { est: { Preto: [1, 0, 0, 0, 0] }, prod: {}, status: '', status_at: null, updated_at: agora() });
{ const d = clone((await linha('cropped-x')).dados); d.status = 'Comprando tecido'; d.prod = { Preto: [0, 2, 2, 0, 0] }; d.prod_at = d.updated_at = agora();
  ok('compra semanal abre leva "Comprando tecido": passa', await gravar('cropped-x', d), 'passou'); }

console.log('5) Linhas que não são modelo ficam de fora');
await criar('cb:123', { status: 'aberto', updated_at: agora() });
ok('cartão barrado troca status', await gravar('cb:123', { status: 'resgatado' }), 'passou');
await criar('financeiro', { meses: { '2026-10': 1 }, updated_at: agora() });
ok('financeiro grava qualquer coisa', await gravar('financeiro', { meses: {} }), 'passou');
await criar('hist:macacao-amplo', { v: [1, 2, 3] });
ok('histórico grava qualquer coisa', await gravar('hist:macacao-amplo', { v: [] }), 'passou');

console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo');
process.exit(falhas ? 1 : 0);
