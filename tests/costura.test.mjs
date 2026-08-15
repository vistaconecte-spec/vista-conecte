/**
 * Teste da ABA COSTURA (main.js).
 *
 * POR QUE ISTO EXISTE: a costureira vê UMA tela e não tem como conferir nada em outro
 * lugar — ela não abre pedido, não abre estoque, não abre a ficha do modelo. Se a lista
 * mentir, ela costura a peça errada e ninguém descobre no mesmo dia. O que estes testes
 * travam:
 *   1. a lista de costura mostra SÓ quem está "Em costura" (e a de corte, só "Em corte");
 *   2. a 2ª leva do mesmo modelo é uma linha separada — as duas podem estar em etapas
 *      diferentes, somar as duas esconderia isso;
 *   3. conjunto não vira ficha (ele não é peça de oficina) e cor zerada não entra;
 *   4. a grade vem do modelo (G1 existe): nunca assumir 5 tamanhos;
 *   5. o perfil 'costura' continua sem acesso a /api e sem dar baixa em estoque.
 *
 * Rodar:  node tests/costura.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');

function extrair(nome) {
  const i = main.indexOf(`function ${nome}(`);
  if (i < 0) throw new Error(`função ${nome} não encontrada em main.js`);
  const fim = main.indexOf('\n}', i);
  return main.slice(i, fim + 2);
}

// cstLevasDe lê os globais do app; aqui eles entram por injeção.
const criar = (MODELOS, salvos, CONJUNTO_PECAS) => new Function(
  'MODELOS', 'CONJUNTO_PECAS', 'loadLocal', 'tamanhosDe',
  extrair('cstLevasDe') + '; return cstLevasDe;'
)(MODELOS, CONJUNTO_PECAS || {},
  k => salvos[k.replace('vc:', '')] || null,
  def => def.tamanhos || ['PP', 'P', 'M', 'G', 'GG']);

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

const MODELOS = {
  'saia-midi':   { nome: 'Saia Midi',   tecido: 'Alfaiataria' },
  'calca-flare': { nome: 'Calça Flare', tecido: 'Viscolycra' },
  'moletom':     { nome: 'Moletom',     tecido: 'Moletinho', tamanhos: ['PP', 'P', 'M', 'G', 'GG', 'G1'] },
  'conj-boho':   { nome: 'Conjunto Boho', tecido: 'Linho' },
};

const salvos = {
  // leva 1 na costura, 2ª leva ainda no corte: as duas etapas ao mesmo tempo
  'saia-midi': {
    status: 'Em costura', status_at: new Date(Date.now() - 3 * 86400000).toISOString(), prazo: '2026-08-20',
    prod:  { Preto: [1, 2, 3, 0, 0], Areia: [0, 0, 1, 0, 0] },
    status2: 'Em corte', status2_at: new Date(Date.now() - 1 * 86400000).toISOString(),
    prod2: { Preto: [0, 0, 5, 0, 0] },
  },
  // comprando tecido: não é nem de corte nem de costura
  'calca-flare': { status: 'Comprando tecido', prod: { Marsala: [2, 2, 2, 2, 2] } },
  // grade com G1 + uma cor zerada, que não pode virar linha
  'moletom': {
    status: 'Em costura', status_at: new Date(Date.now() - 10 * 86400000).toISOString(),
    prod: { Verde: [0, 1, 0, 0, 0, 4], Branco: [0, 0, 0, 0, 0, 0] },
  },
  // conjunto está em costura, mas conjunto não é peça de oficina
  'conj-boho': { status: 'Em costura', status_at: new Date().toISOString(), prod: { Off: [3, 3, 3, 3, 3] } },
};

const cstLevasDe = criar(MODELOS, salvos, { 'conj-boho': ['saia-midi', 'calca-flare'] });

console.log('\n1) O que está em costura — e só isso');
const costura = cstLevasDe('Em costura');
ok('duas fichas (Saia leva 1 + Moletom); flare em compra e conjunto ficam de fora',
   costura.map(l => l.key + '|' + l.leva).sort(), ['moletom|1', 'saia-midi|1']);
ok('a Saia soma só a leva 1', costura.find(l => l.key === 'saia-midi').total, 7);
ok('cor zerada não vira linha', costura.find(l => l.key === 'moletom').linhas.map(r => r.cor), ['Verde']);
ok('e o total do Moletom conta o G1', costura.find(l => l.key === 'moletom').total, 5);
ok('a grade sai do modelo, não de 5 fixo',
   costura.find(l => l.key === 'moletom').SZ.length, 6);
ok('dias vêm do carimbo de entrada na etapa', costura.find(l => l.key === 'saia-midi').dias, 3);
ok('a linha da cor tem um número por tamanho da grade',
   costura.find(l => l.key === 'moletom').linhas[0].arr, [0, 1, 0, 0, 0, 4]);

console.log('\n2) O que vem por aí — a mesma leitura, com o outro status');
const corte = cstLevasDe('Em corte');
ok('a 2ª leva da Saia aparece sozinha, sem se misturar com a leva 1 em costura',
   corte.map(l => l.key + '|' + l.leva + '|' + l.total), ['saia-midi|2|5']);
ok('e cada leva carrega o próprio carimbo (1 dia no corte, 3 na costura)',
   [corte[0].dias, costura.find(l => l.key === 'saia-midi').dias], [1, 3]);
ok('status "Comprando tecido" não entra por engano em nenhuma das duas',
   cstLevasDe('Em corte').concat(cstLevasDe('Em costura')).some(l => l.key === 'calca-flare'), false);

console.log('\n3) Sem produção digitada não há ficha');
const vazio = criar({ x: { nome: 'X', tecido: 'T' } }, { x: { status: 'Em costura', prod: { Preto: [0, 0, 0, 0, 0] } } });
ok('cor toda zerada não gera ficha fantasma', vazio('Em costura').length, 0);
const semProd = criar({ x: { nome: 'X', tecido: 'T' } }, { x: { status: 'Em costura' } });
ok('modelo sem prod nenhum também não', semProd('Em costura').length, 0);

console.log('\n4) A costureira não chega em pedido, cliente nem estoque');
const mid = readFileSync(join(raiz, 'functions/api/_middleware.js'), 'utf8');
ok("o perfil 'costura' está na trava da oficina",
   /const OFICINA = new Set\(\['corte', 'costura'\]\);/.test(mid), true);
ok('e a allowlist dela é vazia (endpoint novo já nasce bloqueado)',
   /const OFICINA_LIBERA = new Set\(\[\]\);/.test(mid), true);
ok('não busca pedido na Shopify (403 a cada minuto, e a tela não precisa)',
   /async function carregarPedidosShopify\(\) \{[\s\S]{0,400}?if \(ehPerfilOficina\(\)\) return;/.test(main), true);
ok('e nunca dá baixa de estoque',
   (main.match(/if \(!ehPerfilOficina\(\)\) await baixaImediataDeProcessados/g) || []).length, 2);
ok('a aba é só leitura: nada nela grava na nuvem',
   /function renderCostura\(\)[\s\S]*?\n\}/.exec(main)[0].includes('salvarNuvem'), false);

console.log('\n5) A tela montada — as três faixas, na ordem');
// renderCostura roda fora do navegador com um DOM de mentira: o que interessa é o HTML
// que ela escreve. Sem isto, um erro de digitação no template só apareceria na mesa dela.
const els = {
  'costura-corte': { innerHTML: '' },   // card próprio, ACIMA do card das fichas
  'costura-lista': { innerHTML: '' },
  'costura-total': { textContent: '' },
};
new Function(
  'MODELOS', 'CONJUNTO_PECAS', 'loadLocal', 'tamanhosDe', 'document',
  'crtPrioridade', 'crtPrioridadeDe', 'crtMotivoHTML', 'crtRegistro', 'crtTotalDe',
  'comprandoTecidoConsolidado',
  extrair('cstLevasDe') + '\n' + extrair('renderCostura') + '; renderCostura();'
)(MODELOS, { 'conj-boho': [] },
  k => salvos[k.replace('vc:', '')] || null,
  def => def.tamanhos || ['PP', 'P', 'M', 'G', 'GG'],
  { getElementById: id => els[id] || null },
  () => ({}),
  () => ({ pedidos: 0, score: 0 }),
  () => '',
  () => ({ cores: { Preto: [0, 0, 2, 0, 0] } }),
  cores => Object.values(cores).reduce((s, a) => s + a.reduce((x, y) => x + y, 0), 0),
  () => [{ tecido: 'Viscolycra', cores: [{ cor: 'Marsala' }], pecas: 10, metros: 12.5 }]);

const html  = els['costura-lista'].innerHTML;
const corteHtml = els['costura-corte'].innerHTML;
ok('o corte sai do card das fichas e vai para o elemento de cima',
   [corteHtml.includes('VEM POR AÍ'), html.includes('VEM POR AÍ')], [true, false]);
ok('é um <details>: chega fechado e abre no toque',
   /^\s*<details class="card cst-corte">/.test(corteHtml) && !/\bopen\b/.test(corteHtml.slice(0, 60)), true);
ok('fechado mostra o total de peças na mesa', /cst-mini-tot">5 peças/.test(corteHtml), true);
ok('aberto mostra os modelos com as quantidades por tamanho',
   /cst-corte-mod[\s\S]*?<table[\s\S]*?Preto/.test(corteHtml), true);
ok('a frase do card é a que ela pediu',
   corteHtml.includes('É o que está na mesa do corte, já com o tecido comprado.'), true);
ok('a 2ª leva aparece marcada como 2ª', /Saia Midi <span class="crt-selo">2ª LEVA<\/span>/.test(corteHtml), true);
ok('e mostra o que o cortador já anotou ter cortado', /já cortadas?<\/span>/.test(corteHtml), true);
ok('o card das fichas fica só com ficha e tecido em compra',
   html.indexOf('Saia Midi') < html.indexOf('TECIDO SENDO COMPRADO'), true);
ok('a ficha traz a cor e a quantidade por tamanho', /Areia[\s\S]*?>1</.test(html), true);
ok('o cabeçalho conta as fichas e as peças', els['costura-total'].textContent, '2 fichas · 12 peças');
ok('sem campo de digitar: a aba não tem input nenhum', /<input/.test(html + corteHtml), false);

// Pedido da Bárbara em 15/08: a linha embaixo do nome ficou só com o tempo e a data.
console.log('\n6) A ficha não repete o óbvio');
const iSaia = html.lastIndexOf('Saia Midi'); // a ficha dela é a última do grid (3 dias < 10 do Moletom)
const fichaSaia = html.slice(iSaia, html.indexOf('TECIDO SENDO COMPRADO', iSaia));
ok('sem "Em costura" na ficha (a aba inteira é costura)', /Em costura/.test(fichaSaia), false);
ok('sem o nome do tecido', /Alfaiataria/.test(fichaSaia), false);
ok('sem a palavra "entrega"', /entrega/i.test(fichaSaia), false);
ok('mas com os dias na etapa e a data de entrega', /há 3 dias · 20\/08\/2026/.test(fichaSaia), true);

console.log(falhas ? `\n✗ ${total - falhas}/${total} passaram` : `\n✓ ${total}/${total} passaram`);
process.exit(falhas ? 1 : 0);
