/**
 * Teste do estoque que nao subia para a nuvem (main.js).
 *
 * POR QUE ISTO EXISTE: em 09/09/2026 a dona digitou o estoque do Cropped Canelado, viu
 * "Salvo" na tela, trocou de aba e o numero voltou. Duas coisas se somavam:
 *   1. digitar no estoque so mostrava o botao Salvar - nada subia sozinho;
 *   2. o aviso "Salvo" acendia em QUALQUER gravacao bem-sucedida, inclusive a do ciclo do
 *      corte, que grava de minuto em minuto. O aviso dizia "Salvo" sem ela ter salvado.
 *
 * Rodar:  node tests/salvar-estoque.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  X ${nome}` + '\n' + `      esperado: ${JSON.stringify(esperado)}` + '\n' + `      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ok ${nome}`);
}

console.log('\n' + '1) Digitar estoque ou producao sobe para a nuvem sozinho');
for (const fn of ['marcarEstEditado', 'marcarProdEditado', 'marcarProd2Editado']) {
  const linha = main.split('\n').find(l => l.startsWith(`function ${fn}`)) || '';
  ok(`${fn} chama autoSave`, /autoSave\(/.test(linha), true);
}
ok('o botao Salvar continua existindo', /function salvarManual\(\)/.test(main), true);
ok('autoSave aceita o tempo de espera', /function autoSave\(ms = 800\)/.test(main), true);

console.log('\n' + '2) O aviso "Salvo" so acende para o que a pessoa fez');
ok('salvarNuvemREST recebe opts', /async function salvarNuvemREST\(key, dados, opts = \{\}\)/.test(main), true);
ok('showCloudOk depende de opts.silencioso', /if \(!opts\.silencioso\) showCloudOk\(\);/.test(main), true);
ok('so ha um showCloudOk no caminho de sucesso', (main.match(/showCloudOk\(\);/g) || []).length, 1);
ok('salvarNuvem repassa opts', /async function salvarNuvem\(key, dados, opts\) \{[\s\S]{0,80}salvarNuvemREST\(key, dados, opts\)/.test(main), true);

console.log('\n' + '3) As gravacoes que rodam sozinhas nao acendem o aviso');
// O ciclo do corte grava de minuto em minuto; o historico, a cada save. Nenhum dos dois
// e acao da pessoa, e era o do corte que fazia o "Salvo" fantasma aparecer.
for (const alvo of ['CORTE_PRIO_KEY, novo', 'CST_FAT_KEY, novo', 'CRT_FAT_KEY, novo',
                    'CORTE_KEY, novo', 'LEDGER_BAIXAS, ledger']) {
  const trecho = alvo + ', { silencioso: true }';
  ok(`${alvo.split(',')[0]} grava em silencio`, main.includes(trecho), true);
}
ok('o historico nunca acende o aviso',
   /salvarNuvemREST\(hk, \{ v: v\.slice\(0, HIST_MAX\) \}, \{ silencioso: true \}\)/.test(main), true);

console.log('\n' + '4) O erro continua aparecendo, silencioso ou nao');
ok('showCloudError segue avisando em qualquer gravacao', main.includes('  showCloudError();'), true);

console.log('\n5) O "Atualizado em" acompanha o save');
// POR QUE ISTO EXISTE: o carimbo era escrito só no desenho da tela, e salvar não pode
// redesenhar a tabela (apagaria a digitação). Em 09/09/2026 a dona contou a arara do
// Cropped Canelado, os números subiram para a nuvem e o cabeçalho continuou em 13:33.
ok('existe uma função só para os carimbos',
   main.includes('function renderCarimbosAtualizacao(d)'), true);
ok('salvarModelo repinta o carimbo',
   main.includes('renderCarimbosAtualizacao(data);'), true);
ok('o carimbo não é mais escrito na mão dentro do render',
   (main.match(/Atualizado em [$]/g) || []).length, 1);
ok('os três cards passam pela mesma função',
   ['est-updated', 'prod-updated', 'prod2-updated'].every(id => main.includes(`por('${id}'`)), true);

console.log(falhas ? `\nX ${falhas} de ${total} falharam\n` : `\n${total}/${total} passaram\n`);
process.exit(falhas ? 1 : 0);
