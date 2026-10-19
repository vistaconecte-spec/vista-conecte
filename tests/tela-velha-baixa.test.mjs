// Laboratório do caso de 16/10/2026, 18:15 UTC: um aparelho com a tela aberta desde 14/10
// acordou e aplicou cinco envios atrasados (#9290, #9234, #9279, #9170, #9073). Junto com
// cada peça subiu o modelo INTEIRO como estava no dia 14: a leva 2 "Em corte" do Macacão
// Amplo sumiu (prod2/status2 apagados, leva2=false), a leva 1 perdeu o status e o estoque
// voltou para antes do "Tudo para o estoque" das 11h41. No `hist:` cada gravação das 18:15
// é o retrato de 14/10 com uma peça a menos e carimbo novo: a leitura "da nuvem" daquele
// aparelho devolvia a versão velha.
//
// Este teste roda a baixa contra uma nuvem falsa que se comporta como o PostgREST (linha com
// updated_at do servidor, PATCH condicional) e um aparelho cuja leitura devolve o dia 14.
// Primeiro roda a baixa como ela era (código de 14/10, copiado abaixo) para provar que o
// laboratório reproduz o estrago; depois a baixa atual, que não pode mexer em leva nem status.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const pedaco = (ini, fim) => { const a = main.indexOf(ini), b = main.indexOf(fim, a); if (a < 0 || b < 0) throw new Error(ini); return main.slice(a, b); };

// A baixa como estava publicada de 08/10 a 19/10/2026 (commit 263af86), sem mudar nada.
const BAIXA_DE_14_10 = `
async function baixarUmaPeca(r, i) {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const saved = await carregarNuvem(r.key);
    if (saved === undefined) return 0;
    if (!saved || !saved.est || !saved.est[r.cor]) return 0;
    const antes = saved.est[r.cor][i] || 0;
    if (antes <= 0) return 0;
    const tirar = Math.min(antes, r.qtd);
    saved.est[r.cor][i] = antes - tirar;
    saved.est_at = saved.updated_at = new Date().toISOString();
    saveLocal('vc:' + r.key, saved);
    if (await salvarNuvem(r.key, saved) === 'recusada') continue;
    return tirar;
  }
  return 0;
}`;

// ─── A nuvem (estado certo às 18:14 de 16/10) e o retrato de 14/10 do aparelho ───────────
const nuvemCerta = () => ({
  nome: 'Macacão Amplo',
  est: { Preto: [2, 1, 3, 1, 1], Marrom: [1, 2, 2, 0, 1], Marsala: [0, 1, 1, 2, 1] },
  est_at: '2026-10-16T14:41:17.114Z',
  prod: { Preto: [0, 0, 0, 0, 0], Marrom: [0, 0, 0, 0, 0], Marsala: [0, 0, 0, 0, 0] },
  prod_at: '2026-10-16T14:41:17.114Z', status: '', status_at: null,
  leva2: true,
  prod2: { Preto: [1, 3, 3, 2, 1], Marrom: [0, 2, 3, 1, 0], Marsala: [0, 1, 2, 1, 0] }, // 20 peças
  prod2_at: '2026-10-16T15:38:59.948Z', status2: 'Em corte', status2_at: '2026-10-16T15:38:59.948Z',
  updated_at: '2026-10-16T15:39:05.499Z',
});
const retrato14 = () => ({
  nome: 'Macacão Amplo',
  est: { Preto: [2, 0, 0, 1, 0], Marrom: [1, 2, 0, 0, 1], Marsala: [0, 0, 0, 2, 1] },
  est_at: '2026-10-14T21:20:57.621Z',
  prod: { Preto: [1, 1, 1, 0, 1], Marrom: [0, 0, 0, 0, 0], Marsala: [0, 0, 0, 0, 0] },
  prod_at: '2026-10-06T11:42:17.774Z', status: 'Em costura', status_at: '2026-10-08T20:48:29.075Z',
  leva2: false,
  updated_at: '2026-10-14T21:20:57.621Z',
});
const EM_14 = '2026-10-14T21:20:57.765432+00:00';

let nuvem, servidorEm, relogio, leiturasVelhas, gravacoes, antesDoPatch;
const reset = () => { nuvem = { 'macacao-amplo': nuvemCerta() }; servidorEm = { 'macacao-amplo': '2026-10-16T15:39:05.639001+00:00' }; relogio = 0; leiturasVelhas = 0; gravacoes = []; antesDoPatch = null; };
const carimbar = id => { servidorEm[id] = '2026-10-16T18:15:' + String(10 + ++relogio).padStart(2, '0') + '.000000+00:00'; };
const clone = x => JSON.parse(JSON.stringify(x));
const fetchFalso = async (url, opt = {}) => {
  const metodo = opt.method || 'GET';
  if (metodo === 'POST') { // upsert merge-duplicates: troca a coluna dados inteira
    const b = JSON.parse(opt.body); gravacoes.push({ metodo, id: b.id, dados: b.dados });
    nuvem[b.id] = b.dados; carimbar(b.id); return { ok: true, status: 201 };
  }
  const id = decodeURIComponent(/id=eq\.([^&]+)/.exec(url)[1]);
  if (metodo === 'PATCH') {
    if (antesDoPatch) { const f = antesDoPatch; antesDoPatch = null; f(); } // outro aparelho grava no meio
    const b = JSON.parse(opt.body); gravacoes.push({ metodo, id, dados: b.dados });
    const lido = decodeURIComponent(/updated_at=eq\.([^&]+)/.exec(url)[1]);
    if (!nuvem[id] || servidorEm[id] !== lido) return { ok: true, status: 200, json: async () => [] };
    nuvem[id] = b.dados; carimbar(id); return { ok: true, status: 200, json: async () => [{ id }] };
  }
  if (leiturasVelhas > 0 && id === 'macacao-amplo') { leiturasVelhas--; return { ok: true, status: 200, json: async () => [{ id, dados: retrato14(), updated_at: EM_14 }] }; }
  return { ok: true, status: 200, json: async () => (nuvem[id] ? [{ id, dados: clone(nuvem[id]), updated_at: servidorEm[id] }] : []) };
};

const store = new Map(); const historico = []; let fetchAtual = fetchFalso;
const ctx = { SUPABASE_URL: 'https://x', SUPABASE_KEY: 'k', fetch: (u, o) => fetchAtual(u, o),
  saveLocal: (k, v) => store.set(k, JSON.stringify(v)), loadLocal: k => (store.has(k) ? JSON.parse(store.get(k)) : null),
  registrarVersao: (k, d) => historico.push({ k, d: clone(d) }),
  requisitosDoItem: it => [{ key: it.modelKey, cor: it.cor, tam: it.tam, qtd: it.qtd }],
  MODELOS: { 'macacao-amplo': { nome: 'Macacão Amplo' } } };
const montar = (baixa) => new Function('ctx', `const { SUPABASE_URL, SUPABASE_KEY, fetch, saveLocal, loadLocal, registrarVersao, requisitosDoItem, MODELOS } = ctx;
  const HIST_PREFIXO = 'hist:';
  async function salvarNuvem(key, dados) { await fetch(SUPABASE_URL + '/rest/v1/vc_modelos', { method: 'POST', body: JSON.stringify({ id: key, dados }) }); registrarVersao(key, dados); return true; }
  ${pedaco('async function carregarNuvem(key)', 'async function carregarTodosNuvem')}
  ${baixa}
  return { baixarEstoqueDoPedido };`)(ctx);
const atual = montar(pedaco('async function baixarEstoqueDoPedido', 'let _ultimaBaixaAuto'));
const antiga = montar(pedaco('async function baixarEstoqueDoPedido', '// Devolve quantas peças saíram do estoque') + BAIXA_DE_14_10);
console.warn = () => {};

let falhas = 0; const ok = (n, a, b) => { const p = JSON.stringify(a) === JSON.stringify(b); if (!p) falhas++; console.log((p ? '  ✓ ' : '  ✗ ') + n, p ? '' : '\n      obtido: ' + JSON.stringify(a) + '\n      esperado: ' + JSON.stringify(b)); };
const celulasDiferentes = (a, b) => { let n = 0; for (const cor of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) { const x = (a || {})[cor] || [], y = (b || {})[cor] || []; for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) n++; } return n; };
const pedido = [{ modelKey: 'macacao-amplo', cor: 'Preto', tam: 0, qtd: 1 }]; // #9290: Preto PP
const certa = nuvemCerta();

console.log('1) O laboratório reproduz 16/10: a baixa de 14/10 num aparelho que lê o dia 14');
reset(); leiturasVelhas = 99;
await antiga.baixarEstoqueDoPedido(pedido);
ok('a leva 2 em corte some (prod2 apagado)', nuvem['macacao-amplo'].prod2, undefined);
ok('status2 apagado', nuvem['macacao-amplo'].status2, undefined);
ok('leva2 vira false', nuvem['macacao-amplo'].leva2, false);
ok('a leva 1 volta para "Em costura" de 08/10', nuvem['macacao-amplo'].status, 'Em costura');
ok('o estoque volta para o de 14/10 (menos a peça)', nuvem['macacao-amplo'].est.Marsala, [0, 0, 0, 2, 1]);

console.log('2) Baixa atual, mesmo aparelho (toda leitura devolve o dia 14)');
reset(); historico.length = 0; leiturasVelhas = 99;
const b2 = await atual.baixarEstoqueDoPedido(pedido);
ok('nada foi gravado na nuvem', clone(nuvem['macacao-amplo']), certa);
ok('as tentativas foram todas condicionais (PATCH), nunca o upsert que troca tudo', gravacoes.every(g => g.metodo === 'PATCH'), true);
ok('a peça não conta como baixada (fica no estoque, corrige-se contando a arara)', b2.length, 0);
ok('nada entrou no histórico', historico.length, 0);

console.log('3) Leitura velha só na primeira vez (a segunda já vem certa)');
reset(); historico.length = 0; leiturasVelhas = 1;
const b3 = await atual.baixarEstoqueDoPedido(pedido);
const n3 = nuvem['macacao-amplo'];
ok('a peça foi baixada uma vez', b3.map(x => x.qtd), [1]);
ok('Preto PP 2 -> 1', n3.est.Preto, [1, 1, 3, 1, 1]);
ok('só UMA célula do estoque mudou', celulasDiferentes(certa.est, n3.est), 1);
ok('leva 2 intacta (20 peças, Em corte)', [n3.leva2, n3.prod2, n3.status2, n3.status2_at, n3.prod2_at], [true, certa.prod2, 'Em corte', certa.status2_at, certa.prod2_at]);
ok('leva 1 intacta', [n3.prod, n3.status, n3.status_at, n3.prod_at], [certa.prod, '', null, certa.prod_at]);
ok('nenhum outro campo mudou', Object.keys(certa).filter(k => !['est', 'est_at', 'updated_at'].includes(k) && JSON.stringify(certa[k]) !== JSON.stringify(n3[k])), []);
ok('o que subiu prova qual linha foi lida (lido_at = updated_at do servidor)', gravacoes.at(-1).dados.lido_at, '2026-10-16T15:39:05.639001+00:00');
ok('o histórico recebeu a versão gravada', historico.length, 1);

console.log('4) Outro aparelho grava entre a leitura e a gravação');
reset(); historico.length = 0;
antesDoPatch = () => { nuvem['macacao-amplo'].status2 = 'Em costura'; nuvem['macacao-amplo'].status2_at = '2026-10-16T18:15:00.000Z'; carimbar('macacao-amplo'); };
const b4 = await atual.baixarEstoqueDoPedido(pedido);
ok('a baixa lê de novo e aplica em cima', nuvem['macacao-amplo'].est.Preto, [1, 1, 3, 1, 1]);
ok('o "Em costura" do outro aparelho fica', nuvem['macacao-amplo'].status2, 'Em costura');
ok('a peça conta uma vez só', b4.map(x => x.qtd), [1]);

console.log('5) Dois itens do mesmo modelo no pedido (#9170: 3 peças)');
reset();
await atual.baixarEstoqueDoPedido([{ modelKey: 'macacao-amplo', cor: 'Preto', tam: 0, qtd: 1 }, { modelKey: 'macacao-amplo', cor: 'Marrom', tam: 1, qtd: 1 }]);
ok('as duas células baixam, uma em cima da outra', [nuvem['macacao-amplo'].est.Preto[0], nuvem['macacao-amplo'].est.Marrom[1]], [1, 1]);
ok('e só elas', celulasDiferentes(certa.est, nuvem['macacao-amplo'].est), 2);

console.log('6) Rede cai depois do PATCH chegar');
reset();
let derrubar = true;
fetchAtual = async (u, o) => { const r = await fetchFalso(u, o); if (o && o.method === 'PATCH' && derrubar) { derrubar = false; throw new Error('rede'); } return r; };
const b6 = await atual.baixarEstoqueDoPedido(pedido);
fetchAtual = fetchFalso;
ok('confere na nuvem e conta a peça', b6.map(x => x.qtd), [1]);
ok('sem baixar duas vezes', nuvem['macacao-amplo'].est.Preto[0], 1);

console.log('7) Os outros gravadores de modelo também provam a leitura');
ok('gravarModeloNaNuvem declara a leitura', /declararLeitura\(saved, nuvem\)/.test(pedaco('async function gravarModeloNaNuvem', '\n}')), true);
ok('subirModeloMesclado declara a leitura', /declararLeitura\(mesclarModelo\(nuvem, dom, tocado\), nuvem\)/.test(pedaco('async function subirModeloMesclado', '\nfunction salvarModelo')), true);
ok('restaurarVersao declara a leitura da linha de agora', /declararLeitura\(ver\.d, await carregarNuvem\(key\)\)/.test(pedaco('async function restaurarVersao', '\n}')), true);
ok('a baixa não usa mais o upsert (salvarNuvem) para o modelo', /salvarNuvem\(r\.key/.test(pedaco('async function baixarUmaPeca', 'let _ultimaBaixaAuto')), false);

console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo');
process.exit(falhas ? 1 : 0);
