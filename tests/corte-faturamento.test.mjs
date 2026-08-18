/**
 * Teste do FATURAMENTO DO CORTE (main.js).
 *
 * POR QUE ISTO EXISTE: é quanto se paga a uma pessoa. O risco aqui não é a tela quebrar —
 * é pagar o valor da COSTURA pelo corte (o de costura é 2 a 3 vezes maior), ou uma entrega
 * não entrar na conta. O que estes testes travam:
 *   1. o valor por peça é o campo `corte` da Precificação, nunca o de costura;
 *   2. o núcleo é o MESMO da costura (cstFatAplicar/cstFatEntregar) — não uma cópia que
 *      envelhece sozinha: a correção de 18/08 (rodada repetida sumindo) tem que valer aqui;
 *   3. a oficina só LÊ: não sincroniza e não marca pago;
 *   4. nada disso lança no Fluxo de Caixa (que já cobra corte+costura pelas vendas);
 *   5. "vem por aí" do corte é só tecido em compra — o que está em costura já passou.
 *
 * Rodar:  node tests/corte-faturamento.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const idx  = readFileSync(join(raiz, 'index.html'), 'utf8');

function extrair(nome) {
  const i = main.indexOf(`function ${nome}(`);
  if (i < 0) throw new Error(`função ${nome} não encontrada em main.js`);
  const fim = main.indexOf('\n}', i);
  return main.slice(i, fim + 2);
}

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

console.log('\n1) O valor por peça é o do CORTE — nunca o da costura');
const F = new Function('MODELOS', 'CONJUNTO_PECAS', 'flxPrecoCfg',
  extrair('flxCustoModelo') + '\n' + extrair('crtValorPeca') + '\n' + extrair('cstValorPeca')
  + '; return { crtValorPeca, cstValorPeca };')(
  { 'macacao-amplo': {} }, {},
  () => ({ global: {}, modelos: { 'macacao-amplo': { corte: 6.9, costura: 17 } } }));
ok('corte do Macacão Amplo',   F.crtValorPeca('macacao-amplo'), 6.9);
ok('e não o de costura',       F.crtValorPeca('macacao-amplo') !== F.cstValorPeca('macacao-amplo'), true);
ok('modelo sem valor dá 0 (a tela avisa, não soma escondido)', F.crtValorPeca('nao-existe'), 0);

console.log('\n2) O núcleo é o MESMO da costura, não uma cópia');
const sinc = main.slice(main.indexOf('async function crtFatSincronizar'),
                        main.indexOf('\n}', main.indexOf('async function crtFatSincronizar')));
ok('reaproveita cstFatAplicar', /cstFatAplicar\(/.test(sinc), true);
ok('não recriou uma função de aplicar só para o corte', /function crtFatAplicar\(/.test(main), false);
ok('nem uma de entregar', /function crtFatEntregar\(/.test(main), false);

console.log('\n3) A oficina só LÊ');
ok('sincronização trava no perfil',
   /async function crtFatSincronizar\(\) \{\s*\r?\n\s*if \(ehPerfilOficina\(\)\) return;/.test(main), true);
ok('marcar pago também',
   /async function crtFatPagar\([^)]*\) \{\s*\r?\n\s*if \(ehPerfilOficina\(\)\) return;/.test(main), true);
ok('e recarrega a nuvem antes de decidir quem saiu do corte',
   /if \(ehPerfilOficina\(\)\) return;[\s\S]{0,300}await carregarTodosNuvem\(\);[\s\S]{0,120}const atuais = crtFatAbertasAgora\(\);/.test(main), true);
ok('nunca grava por cima sem ler antes',
   /const nuvem = await carregarNuvem\(CRT_FAT_KEY\);\s*\r?\n\s*if \(nuvem === undefined\) return;/.test(sinc), true);

console.log('\n4) Linha própria no Supabase, e nada no Fluxo de Caixa');
ok('linha própria', /const CRT_FAT_KEY = 'corte-faturamento';/.test(main), true);
const bloco = main.slice(main.indexOf('const CRT_FAT_KEY'), main.indexOf('// ─── O QUE FOI REALMENTE CORTADO'));
ok('não cria conta a pagar no Fluxo (seria o mesmo custo duas vezes)',
   /flxAdd|flxSalvar|flxLancar|vendasIncluir/.test(bloco), false);
ok('e não encosta na linha da costura', /CST_FAT_KEY/.test(bloco), false);

console.log('\n5) As etapas certas');
ok('"na mesa agora" olha Em corte',        /cstLevasDe\('Em corte'\)/.test(bloco), true);
ok('"vem por aí" é só tecido em compra',   /cstLevasDe\('Comprando tecido'\)/.test(bloco), true);
// O CARD não pode olhar costura — "vem por aí" do corte é só tecido em compra, porque o
// que já está em costura passou pela mesa. O resgate (abaixo) olha, e é de propósito.
const render = main.slice(main.indexOf('function renderFaturamentoCorte'), main.indexOf('// ─── O QUE FOI REALMENTE CORTADO'));
ok('e o card não mistura o que já está em costura', /cstLevasDe\('Em costura'\)/.test(render), false);

console.log('\n5b) Leva que JÁ está em costura também é corte a receber');
// Ela passou pela mesa: o corte está feito. Sem isto ficariam de fora tudo o que já estava
// em costura quando este faturamento nasceu, e qualquer status que pule com o app fechado.
const resg = main.slice(main.indexOf('function crtFatResgatarCostura'), main.indexOf('async function crtFatSincronizar'));
ok('o resgate existe e olha as levas em costura', /cstLevasDe\('Em costura'\)/.test(resg), true);
ok('só entra quem não tem cobrança NENHUMA (não paga duas vezes)',
   /const jaTem = Object.keys\(d.aPagar\)[\s\S]{0,200}d.pagas.some/.test(resg) && /if \(jaTem\) return;/.test(resg), true);
ok('leva ainda tida como na mesa fica com o fluxo normal', /if \(d.abertas\[id\]\) return;/.test(resg), true);
ok('leva vazia não vira cobrança', /if \(!l.total\) return;/.test(resg), true);
ok('o registro fica marcado de onde veio', /origem: 'costura'/.test(resg), true);
ok('e roda nas duas passadas do sincronizador (local e nuvem)',
   (main.match(/crtFatResgatarCostura\(/g) || []).length, 3);

console.log('\n6) Mora na aba CORTE, junto das fichas');
ok('o div existe no HTML', /id="corte-faturamento"/.test(idx), true);
ok('acima do card das fichas',
   idx.indexOf('id="corte-faturamento"') < idx.indexOf('</i> FICHAS PARA CORTAR'), true);
ok('renderCorte desenha o card', /renderFaturamentoCorte\(\); \/\//.test(main), true);
ok('mesmo card "ver mais" das outras faixas',
   /avisoCardHTML\('ti-cash', 'FATURAMENTO DO CORTE', '',/.test(main), true);
ok('congela junto com o da costura, nos mesmos pontos',
   (main.match(/crtFatSincronizar\(\)\.catch/g) || []).length,
   (main.match(/cstFatSincronizar\(\)\.catch/g) || []).length);

console.log(falhas ? `\n✗ ${total - falhas}/${total} passaram` : `\n✓ ${total}/${total} passaram`);
process.exit(falhas ? 1 : 0);
