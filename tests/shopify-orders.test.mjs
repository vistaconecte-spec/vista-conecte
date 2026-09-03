/**
 * Teste do parser de pedidos (functions/api/shopify-orders.js).
 *
 * POR QUE ISTO EXISTE: em 28/07/2026 uma regra de cor fixa do EXACT_TITLE_MAP
 * ("Calça Peace" → Marsala, criada para pedidos antigos sem cor no título) passou a
 * capturar os produtos UNIFICADOS — que têm o mesmo título e a cor na variante.
 * Resultado: todos os pedidos do modelo colapsaram numa cor só e a produção foi
 * calculada em cima disso. Estes testes travam esse comportamento.
 *
 * Rodar ANTES de todo deploy que toque em shopify-orders.js:
 *     node tests/shopify-orders.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const src  = readFileSync(join(raiz, 'functions/api/shopify-orders.js'), 'utf8');
// Carrega só as constantes e funções puras (corta o handler HTTP)
const puro = src.slice(0, src.indexOf('export async function onRequest'));
const { parseLineItem, parseLineItemMulti, EXACT_TITLE_MAP, PRODUCT_MAP, normalizeColor, ITENS_MANUAIS } =
  new Function(puro + '; return { parseLineItem, parseLineItemMulti, EXACT_TITLE_MAP, PRODUCT_MAP, normalizeColor, ITENS_MANUAIS };')();

const MODELOS = new Function(readFileSync(join(raiz, 'data.js'), 'utf8') + '; return MODELOS;')();

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}
const parse = (title, variant_title) => {
  const r = parseLineItem({ title, variant_title, fulfillable_quantity: 1 }, '#TESTE', []);
  return r ? { modelo: r.modelKey, cor: r.color, tam: r.sizeIdx } : null;
};

console.log('\n1) Produto UNIFICADO: a cor vem da variante, nunca da regra fixa');
ok('Conjunto Peace + "Preto / M"',   parse('Conjunto Peace', 'Preto / M'),   { modelo:'conjunto-peace', cor:'Preto',   tam:2 });
ok('Conjunto Peace + "Nude / M"',    parse('Conjunto Peace', 'Nude / M'),    { modelo:'conjunto-peace', cor:'Nude',    tam:2 });
ok('Calça Peace + "Preto / M"',      parse('Calça Peace', 'Preto / M'),      { modelo:'calca-peace',    cor:'Preto',   tam:2 });
ok('Calça Peace + "Marsala / GG"',   parse('Calça Peace', 'Marsala / GG'),   { modelo:'calca-peace',    cor:'Marsala', tam:4 });
ok('Macacão Manga Longa + "Militar / G"', parse('Macacão Manga Longa', 'Militar / G'), { modelo:'macacao-manga-longa', cor:'Militar', tam:3 });

// Pedido #8602 (Mavi Marques): título "Saia Midi Fenda Frontal" + variante "Preto / G".
// "Fenda Frontal" faz parte do NOME do modelo, não é cor — era lido como cor e a peça
// preta sumia numa cor inexistente.
ok('Saia Midi Fenda Frontal + "Preto / G"', parse('Saia Midi Fenda Frontal', 'Preto / G'), { modelo:'saia-midi', cor:'Preto', tam:3 });
ok('Saia Midi Fenda Frontal + "Marrom / M"', parse('Saia Midi Fenda Frontal', 'Marrom / M'), { modelo:'saia-midi', cor:'Marrom', tam:2 });
ok('Saia Midi (nome curto) + "Preto / P"',   parse('Saia Midi', 'Preto / P'),               { modelo:'saia-midi', cor:'Preto', tam:1 });

console.log('\n2) Pedido ANTIGO sem cor: a regra fixa continua valendo');
ok('Conjunto Peace + "M"', parse('Conjunto Peace', 'M'), { modelo:'conjunto-peace', cor:'Off White', tam:2 });
ok('Calça Peace + "P"',    parse('Calça Peace', 'P'),    { modelo:'calca-peace',    cor:'Marsala',   tam:1 });

console.log('\n3) Produto por cor no título (pré-unificação)');
ok('Calça Peace Marsala + "M"',       parse('Calça Peace Marsala', 'M'),       { modelo:'calca-peace', cor:'Marsala', tam:2 });
ok('Mini Saia Canelada Branca + "P"', parse('Mini Saia Canelada Branca', 'P'), { modelo:'mini-saia-canelada', cor:'Branco', tam:1 });

console.log('\n4) Cores: branco ≠ off white, e acento/caixa normalizados');
ok('branca → Branco',    normalizeColor('Branca'),   'Branco');
ok('offwhite → Off White', normalizeColor('Offwhite'), 'Off White');
ok('preta → Preto',      normalizeColor('preta'),    'Preto');
ok('petroleo → Petróleo', normalizeColor('Petroleo'), 'Petróleo');

console.log('\n5) Tamanho ilegível não vira peça fantasma');
ok('variante null → ignorado',  parse('Calça Peace', null), null);
ok('tamanho XPTO → ignorado',   parse('Calça Peace', 'XPTO'), null);

console.log('\n5b) G1 é tamanho válido (grade PP..GG + G1), índice 5');
ok('G1 → índice 5',                parse('Calça Pantalona', 'Cinza / G1'), { modelo:'calca-pantalona-viscolycra', cor:'Cinza', tam:5 });
ok('G1 na Pantalona Moletom',      parse('Calça Pantalona Moletom', 'Preto / G1'), { modelo:'calca-pantalona', cor:'Preto', tam:5 });
ok('GG continua no índice 4',      parse('Calça Pantalona', 'Cinza / GG'), { modelo:'calca-pantalona-viscolycra', cor:'Cinza', tam:4 });
// os 4 modelos que vendem G1 precisam declarar o tamanho no data.js, senão a peça
// entra num índice que o modelo não tem e some da tela
for (const k of ['calca-pantalona-viscolycra', 'calca-pantalona', 'cropped-moletom', 'conjunto-boho']) {
  ok(`${k} declara G1 na grade`, (MODELOS[k].tamanhos || []).includes('G1'), true);
}

console.log('\n6) Armadilha estrutural: título do EXACT_TITLE_MAP que é produto unificado');
// Se um título do mapa de cor fixa também existir como produto unificado, a cor da
// variante TEM que vencer. Este teste roda para todas as entradas do mapa.
for (const [titulo, regra] of Object.entries(EXACT_TITLE_MAP)) {
  const r = parse(titulo, 'Preto / M');
  ok(`"${titulo}" + variante com cor → Preto (não "${regra.color}")`, r && r.cor, 'Preto');
}

console.log('\n7) Toda cor fixa do mapa existe no modelo do data.js');
for (const [titulo, regra] of Object.entries(EXACT_TITLE_MAP)) {
  const def = MODELOS[regra.modelKey];
  ok(`${titulo} → ${regra.modelKey}/${regra.color} existe no catálogo`,
     !!(def && (def.cores.includes(regra.color) || Object.keys(def.aberto).includes(regra.color))), true);
}

console.log('\n8) Todo modelKey citado no PRODUCT_MAP existe no data.js');
const orfaos = [...new Set(Object.values(PRODUCT_MAP))].filter(k => !MODELOS[k]);
ok('sem modelKey órfão', orfaos, []);

console.log('\n8b) Conjunto com título próprio não pode casar com o conjunto errado');
// #8748: "Conjunto Cropped Canelado + Calça Pantalona Cinza" (variante só com o tamanho).
// O casamento por prefixo é ganancioso e casou com o Conjunto Calça Pantalona + Cropped
// MOLETOM, jogando todo o resto do título para dentro da "cor". Resultado: três avisos de
// cor inexistente e — o que importa — a peça ERRADA indo para a produção (moletom no lugar
// de canelado). Confirmado com a Bárbara em 10/08/2026.
const conj = (title, variant_title) =>
  parseLineItemMulti({ title, variant_title, fulfillable_quantity: 1 }, '#8748', [])
    .map(r => ({ modelo: r.modelKey, cor: r.color, tam: r.sizeIdx }));

ok('#8748 vira as DUAS peças certas',
   conj('Conjunto Cropped Canelado + Calça Pantalona Cinza', 'G'),
   [{ modelo:'cropped-canelado', cor:'Cinza', tam:3 },
    { modelo:'calca-pantalona-viscolycra', cor:'Cinza', tam:3 }]);
ok('NÃO vira o conjunto do cropped moletom',
   conj('Conjunto Cropped Canelado + Calça Pantalona Cinza', 'G')
     .some(p => p.modelo === 'conjunto-calca-pantalona-cropped' || p.modelo === 'cropped-moletom'), false);
ok('a cor sai do título e volta ao formato do cadastro (não "CINZA")',
   conj('Conjunto Cropped Canelado + Calça Pantalona Cinza', 'G')[0].cor, 'Cinza');
ok('cor de duas palavras também',
   conj('Conjunto Cropped Canelado + Calça Pantalona Off White', 'P')[0].cor, 'Off White');
ok('se a cor vier na variante, ela manda',
   conj('Conjunto Cropped Canelado + Calça Pantalona', 'Marsala / GG')[0].cor, 'Marsala');
ok('o conjunto do cropped MOLETOM continua funcionando como antes',
   conj('Conjunto Calça Pantalona com Cropped moletom', 'Cinza / G'),
   [{ modelo:'conjunto-calca-pantalona-cropped', cor:'Cinza', tam:3 }]);
ok('Cinza foi cadastrado no Cropped Canelado (pedidos #8719 e #8748)',
   (MODELOS['cropped-canelado'].cores || []).includes('Cinza'), true);
// Toda peça declarada nesses conjuntos tem que existir de verdade
const CONJ_TITULO = new Function(puro + '; return CONJUNTOS_POR_TITULO;')();
Object.entries(CONJ_TITULO).forEach(([titulo, pecas]) => {
  pecas.forEach(k => ok(`${k} existe no data.js`, !!MODELOS[k], true));
  ok(`"${titulo.slice(0, 28)}…" tem 2+ peças`, pecas.length >= 2, true);
});

console.log('\n9) Item montado à mão no pedido, com tamanho por peça');
// #8719: item digitado direto no pedido (sem produto na Shopify, variante null) juntando
// DUAS peças em tamanhos DIFERENTES. Sem mapa vira "produto não mapeado", o pedido some da
// produção e ninguém corta a peça. Conjunto normal não resolve: lá o tamanho escolhido vale
// para todas as peças. Modelos confirmados com a Bárbara em 10/08/2026.
const TITULO_8719 = 'CONJUNTO CALÇA PANTALONA BOLSO FRONTAL CINZA GG E CROPPED M';
const multi = (title, fq = 1) =>
  parseLineItemMulti({ title, variant_title: null, fulfillable_quantity: fq }, '#8719', [])
    .map(r => ({ modelo: r.modelKey, cor: r.color, tam: r.sizeIdx }));

ok('#8719 vira DUAS peças', multi(TITULO_8719).length, 2);
ok('a calça é a Pantalona Viscolycra Cinza GG',
   multi(TITULO_8719)[0], { modelo: 'calca-pantalona-viscolycra', cor: 'Cinza', tam: 4 });
ok('o cropped é o Canelado Cinza M — tamanho DIFERENTE da calça',
   multi(TITULO_8719)[1], { modelo: 'cropped-canelado', cor: 'Cinza', tam: 2 });
ok('caixa e espaço extra não quebram o mapa',
   multi('conjunto  calça pantalona bolso frontal cinza gg e cropped m ').length, 2);
ok('item devolvido (nada a enviar) não vira peça', multi(TITULO_8719, 0).length, 0);
ok('item normal continua passando pelo parser de sempre',
   parseLineItemMulti({ title: 'Conjunto Peace', variant_title: 'Preto / M', fulfillable_quantity: 1 }, '#T', [])
     .map(r => ({ modelo: r.modelKey, cor: r.color, tam: r.sizeIdx })),
   [{ modelo: 'conjunto-peace', cor: 'Preto', tam: 2 }]);
ok('produto realmente desconhecido continua sendo denunciado', (() => {
  const ig = [];
  parseLineItemMulti({ title: 'PRODUTO QUE NAO EXISTE XPTO', variant_title: 'Preto / M', fulfillable_quantity: 1 }, '#T', ig);
  return ig.length > 0;
})(), true);
// Modelo e tamanho declarados no mapa precisam existir de verdade
Object.entries(ITENS_MANUAIS).forEach(([, pecas]) => {
  pecas.forEach(p => {
    ok(`${p.modelKey} existe no data.js`, !!MODELOS[p.modelKey], true);
    const grade = (MODELOS[p.modelKey] && MODELOS[p.modelKey].tamanhos) || ['PP', 'P', 'M', 'G', 'GG'];
    ok(`tamanho ${p.size} existe na grade de ${p.modelKey}`, grade.includes(p.size), true);
  });
});

console.log('');
console.log('10) Conjunto Good (Short + Regata em moletom careca)');
// #8991 (02/09/2026): o produto existia na loja mas não no cadastro do sistema — o item
// caía em "produto não mapeado" e o pedido ficava fora da conta de produção. Cores e grade
// são as da loja: Preto e Vermelho, PP–GG.
ok('#8991: Conjunto Good + "Preto / G"', parse('Conjunto Good', 'Preto / G'),
   { modelo: 'conjunto-good', cor: 'Preto', tam: 3 });
ok('a cor vem da variante, não de regra fixa', parse('Conjunto Good', 'Vermelho / PP'),
   { modelo: 'conjunto-good', cor: 'Vermelho', tam: 0 });
ok('as três chaves existem no data.js',
   ['conjunto-good', 'short-good', 'regata-good'].every(k => !!MODELOS[k]), true);
// O conjunto só entra na produção se distribuir para as peças (senão vira peça fantasma que
// ninguém corta): quem manda nisso é o CONJUNTO_PECAS do main.js.
const SRC_MAIN = readFileSync(join(raiz, 'main.js'), 'utf8');
const INI_CP = SRC_MAIN.indexOf('const CONJUNTO_PECAS = {');
const CONJ_PECAS = new Function(SRC_MAIN.slice(INI_CP, SRC_MAIN.indexOf('};', INI_CP) + 2)
  + '; return CONJUNTO_PECAS;')();
ok('o conjunto distribui para as DUAS peças', CONJ_PECAS['conjunto-good'], ['short-good', 'regata-good']);
['short-good', 'regata-good'].forEach(k => {
  ok(`${k}: cores batem com as da loja`, MODELOS[k].cores, ['Preto', 'Vermelho']);
  ok(`${k}: tecido é o moletom careca`, MODELOS[k].tecido, 'Moletom Careca');
  ok(`${k}: toda cor da loja tem linha em aberto{}`,
     ['Preto', 'Vermelho'].every(c => Array.isArray(MODELOS[k].aberto[c])), true);
});

console.log(`\n${falhas === 0 ? '✅ TODOS OS TESTES PASSARAM' : '❌ ' + falhas + ' FALHA(S)'} — ${total - falhas}/${total}\n`);
process.exit(falhas === 0 ? 0 : 1);
