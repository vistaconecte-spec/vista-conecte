// Laboratório: leitura da nuvem falhando, gravação funcionando. Antes: a tela velha subia
// inteira. Agora: nada sobe até a leitura voltar; aí sobe mesclado.
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
  return { subirModeloMesclado, reenviarPendentes, protegidoDeSobrescrita, gravarModeloNaNuvem, pend: _mesclagensPendentes, fila: _gravacoesPendentes };`)(ctx);

let falhas = 0; const ok = (n, a, b) => { const p = JSON.stringify(a) === JSON.stringify(b); if (!p) falhas++; console.log((p ? '  ✓ ' : '  ✗ ') + n, p ? '' : JSON.stringify(a)); };
const KEY = 'calca';
nuvem[KEY] = { est: { Preto: [1, 1, 1] }, prod: { Cinza: [4, 9, 8] }, status: 'Em corte', status_at: 'hoje', cores: ['Preto', 'Cinza', 'Marrom'] };
const telaVelha = { est: { Preto: [1, 1, 5] }, prod: { Cinza: [2, 3, 6] }, status: 'Em corte', status_at: 'ontem', cores: ['Preto', 'Cinza'], prazo: 'p' };
const tocado = { est: new Set(['Preto|2']), prod: new Set(), prod2: new Set(), cfg: true, status: false, cores: false };

console.log('1) leitura falhando');
await api.subirModeloMesclado(KEY, telaVelha, tocado);
ok('nada foi gravado', posts.length, 0);
ok('a nuvem continua com a leva de 41', nuvem[KEY].prod.Cinza, [4, 9, 8]);
ok('a chave fica protegida', api.protegidoDeSobrescrita(KEY), true);
ok('e a mesclagem fica na fila', api.pend.has(KEY), true);

console.log('2) a rede volta e a fila roda');
leituraFalha = false;
await api.reenviarPendentes();
ok('agora gravou', posts.length, 1);
ok('a célula digitada entrou', nuvem[KEY].est.Preto, [1, 1, 5]);
ok('a leva da nuvem ficou inteira', nuvem[KEY].prod.Cinza, [4, 9, 8]);
ok('a cor que a tela velha não conhecia ficou', nuvem[KEY].cores, ['Preto', 'Cinza', 'Marrom']);
ok('o carimbo da etapa não voltou', nuvem[KEY].status_at, 'hoje');
ok('o prazo editado subiu', nuvem[KEY].prazo, 'p');
ok('a fila esvaziou', api.pend.has(KEY), false);

console.log('3) gravarModeloNaNuvem com a leitura falhando');
leituraFalha = true; const antes = posts.length;
const r = await api.gravarModeloNaNuvem(KEY, s => { s.status = 'Em costura'; }, { silencioso: true });
ok('não grava', [r, posts.length - antes], [null, 0]);
leituraFalha = false;
const r2 = await api.gravarModeloNaNuvem(KEY, s => { s.status = 'Em costura'; }, { silencioso: true });
ok('com leitura, grava só a mudança em cima da nuvem', [r2.status, r2.prod.Cinza, r2.cores.length], ['Em costura', [4, 9, 8], 3]);
console.log('4) gravação que ficou na fila não sobe por cima de coisa mais nova');
// Vestido Amplo, 15/09: um "Mandar tudo p/ produção" das 22:27 ficou na fila e foi reenviado
// às 10:37 do dia seguinte com o modelo inteiro daquela hora. Agora o pacote velho é
// descartado quando a nuvem já tem updated_at mais novo; o recente continua subindo.
nuvem[KEY] = { est: { Preto: [7, 7, 7] }, prod: { Cinza: [4, 9, 8] }, updated_at: '2026-09-15T13:00:00.000Z' };
const velho = { est: { Preto: [0, 0, 0] }, prod: { Cinza: [1, 1, 1] }, updated_at: '2026-09-15T01:27:00.000Z' };
api.fila.set(KEY, { dados: velho, emVoo: false });
const antes4 = posts.length;
await api.reenviarPendentes();
ok('o pacote velho não sobe', posts.length - antes4, 0);
ok('e sai da fila', api.fila.has(KEY), false);
ok('a nuvem continua com o dado novo', nuvem[KEY].prod.Cinza, [4, 9, 8]);
const recente = { est: { Preto: [1, 2, 3] }, prod: { Cinza: [4, 9, 8] }, updated_at: '2026-09-15T13:05:00.000Z' };
api.fila.set(KEY, { dados: recente, emVoo: false });
await api.reenviarPendentes();
ok('o pacote mais novo que a nuvem sobe normalmente', nuvem[KEY].est.Preto, [1, 2, 3]);
console.log(falhas ? `✗ ${falhas} falha(s)` : '✓ tudo certo');
process.exit(falhas ? 1 : 0);
