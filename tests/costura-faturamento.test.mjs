/**
 * Teste do FATURAMENTO DA COSTURA (main.js).
 *
 * POR QUE ISTO EXISTE: aqui o que está em jogo é quanto se paga a uma pessoa. Um erro não
 * aparece na tela como bug — aparece como leva cobrada duas vezes, ou como leva entregue que
 * nunca entrou na conta. O que estes testes travam:
 *   1. leva sai de "Em costura" = entrega, e vira valor a pagar UMA vez só;
 *   2. o valor é congelado na entrega (mexer na Precificação depois não reescreve o combinado);
 *   3. leva que volta pra costura com carimbo novo fecha a rodada anterior, sem juntar as duas;
 *   4. leva sem peça nenhuma não vira cobrança;
 *   5. o aparelho da costureira só LÊ: não sincroniza e não marca pago;
 *   6. nada disso lança no Fluxo de Caixa — que já cobra corte+costura pelas vendas.
 *
 * Rodar:  node tests/costura-faturamento.test.mjs
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

const F = new Function(extrair('cstFatAplicar') + '\n' + extrair('cstFatEntregar')
  + '\n' + extrair('flxCustoModelo')
  + '; return { cstFatAplicar, cstFatEntregar, flxCustoModelo };')();

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

const vazio = () => ({ abertas: {}, aPagar: {}, pagas: [] });
const AGORA = '2026-08-15T12:00:00.000Z';
const naMaquina = { 'saia-midi|1': { ref: 'r1', nome: 'Saia Midi', pecas: 10, unit: 4.5, desde: 'r1' } };

console.log('\n1) Entrar em costura ainda não é cobrança');
const d1 = F.cstFatAplicar(vazio(), naMaquina, AGORA);
ok('a leva entra no retrato', Object.keys(d1.abertas), ['saia-midi|1']);
ok('e nada vai para "a pagar" ainda', Object.keys(d1.aPagar).length, 0);
ok('rodar de novo sem mudança não gera gravação', F.cstFatAplicar(d1, naMaquina, AGORA), null);

console.log('\n2) Sair de "Em costura" É a entrega');
const d2 = F.cstFatAplicar(d1, {}, AGORA);
ok('some do retrato', Object.keys(d2.abertas).length, 0);
ok('e vira uma linha a pagar', Object.keys(d2.aPagar), ['saia-midi|1|r1']);
ok('com peças × valor da época', [d2.aPagar['saia-midi|1|r1'].pecas, d2.aPagar['saia-midi|1|r1'].unit, d2.aPagar['saia-midi|1|r1'].valor], [10, 4.5, 45]);
ok('e a data da entrega', d2.aPagar['saia-midi|1|r1'].entregue_em, AGORA);
ok('passar de novo não cobra duas vezes', F.cstFatAplicar(d2, {}, AGORA), null);

console.log('\n3) O valor é congelado na entrega');
// a Precificação subiu de 4,50 para 9,00 DEPOIS da entrega
const d3 = F.cstFatAplicar(d2, { 'saia-midi|1': { ref: 'r2', nome: 'Saia Midi', pecas: 10, unit: 9, desde: 'r2' } }, AGORA);
ok('a leva já entregue continua valendo o que valia', d3.aPagar['saia-midi|1|r1'].valor, 45);
ok('e a rodada nova entra pelo valor novo', d3.abertas['saia-midi|1'].unit, 9);

console.log('\n4) Leva que volta pra costura fecha a rodada anterior');
const d4 = F.cstFatAplicar(d3, { 'saia-midi|1': { ref: 'r3', nome: 'Saia Midi', pecas: 4, unit: 9, desde: 'r3' } }, AGORA);
ok('a rodada r2 vira cobrança própria', d4.aPagar['saia-midi|1|r2'].valor, 90);
ok('sem se misturar com a r1', [d4.aPagar['saia-midi|1|r1'].valor, Object.keys(d4.aPagar).length], [45, 2]);
ok('e a r3 fica aberta com as peças novas', d4.abertas['saia-midi|1'].pecas, 4);

console.log('\n5) O que não pode virar cobrança');
const semPeca = F.cstFatAplicar({ abertas: { 'x|1': { ref: 'r', nome: 'X', pecas: 0, unit: 5 } }, aPagar: {}, pagas: [] }, {}, AGORA);
ok('leva sem peça nenhuma some sem cobrar', [Object.keys(semPeca.abertas).length, Object.keys(semPeca.aPagar).length], [0, 0]);
const jaPaga = F.cstFatAplicar(
  { abertas: { 'y|1': { ref: 'r', nome: 'Y', pecas: 3, unit: 5 } }, aPagar: {}, pagas: [{ id: 'y|1|r', valor: 15 }] }, {}, AGORA);
ok('leva que já foi paga não volta a aparecer em aberto', Object.keys(jaPaga.aPagar).length, 0);

console.log('\n6) O valor por peça sai da Precificação (mesmo cálculo do Fluxo)');
const pc = { global: { custoMetro: 12 }, modelos: { 'saia-midi': { costura: 4.5, corte: 2, consumo: 1 }, 'blusa': { costura: 3 } } };
ok('modelo comum', F.flxCustoModelo(pc, 'saia-midi').costura, 4.5);
ok('modelo sem valor cadastrado devolve 0 (a tela avisa)', F.flxCustoModelo(pc, 'nao-cadastrado').costura, 0);

console.log('\n7) A costureira só LÊ; e nada vai para o Fluxo de Caixa');
ok('sincronização só roda no app da dona',
   /async function cstFatSincronizar\(\) \{\s*\r?\n\s*if \(ehPerfilOficina\(\)\) return;/.test(main), true);
ok('marcar pago também tem a trava de perfil',
   /async function cstFatPagar\([^)]*\) \{\s*\r?\n\s*if \(ehPerfilOficina\(\)\) return;/.test(main), true);
ok('e o botão "pago" nem é desenhado para ela',
   /const podePagar = !ehPerfilOficina\(\);/.test(main), true);
const bloco = main.slice(main.indexOf('const CST_FAT_KEY'), main.indexOf('// ─── O QUE FOI REALMENTE CORTADO'));
ok('o faturamento não cria conta a pagar no Fluxo (seria o mesmo custo duas vezes)',
   /flxAdd|flxSalvar|flxLancar|vendasIncluir/.test(bloco), false);
ok('a linha do Supabase é própria, sem tabela nova', /const CST_FAT_KEY  = 'costura-faturamento';/.test(main), true);

console.log('\n8) Mora DENTRO da aba COSTURA, e não em aba própria');
ok('renderCostura desenha o card do faturamento',
   /function renderCostura\(\)[\s\S]*?renderFaturamento\(\);/.test(main), true);
ok('e o card é o mesmo "ver mais" das outras faixas',
   /el\.innerHTML = avisoCardHTML\('ti-cash', 'FATURAMENTO DA COSTURA'/.test(main), true);
ok('sem valor ao lado do título — os números vivem na frase de baixo',
   /avisoCardHTML\('ti-cash', 'FATURAMENTO DA COSTURA', '',/.test(main), true);
ok('e o selo do total nem é desenhado quando vem vazio',
   /\$\{tot \? `<span class="aviso-tot">\$\{tot\}<\/span>` : ''\}/.test(main), true);
ok('não sobrou aba/rota própria de faturamento', /__faturamento__|abrirFaturamento/.test(main), false);
ok('fechado, o resumo tem "na máquina agora (ainda não entregue)" e "em corte"',
   /\['Na máquina agora', 'ainda não entregue', totalAgora\][\s\S]{0,80}\['Em corte', '', totalCorte\]/.test(main), true);
ok('"entregue e não pago" só entra no resumo quando existe',
   /concat\(totalAPagar \? \[\['Entregue e não pago'/.test(main), true);
ok('o valor do corte é só do corte (o tecido em compra não entra nele)',
   /const totalCorte  = vindo\.filter\(l => l\.etapa === 'Em corte'\)/.test(main), true);
const idx = readFileSync(join(raiz, 'index.html'), 'utf8');
ok('o lugar dele no HTML fica logo abaixo do que vem por aí',
   idx.indexOf('id="costura-corte"') < idx.indexOf('id="faturamento-lista"')
   && idx.indexOf('id="faturamento-lista"') < idx.indexOf('FICHAS EM COSTURA'), true);
ok('e o painel avulso sumiu', /panel-faturamento/.test(idx), false);
ok('e nunca grava por cima sem conseguir ler antes',
   /const nuvem = await carregarNuvem\(CST_FAT_KEY\);\s*\r?\n\s*if \(nuvem === undefined\) return;/.test(main), true);

console.log(falhas ? `\n✗ ${total - falhas}/${total} passaram` : `\n✓ ${total}/${total} passaram`);
process.exit(falhas ? 1 : 0);
