/**
 * Teste do ciclo de sincronização (sincronizarNuvem) contra o egress.
 *
 * POR QUE ISTO EXISTE: em 08/09/2026 o Supabase bloqueou o projeto por exceder a cota de
 * egress do plano Free — a Vi do WhatsApp e este painel pararam juntos. O ciclo de 15 s
 * baixava a tabela inteira (~5,8 MB, 95% linhas `hist:*`) por aba aberta. O ciclo agora
 * precisa: (1) nunca pedir histórico; (2) depois da primeira leitura, pedir só o que mudou
 * (`updated_at=gt.<última vista>`); (3) não avançar a marca d'água quando pulou uma linha
 * protegida, para ela voltar no próximo ciclo.
 *
 * Rodar:  node tests/sync-egress.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

const pedaco = (ini, fim) => {
  const a = main.indexOf(ini);
  const b = main.indexOf(fim, a);
  if (a < 0 || b < 0) throw new Error('trecho não encontrado: ' + ini);
  return main.slice(a, b);
};
const fonte = [
  pedaco("const HIST_PREFIXO = 'hist:';", 'const HIST_MAX'),
  pedaco('function ehChaveHistorico', 'async function registrarVersao'),
  pedaco('let estEditado', '// Salva estado atual no localStorage'),
  pedaco('async function salvarNuvemREST', 'function showCloudOk'),
  pedaco('let _syncDesde', '// ─────────────────────────────────────────────────────────────────────────────\n\nconst fmt'),
].join('\n');

function montar() {
  const store = new Map();
  const urls = [];
  let nuvem = []; // linhas que a nuvem devolve: {id, dados, updated_at}
  let protegidos = new Set();
  const fetchFalso = async (url) => {
    urls.push(url);
    const u = new URL(url);
    const desde = (u.searchParams.get('updated_at') || '').replace(/^gt\./, '');
    const semHist = (u.searchParams.get('id') || '').startsWith('not.like.hist:');
    const rows = nuvem
      .filter(r => !(semHist && r.id.startsWith('hist:')))
      .filter(r => !desde || r.updated_at > desde);
    return { ok: true, status: 200, json: async () => rows };
  };
  const ctx = {
    SUPABASE_URL: 'https://x', SUPABASE_KEY: 'k', fetch: fetchFalso,
    saveLocal: (k, v) => store.set(k, JSON.stringify(v)),
    loadLocal: k => (store.has(k) ? JSON.parse(store.get(k)) : null),
    showCloudOk: () => {}, showCloudError: () => {},
    renderModelo: () => {}, renderDashboard: () => {}, renderModeloSeOcioso: () => {},
    modeloAtual: '__dashboard__',
    protegido: id => protegidos.has(id),
  };
  const api = new Function('ctx', `
    const { SUPABASE_URL, SUPABASE_KEY, fetch, saveLocal, loadLocal,
            showCloudOk, showCloudError, renderModelo, renderDashboard, renderModeloSeOcioso } = ctx;
    let modeloAtual = ctx.modeloAtual;
    ${fonte}
    protegidoDeSobrescrita = ctx.protegido;
    return { sincronizarNuvem, desde: () => _syncDesde };
  `)(ctx);
  return { api, store, urls, nuvem: v => (nuvem = v), proteger: ids => (protegidos = new Set(ids)) };
}

const T1 = '2026-09-09T10:00:00.000000+00:00';
const T2 = '2026-09-09T10:05:00.000000+00:00';
const T3 = '2026-09-09T10:10:00.000000+00:00';

console.log('\n1) Primeira leitura: sem histórico, sem filtro de data, aplica tudo');
{
  const lab = montar();
  lab.nuvem([
    { id: 'calca-flare', dados: { est: 1 }, updated_at: T1 },
    { id: 'hist:calca-flare', dados: { v: [] }, updated_at: T2 },
    { id: 'financeiro', dados: { x: 1 }, updated_at: T2 },
  ]);
  await lab.api.sincronizarNuvem();
  const u = new URL(lab.urls[0]);
  ok('pede id=not.like.hist:*', u.searchParams.get('id'), 'not.like.hist:*');
  ok('sem filtro de updated_at na primeira leitura', u.searchParams.get('updated_at'), null);
  ok('select inclui updated_at', u.searchParams.get('select'), 'id,dados,updated_at');
  ok('aplicou as linhas de tela', [lab.store.has('vc:calca-flare'), lab.store.has('vc:financeiro')], [true, true]);
  ok('histórico nunca entra no local', lab.store.has('vc:hist:calca-flare'), false);
  ok('marca d\'água = updated_at mais novo aplicado', lab.api.desde(), T2);
}

console.log('\n2) Segunda leitura: só pede o que mudou depois da marca d\'água');
{
  const lab = montar();
  lab.nuvem([{ id: 'calca-flare', dados: { est: 1 }, updated_at: T1 }]);
  await lab.api.sincronizarNuvem();
  lab.nuvem([
    { id: 'calca-flare', dados: { est: 1 }, updated_at: T1 },
    { id: 'cropped', dados: { est: 5 }, updated_at: T3 },
  ]);
  await lab.api.sincronizarNuvem();
  const u = new URL(lab.urls[1]);
  ok('filtro updated_at=gt.<marca>', u.searchParams.get('updated_at'), 'gt.' + T1);
  ok('linha nova aplicada', JSON.parse(lab.store.get('vc:cropped')), { est: 5 });
  ok('marca d\'água avançou', lab.api.desde(), T3);
}

console.log('\n3) Linha protegida (edição pendente): não avança a marca d\'água, volta no próximo ciclo');
{
  const lab = montar();
  lab.nuvem([{ id: 'calca-flare', dados: { est: 1 }, updated_at: T1 }]);
  await lab.api.sincronizarNuvem();
  lab.proteger(['cropped']);
  lab.nuvem([
    { id: 'calca-flare', dados: { est: 1 }, updated_at: T1 },
    { id: 'cropped', dados: { est: 5 }, updated_at: T2 },
    { id: 'financeiro', dados: { x: 2 }, updated_at: T3 },
  ]);
  await lab.api.sincronizarNuvem();
  ok('não sobrescreveu a protegida', lab.store.has('vc:cropped'), false);
  ok('aplicou a não protegida', JSON.parse(lab.store.get('vc:financeiro')), { x: 2 });
  ok('marca d\'água ficou onde estava', lab.api.desde(), T1);
  lab.proteger([]);
  await lab.api.sincronizarNuvem();
  ok('ciclo seguinte trouxe e aplicou a que estava protegida', JSON.parse(lab.store.get('vc:cropped')), { est: 5 });
  ok('agora a marca d\'água avança', lab.api.desde(), T3);
}

console.log(`\n${total - falhas}/${total} ok`);
if (falhas) process.exit(1);
