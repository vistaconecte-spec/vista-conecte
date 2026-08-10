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
const { parseLineItem, EXACT_TITLE_MAP, PRODUCT_MAP, normalizeColor } =
  new Function(puro + '; return { parseLineItem, EXACT_TITLE_MAP, PRODUCT_MAP, normalizeColor };')();

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

console.log(`\n${falhas === 0 ? '✅ TODOS OS TESTES PASSARAM' : '❌ ' + falhas + ' FALHA(S)'} — ${total - falhas}/${total}\n`);
process.exit(falhas === 0 ? 0 : 1);
