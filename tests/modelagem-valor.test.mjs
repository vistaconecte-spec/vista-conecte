/**
 * Teste do total a pagar à modelista (main.js + functions/api/modelagem-list.js).
 *
 * POR QUE ISTO EXISTE: o valor do ajuste é digitado LIVRE em cada modelo ("50", "50,00",
 * "R$ 50,00", "1.250,00"). Somar isso com parseFloat direto dá errado em pt-BR: "1.250,00"
 * viraria 1,25 e "50,00" viraria 50 por sorte. Como o número vira dinheiro que a dona vai
 * pagar, um erro de vírgula aqui é erro de caixa.
 *
 * Rodar:  node tests/modelagem-valor.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const html = readFileSync(join(raiz, 'index.html'), 'utf8');
const api  = readFileSync(join(raiz, 'functions/api/modelagem-list.js'), 'utf8');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}
const mdlValorNum = new Function(
  main.slice(main.indexOf('function mdlValorNum'), main.indexOf('\n}', main.indexOf('function mdlValorNum'))) + '\n}'
  + '; return mdlValorNum;')();

console.log('\n1) Lê o valor digitado do jeito que a dona digita');
ok('"50"',           mdlValorNum('50'), 50);
ok('"50,00"',        mdlValorNum('50,00'), 50);
ok('"50,50"',        mdlValorNum('50,50'), 50.5);
ok('"R$ 50,00"',     mdlValorNum('R$ 50,00'), 50);
ok('"r$50"',         mdlValorNum('r$50'), 50);
ok('" 50 "',         mdlValorNum(' 50 '), 50);
ok('"1.250,00" (ponto de milhar)', mdlValorNum('1.250,00'), 1250);
ok('"1.250,50"',     mdlValorNum('1.250,50'), 1250.5);
ok('"50.00" (ponto decimal)',      mdlValorNum('50.00'), 50);

console.log('\n2) O que não é número não vira dinheiro do nada');
ok('vazio',          mdlValorNum(''), 0);
ok('só espaço',      mdlValorNum('   '), 0);
ok('null',           mdlValorNum(null), 0);
ok('undefined',      mdlValorNum(undefined), 0);
ok('texto',          mdlValorNum('combinar'), 0);
ok('"R$"',           mdlValorNum('R$'), 0);

console.log('\n3) A soma bate');
const linhaSoma = main.slice(main.indexOf('const mdlSomaValores'));
const mdlSomaValores = new Function(
  linhaSoma.slice(0, linhaSoma.indexOf('\n')) + '; return mdlSomaValores;')();
const soma = arr => mdlSomaValores(arr.map(mdlValorNum));
ok('50,00 + 1.250,00 + 30 = 1330', soma(['50,00', '1.250,00', '30']), 1330);
ok('valor ilegível não estraga a soma', soma(['50,00', 'combinar', '30']), 80);
// ponto flutuante puro daria 30.999999999999996 aqui
ok('centavos somam certo, sem lixo de ponto flutuante', soma(['10,10', '10,20', '10,70']), 31);
ok('a soma crua erraria', ['10,10','10,20','10,70'].map(mdlValorNum).reduce((a,b)=>a+b,0) === 31, false);

console.log('\n4) A tela mostra o total e de onde ele vem');
const card = main.slice(main.indexOf('function mdlRenderTotalModelista'), main.indexOf('function mdlRenderLista'));
ok('soma só o que dá para ler', /mdlSomaValores\(validos\.map\(p => p\.num\)\)/.test(card), true);
ok('separa o que não deu para somar', /ilegiveis/.test(card), true);
ok('e avisa quais foram, em vez de sumir com eles', /ficaram de fora do total/.test(card), true);
ok('mostra modelo a modelo, não só o total', /validos\.map\(p =>/.test(card), true);
ok('dá para clicar e abrir o modelo', /onclick="mdlAbrirDetalhe\(\$\{p\.id\}\)"/.test(card), true);
ok('formata como dinheiro em pt-BR', /currency: 'BRL'/.test(main), true);
ok('o lugar do card existe no HTML', /id="mdl-total-modelista"/.test(html), true);
ok('esconde quando ninguém tem valor lançado', /if \(!comValor\.length\) \{ el\.style\.display = 'none'/.test(card), true);

console.log('\n5) O valor chega na listagem e o total se atualiza sozinho');
ok('a API devolve valorAjuste na lista', /valorAjuste: p\.valorAjuste \|\| ''/.test(api), true);
ok('e busca a coluna no banco', /select=id,title,category,status,createdAt,valorAjuste/.test(api), true);
ok('salvar o valor atualiza a lista em memória', /if \(naLista\) naLista\.valorAjuste = valorAjuste/.test(main), true);
ok('voltar para a lista recalcula o total', /function mdlVoltarLista\(\)[\s\S]{0,220}mdlRenderLista\(\)/.test(main), true);

console.log(`\n${falhas === 0 ? '✓ TODOS OS TESTES PASSARAM' : '✗ ' + falhas + ' FALHA(S)'} — ${total - falhas}/${total}\n`);
process.exit(falhas === 0 ? 0 : 1);
