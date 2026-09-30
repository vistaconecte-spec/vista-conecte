// Mesclagem velha da fila (30/09/2026): aparelho que ficou dias com a tela aberta subiu a grade de dias antes.
// Agora a fila tem validade e a grade inteira não sobe se a nuvem mudou depois dela.
import { readFileSync } from 'node:fs';
const main = readFileSync('C:/Users/barba/OneDrive/Desktop/vista-conecte/main.js', 'utf8').replace(/\r\n/g, '\n');
const pedaco = (ini, fim) => { const a = main.indexOf(ini), b = main.indexOf(fim, a); if (a < 0 || b < 0) throw new Error(ini); return main.slice(a, b); };
const fonte = [
  pedaco("const HIST_PREFIXO = 'hist:';", 'const HIST_MAX'),
  pedaco('async function carregarNuvem(key)', 'async function carregarTodosNuvem'),
  pedaco('async function salvarNuvemREST', 'function showCloudOk'),
  pedaco('let estEditado', '// Salva estado atual no localStorage'),
  pedaco('function mesclarModelo(nuvem, dom, tocado)', 'function salvarModelo() {'),
].join('\n');
let leituraFalha = true; const nuvem = {}; const posts = [];
const fetchFalso = async (url, opt = {}) => {
  if ((opt.method || 'GET') === 'POST') { const b = JSON.parse(opt.body); posts.push(b.dados); nuvem[b.id] = b.dados; return { ok: true, status: 200 }; }
  if (leituraFalha) throw new Error('rede');
  const m = /id=eq\.([^&]+)/.exec(url); const id = decodeURIComponent(m[1]);
  return { ok: true, status: 200, json: async () => (nuvem[id] ? [{ dados: nuvem[id] }] : []) };
};
const store = new Map();
const ctx = { SUPABASE_URL: 'https://x', SUPABASE_KEY: 'k', fetch: fetchFalso,
  saveLocal: (k, v) => store.set(k, JSON.stringify(v)), loadLocal: k => (store.has(k) ? JSON.parse(store.get(k)) : null),
  showCloudOk: () => {}, showCloudError: () => {}, renderModelo: () => {}, renderDashboard: () => {}, renderModeloSeOcioso: () => {},
  registrarVersao: () => {}, MODELOS: {}, modeloAtual: 'x' };
const api = new Function('ctx', `const { SUPABASE_URL, SUPABASE_KEY, fetch, saveLocal, loadLocal, showCloudOk, showCloudError, renderModelo, renderDashboard, renderModeloSeOcioso, registrarVersao, MODELOS } = ctx; let modeloAtual = ctx.modeloAtual;
  async function salvarNuvem(key, dados, opts) { await salvarNuvemREST(key, dados, opts); }
  ${fonte}
  return { mesclagemVencida, subirModeloMesclado, reenviarPendentes, protegidoDeSobrescrita, gravarModeloNaNuvem, pend: _mesclagensPendentes, fila: _gravacoesPendentes };`)(ctx);

let falhas = 0; const ok = (n, a, b) => { const p = JSON.stringify(a) === JSON.stringify(b); if (!p) falhas++; console.log((p ? '  ✓ ' : '  ✗ ') + n, p ? '' : JSON.stringify(a)); };
const KEY = 'calca';
nuvem[KEY] = { est: { Preto: [1, 1, 1] }, prod: { Cinza: [4, 9, 8] }, status: 'Em corte', status_at: 'hoje', cores: ['Preto', 'Cinza', 'Marrom'] };
const K = 'macacao-amplo';
const vazio = () => ({ est: new Set(), prod: new Set(), prod2: new Set(), cfg: false, status: false, cores: false });

console.log('1) grade inteira da fila, nuvem mudou depois: não sobe');
nuvem[K] = { prod: { Preto: [1, 2, 2, 1, 3] }, updated_at: new Date().toISOString() };
const velha = { prod: { Preto: [0, 3, 3, 2, 2] } };
const t1 = vazio(); t1.prod.add('*');
leituraFalha = true;
await api.subirModeloMesclado(K, velha, t1, Date.now() - 60000);
ok('ficou na fila', api.pend.has(K), true);
leituraFalha = false;
nuvem[K].updated_at = new Date().toISOString();
const n1 = posts.length;
await api.reenviarPendentes();
ok('nada gravado', posts.length - n1, 0);
ok('a leva certa ficou', nuvem[K].prod.Preto, [1, 2, 2, 1, 3]);
ok('a fila esvaziou', api.pend.has(K), false);

console.log('2) célula digitada há mais de 10 min: não sobe');
const t2 = vazio(); t2.prod.add('Preto|0');
leituraFalha = true;
await api.subirModeloMesclado(K, { prod: { Preto: [9, 0, 0, 0, 0] } }, t2, Date.now() - 11 * 60000);
leituraFalha = false;
await api.reenviarPendentes();
ok('PP continua 1', nuvem[K].prod.Preto[0], 1);

console.log('3) célula digitada agora, rede volta logo: sobe normal');
const t3 = vazio(); t3.prod.add('Preto|0');
leituraFalha = true;
await api.subirModeloMesclado(K, { prod: { Preto: [2, 0, 0, 0, 0] } }, t3);
leituraFalha = false;
await api.reenviarPendentes();
ok('PP virou 2 e o resto ficou', nuvem[K].prod.Preto, [2, 2, 2, 1, 3]);

console.log('4) regra pura');
const agora = Date.parse('2026-09-30T12:00:00Z'), tt = vazio(); tt.prod.add('*');
ok('sem desde = gravação da hora', api.mesclagemVencida(0, tt, { updated_at: '2026-09-30T13:00:00Z' }, agora), false);
ok('grade inteira + nuvem mais nova', api.mesclagemVencida(agora - 1000, tt, { updated_at: '2026-09-30T12:00:00Z' }, agora), true);
ok('grade inteira + nuvem mais velha', api.mesclagemVencida(agora - 1000, tt, { updated_at: '2026-09-30T11:00:00Z' }, agora), false);

if (falhas) { console.log(`\n${falhas} FALHA(S)`); process.exit(1); } else console.log('\nOK');
