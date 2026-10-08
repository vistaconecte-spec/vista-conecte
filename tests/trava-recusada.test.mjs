// Laboratório: a trava do banco (código 23514) recusa a gravação de um aparelho com dado velho.
// Em 08/10/2026 a recusa caía no caminho de queda de rede: a gravação velha do Macacão Amplo
// ficava na fila, era reenviada a cada 15 s e o "Erro ao salvar na nuvem" não saía da tela.
// E a baixa automática contava a peça como baixada mesmo com a gravação barrada.
import { readFileSync } from 'node:fs';
const main = readFileSync('C:/Users/barba/OneDrive/Desktop/vista-conecte/main.js', 'utf8').replace(/\r\n/g, '\n');
const pedaco = (ini, fim) => { const a = main.indexOf(ini), b = main.indexOf(fim, a); if (a < 0 || b < 0) throw new Error(ini); return main.slice(a, b); };
const fonte = [
  pedaco("const HIST_PREFIXO = 'hist:';", 'const HIST_MAX'),
  pedaco('async function salvarNuvem(key, dados, opts)', '// Resumo do que mudou'),
  pedaco('async function carregarNuvem(key)', 'async function carregarTodosNuvem'),
  pedaco('async function salvarNuvemREST', 'function showCloudOk'),
  pedaco('let estEditado', '// Salva estado atual no localStorage'),
  pedaco('async function baixarEstoqueDoPedido', 'let _ultimaBaixaAuto'),
].join('\n');

// Nuvem falsa com a trava: recusa gravação cujo prod_at volta no tempo.
const nuvem = {}; const posts = []; const historico = []; const avisos = [];
let leituraVelha = 0; // quantas leituras ainda devolvem a versão velha (o aparelho que leu errado)
const velho = { est: { Preto: [0, 0, 1, 0, 0] }, status: 'Comprando tecido', prod_at: '2026-09-28T21:42:38.271Z' };
const fetchFalso = async (url, opt = {}) => {
  if ((opt.method || 'GET') === 'POST') {
    const b = JSON.parse(opt.body); posts.push(b);
    const atual = nuvem[b.id];
    if (atual && b.dados.prod_at && atual.prod_at && b.dados.prod_at < atual.prod_at)
      return { ok: false, status: 400, json: async () => ({ code: '23514', message: 'escrita recusada' }) };
    nuvem[b.id] = b.dados; return { ok: true, status: 201 };
  }
  const id = decodeURIComponent(/id=eq\.([^&]+)/.exec(url)[1]);
  if (leituraVelha > 0 && id === 'macacao') { leituraVelha--; return { ok: true, status: 200, json: async () => [{ dados: JSON.parse(JSON.stringify(velho)) }] }; }
  return { ok: true, status: 200, json: async () => (nuvem[id] ? [{ dados: JSON.parse(JSON.stringify(nuvem[id])) }] : []) };
};
const store = new Map();
const ctx = { SUPABASE_URL: 'https://x', SUPABASE_KEY: 'k', fetch: fetchFalso,
  saveLocal: (k, v) => store.set(k, JSON.stringify(v)), loadLocal: k => (store.has(k) ? JSON.parse(store.get(k)) : null),
  showCloudOk: () => {}, showCloudError: m => avisos.push(m || 'erro genérico'), limparErroNuvem: () => {},
  renderModelo: () => {}, renderDashboard: () => {}, renderModeloSeOcioso: () => {},
  registrarVersao: (k, d) => historico.push(k), verificarLeituraNuvem: () => {},
  requisitosDoItem: it => [{ key: it.modelKey, cor: it.cor, tam: it.tam, qtd: it.qtd }],
  MODELOS: { macacao: { nome: 'Macacão Amplo' } }, modeloAtual: 'macacao' };
const api = new Function('ctx', `const { SUPABASE_URL, SUPABASE_KEY, fetch, saveLocal, loadLocal, showCloudOk, showCloudError, limparErroNuvem, renderModelo, renderDashboard, renderModeloSeOcioso, registrarVersao, requisitosDoItem, MODELOS } = ctx; let modeloAtual = ctx.modeloAtual;
  ${fonte}
  return { salvarNuvem, salvarNuvemREST, reenviarPendentes, baixarEstoqueDoPedido, fila: _gravacoesPendentes };`)(ctx);
// setTimeout de verdade só atrasaria o teste: as esperas entre tentativas viram imediatas.
globalThis.setTimeout = (f) => { f(); return 0; };

let falhas = 0; const ok = (n, a, b) => { const p = JSON.stringify(a) === JSON.stringify(b); if (!p) falhas++; console.log((p ? '  ✓ ' : '  ✗ ') + n, p ? '' : JSON.stringify(a)); };
const certo = () => ({ est: { Preto: [1, 0, 0, 0, 0] }, status: 'Em corte', prod_at: '2026-10-06T11:42:17.774Z' });

console.log('1) gravação de aparelho com dado velho');
nuvem.macacao = certo();
const r = await api.salvarNuvem('macacao', { ...velho, updated_at: '2026-10-08T19:42:28.937Z' });
ok('volta como recusada', r, 'recusada');
ok('tentou uma vez só (sem retry, recusa não é rede)', posts.length, 1);
ok('não fica na fila para reenviar', api.fila.has('macacao'), false);
ok('a nuvem continua Em corte', nuvem.macacao.status, 'Em corte');
ok('o aparelho recebe a versão da nuvem', JSON.parse(store.get('vc:macacao')).status, 'Em corte');
ok('a versão recusada não entra no histórico', historico.includes('macacao'), false);
ok('o aviso diz qual modelo estava desatualizado', /Macacão Amplo estava desatualizado/.test(avisos.at(-1)), true);

console.log('2) a fila não reenvia mais nada');
const antes = posts.length;
await api.reenviarPendentes();
ok('nenhum POST novo', posts.length, antes);

console.log('3) baixa que leu a versão velha uma vez');
nuvem.macacao = { est: { Preto: [0, 0, 2, 0, 0] }, status: 'Em corte', prod_at: '2026-10-06T11:42:17.774Z' };
leituraVelha = 1; posts.length = 0;
const b1 = await api.baixarEstoqueDoPedido([{ modelKey: 'macacao', cor: 'Preto', tam: 2, qtd: 1 }]);
ok('lê de novo e baixa em cima do dado certo', nuvem.macacao.est.Preto, [0, 0, 1, 0, 0]);
ok('a leva não voltou', nuvem.macacao.status, 'Em corte');
ok('a peça conta como baixada', b1.map(x => x.qtd), [1]);

console.log('4) baixa que lê velho nas duas tentativas');
leituraVelha = 99; // fonte que continua velha em toda leitura
const b2 = await api.baixarEstoqueDoPedido([{ modelKey: 'macacao', cor: 'Preto', tam: 2, qtd: 1 }]);
ok('nada é gravado por cima', nuvem.macacao.est.Preto, [0, 0, 1, 0, 0]);
ok('e a peça NÃO conta como baixada', b2.length, 0);
leituraVelha = 0;

console.log('5) gravação normal continua igual');
historico.length = 0;
const r3 = await api.salvarNuvem('outro', { est: {}, prod_at: '2026-10-08T20:00:00Z' });
ok('volta true', r3, true);
ok('entra no histórico', historico, ['outro']);

console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo');
process.exit(falhas ? 1 : 0);
