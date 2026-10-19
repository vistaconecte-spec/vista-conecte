// Laboratório do histórico truncado de 16/10/2026: o aparelho com a tela de 14/10 lia a nuvem
// velha. A baixa já foi corrigida (tela-velha-baixa.test.mjs), mas registrarVersao lia a lista
// `hist:<chave>` pela mesma leitura velha e regravava a lista INTEIRA por upsert: o hist: do
// Macacão Amplo e da Pantalona Viscolycra perdeu as versões de 13 a 16/10, que eram a única
// trilha para entender e desfazer o estrago.
//
// O teste roda contra uma nuvem falsa que se comporta como o PostgREST (updated_at do servidor,
// PATCH condicional, POST que só cria ou que faz upsert). Primeiro o registrarVersao antigo,
// para provar que o laboratório reproduz a lista truncada; depois o atual.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const pedaco = (ini, fim) => { const a = main.indexOf(ini), b = main.indexOf(fim, a); if (a < 0 || b < 0) throw new Error(ini); return main.slice(a, b); };

// registrarVersao como estava publicado até 19/10/2026, sem mudar nada.
const REGISTRAR_ANTIGO = `
async function registrarVersao(key, dados) {
  if (ehChaveHistorico(key)) return;
  try {
    const hk = HIST_PREFIXO + key;
    const atual = await carregarNuvem(hk);
    if (atual === undefined) return;
    const v = (atual && Array.isArray(atual.v)) ? atual.v : [];
    const novo = JSON.stringify(dados);
    if (v.length && JSON.stringify(v[0].d) === novo) return;
    v.unshift({ t: new Date().toISOString(), d: JSON.parse(novo) });
    await salvarNuvemREST(hk, { v: v.slice(0, HIST_MAX) }, { silencioso: true });
  } catch (_) {}
}`;

// ─── A lista certa (versões até 16/10) e a que o aparelho de 14/10 enxergava ─────────────
const HK = 'hist:macacao-amplo';
const versao = (dia, est) => ({ t: `2026-10-${dia}T12:00:00.000Z`, d: { nome: 'Macacão Amplo', est: { Preto: est } } });
const listaCerta = () => ({ v: [
  versao(16, [2, 1, 3, 1, 1]), versao(15, [2, 1, 2, 1, 1]), versao(14, [2, 0, 0, 1, 0]),
  versao(13, [1, 0, 0, 1, 0]), versao(12, [1, 0, 0, 0, 0]), versao(11, [0, 0, 0, 0, 0]),
] });
const listaDe14 = () => ({ v: listaCerta().v.slice(2) }); // ainda sem 15 e 16
const EM_14 = '2026-10-14T21:20:57.765432+00:00';
const novaVersao = { nome: 'Macacão Amplo', est: { Preto: [1, 1, 3, 1, 1] } }; // baixa das 18:15

let nuvem, servidorEm, relogio, leiturasVelhas, gravacoes, antesDoPatch;
const reset = () => {
  nuvem = { [HK]: listaCerta() }; servidorEm = { [HK]: '2026-10-16T15:39:05.639001+00:00' };
  relogio = 0; leiturasVelhas = 0; gravacoes = []; antesDoPatch = null;
};
const carimbar = id => { servidorEm[id] = '2026-10-16T18:15:' + String(10 + ++relogio).padStart(2, '0') + '.000000+00:00'; };
const clone = x => JSON.parse(JSON.stringify(x));
const fetchFalso = async (url, opt = {}) => {
  const metodo = opt.method || 'GET';
  const prefer = (opt.headers && opt.headers.Prefer) || '';
  if (metodo === 'POST') {
    const b = JSON.parse(opt.body); gravacoes.push({ metodo, prefer, id: b.id, dados: b.dados });
    // Sem merge-duplicates o PostgREST só cria: linha que já existe dá 409.
    if (nuvem[b.id] && !/merge-duplicates/.test(prefer)) return { ok: false, status: 409, json: async () => ({ code: '23505' }) };
    nuvem[b.id] = b.dados; carimbar(b.id); return { ok: true, status: 201, json: async () => [] };
  }
  const id = decodeURIComponent(/id=eq\.([^&]+)/.exec(url)[1]);
  if (metodo === 'PATCH') {
    if (antesDoPatch) { const f = antesDoPatch; antesDoPatch = null; f(); } // outro aparelho grava no meio
    const b = JSON.parse(opt.body); gravacoes.push({ metodo, id, dados: b.dados });
    const lido = decodeURIComponent(/updated_at=eq\.([^&]+)/.exec(url)[1]);
    if (!nuvem[id] || servidorEm[id] !== lido) return { ok: true, status: 200, json: async () => [] };
    nuvem[id] = b.dados; carimbar(id); return { ok: true, status: 200, json: async () => [{ id }] };
  }
  if (leiturasVelhas > 0 && id === HK) { leiturasVelhas--; return { ok: true, status: 200, json: async () => [{ id, dados: listaDe14(), updated_at: EM_14 }] }; }
  return { ok: true, status: 200, json: async () => (nuvem[id] ? [{ id, dados: clone(nuvem[id]), updated_at: servidorEm[id] }] : []) };
};

const ctx = { SUPABASE_URL: 'https://x', SUPABASE_KEY: 'k', fetch: (u, o) => fetchFalso(u, o) };
const montar = (registrar) => new Function('ctx', `const { SUPABASE_URL, SUPABASE_KEY, fetch } = ctx;
  const HIST_PREFIXO = 'hist:'; const HIST_MAX = 25;
  // O salvarNuvemREST de verdade é upsert (merge-duplicates): troca a coluna dados inteira.
  async function salvarNuvemREST(key, dados) {
    await fetch(SUPABASE_URL + '/rest/v1/vc_modelos', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id: key, dados }) });
    return true;
  }
  ${pedaco('function ehChaveHistorico', '\n// Nunca deixa o histórico atrapalhar')}
  ${pedaco('async function carregarNuvem(key)', 'async function carregarTodosNuvem')}
  ${pedaco('async function gravarSeNaoMudou', 'let _ultimaBaixaAuto')}
  ${registrar}
  return { registrarVersao };`)(ctx);
const atual = montar(pedaco('// Nunca deixa o histórico atrapalhar', '\nasync function salvarNuvem('));
const antigo = montar(REGISTRAR_ANTIGO);
console.warn = () => {};

let falhas = 0; const ok = (n, a, b) => { const p = JSON.stringify(a) === JSON.stringify(b); if (!p) falhas++; console.log((p ? '  ✓ ' : '  ✗ ') + n, p ? '' : '\n      obtido: ' + JSON.stringify(a) + '\n      esperado: ' + JSON.stringify(b)); };
const dias = () => (nuvem[HK] ? nuvem[HK].v.map(x => x.t.slice(8, 10)) : null);
const ehNova = x => JSON.stringify(x.d) === JSON.stringify(novaVersao);

console.log('1) O laboratório reproduz 16/10: o registrarVersao antigo num aparelho que lê o dia 14');
reset(); leiturasVelhas = 99;
await antigo.registrarVersao('macacao-amplo', novaVersao);
ok('as versões de 15 e 16/10 somem da lista', dias().slice(1), ['14', '13', '12', '11']);

console.log('2) registrarVersao atual, mesmo aparelho (toda leitura devolve o dia 14)');
reset(); leiturasVelhas = 99;
await atual.registrarVersao('macacao-amplo', novaVersao);
ok('a lista da nuvem fica inteira', clone(nuvem[HK]), listaCerta());
ok('toda tentativa foi PATCH condicional, nunca o upsert que troca a lista', gravacoes.every(g => g.metodo === 'PATCH'), true);
ok('desiste depois de 3 voltas', gravacoes.length, 3);

console.log('3) Leitura velha só na primeira vez');
reset(); leiturasVelhas = 1;
await atual.registrarVersao('macacao-amplo', novaVersao);
ok('a versão nova entra no topo', ehNova(nuvem[HK].v[0]), true);
ok('e as de 11 a 16/10 continuam embaixo', dias().slice(1), ['16', '15', '14', '13', '12', '11']);

console.log('4) Outro aparelho grava uma versão entre a leitura e a gravação');
reset();
antesDoPatch = () => { nuvem[HK].v.unshift(versao(17, [9, 9, 9, 9, 9])); carimbar(HK); };
await atual.registrarVersao('macacao-amplo', novaVersao);
ok('lê de novo e põe a sua em cima da do outro', [ehNova(nuvem[HK].v[0]), dias().slice(1)], [true, ['17', '16', '15', '14', '13', '12', '11']]);

console.log('5) Versão igual à do topo não é gravada');
reset();
await atual.registrarVersao('macacao-amplo', listaCerta().v[0].d);
ok('nenhuma gravação', gravacoes.length, 0);

console.log('6) Linha que ainda não existe é criada por POST');
reset(); delete nuvem[HK]; delete servidorEm[HK];
await atual.registrarVersao('macacao-amplo', novaVersao);
ok('POST criou a lista com a versão', [gravacoes.map(g => g.metodo), nuvem[HK].v.length, ehNova(nuvem[HK].v[0])], [['POST'], 1, true]);
ok('o POST só cria (sem merge-duplicates): não troca lista que apareceu no meio', /merge-duplicates/.test(gravacoes[0].prefer), false);

console.log('7) A linha foi criada por outro aparelho entre a leitura e o POST');
reset(); const lista7 = listaCerta(); delete nuvem[HK]; delete servidorEm[HK];
let primeira = true;
const fetchOriginal = ctx.fetch;
ctx.fetch = async (u, o = {}) => { // a primeira leitura não vê a linha; o POST já a encontra
  if ((o.method || 'GET') === 'GET' && primeira) { primeira = false; nuvem[HK] = lista7; carimbar(HK); return { ok: true, status: 200, json: async () => [] }; }
  return fetchFalso(u, o);
};
const atual7 = montar(pedaco('// Nunca deixa o histórico atrapalhar', '\nasync function salvarNuvem('));
await atual7.registrarVersao('macacao-amplo', novaVersao);
ctx.fetch = fetchOriginal;
ok('o 409 faz ler de novo e gravar por PATCH em cima da lista do outro', [gravacoes.map(g => g.metodo), ehNova(nuvem[HK].v[0]), dias().slice(1)], [['POST', 'PATCH'], true, ['16', '15', '14', '13', '12', '11']]);

console.log('8) Histórico do próprio histórico não existe');
reset();
await atual.registrarVersao(HK, { v: [] });
ok('nada gravado', gravacoes.length, 0);

console.log(falhas ? `\n✗ ${falhas} falha(s)` : '\n✓ histórico com leitura velha: tudo certo');
process.exit(falhas ? 1 : 0);
