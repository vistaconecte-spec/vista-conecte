/**
 * Teste do "Tudo para o estoque" (main.js) — as fichas em costura viram estoque de uma vez.
 *
 * POR QUE ISTO EXISTE: a costureira entrega a leva inteira de uma vez, e o botão "→ Estoque"
 * existia só dentro da tela de cada modelo. Com seis levas na máquina, eram seis telas.
 *
 * O que estes testes travam:
 *   1. a leva ser SOMADA ao estoque e ZERADA (leva que não zera renasce no fallback da tela
 *      e a peça passa a ser contada duas vezes: no estoque e em produção);
 *   2. grade maior que 5 (G1, calçado 34-40) não perder tamanho no caminho — o botão da tela
 *      do modelo mapeia sobre um estoque de 5 posições e descarta o resto em silêncio;
 *   3. a leva sair de "Em costura" sem carimbo, que é como a entrega é reconhecida;
 *   4. a sincronização do faturamento rodar ANTES (retrato) e DEPOIS (vira a pagar);
 *   5. o botão não existir para a oficina nem quando não há ficha na tela.
 *
 * Rodar:  node tests/costura-estoque.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz  = join(dirname(fileURLToPath(import.meta.url)), '..');
const main  = readFileSync(join(raiz, 'main.js'), 'utf8');
const index = readFileSync(join(raiz, 'index.html'), 'utf8');

function extrair(nome) {
  const i = main.indexOf(`function ${nome}(`);
  if (i < 0) throw new Error(`função ${nome} não encontrada em main.js`);
  const fim = main.indexOf('\n}', i);
  return main.slice(i, fim + 2);
}
const { levaParaEstoque } = new Function(extrair('levaParaEstoque') + '; return { levaParaEstoque };')();

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

console.log('\n1) A leva vira estoque e some da produção');
const s1 = {
  est:  { Preto: [1, 0, 2, 0, 0], Militar: [0, 0, 0, 0, 0] },
  prod: { Preto: [0, 3, 1, 0, 0], Militar: [0, 0, 0, 0, 0] },
};
const t1 = levaParaEstoque(s1, ['Preto', 'Militar'], 1, 5);
ok('somou tamanho a tamanho no que já havia', s1.est.Preto, [1, 3, 3, 0, 0]);
ok('cor sem produção fica como estava', s1.est.Militar, [0, 0, 0, 0, 0]);
ok('a leva zera — inclusive a cor que já estava zerada', s1.prod, { Preto: [0, 0, 0, 0, 0], Militar: [0, 0, 0, 0, 0] });
ok('devolve quantas peças entraram', t1, 4);

console.log('\n2) Grade maior que 5 não perde tamanho (G1, calçado 34-40)');
const s2 = { est: { Preto: [0, 0, 0, 0, 0] }, prod: { Preto: [1, 1, 1, 1, 1, 2, 3] } };
ok('as sete posições entram no estoque', (levaParaEstoque(s2, ['Preto'], 1, 7), s2.est.Preto), [1, 1, 1, 1, 1, 2, 3]);
ok('e a leva zera com a grade inteira', s2.prod.Preto, [0, 0, 0, 0, 0, 0, 0]);

console.log('\n3) A 2ª leva tem caminho próprio');
const s3 = { est: {}, prod: { Preto: [9, 0, 0, 0, 0] }, prod2: { Preto: [0, 0, 4, 0, 0] } };
levaParaEstoque(s3, ['Preto'], 2, 5);
ok('estoque nasce quando não existia', s3.est.Preto, [0, 0, 4, 0, 0]);
ok('a 2ª leva zerou', s3.prod2.Preto, [0, 0, 0, 0, 0]);
ok('e a leva 1 não foi tocada', s3.prod.Preto, [9, 0, 0, 0, 0]);

console.log('\n4) O fechamento da leva');
const f = main.slice(main.indexOf('async function mandarTudoParaEstoque()'), main.indexOf('function abrirCostura(item)'));
ok('sai de "Em costura" sem status e sem carimbo (é assim que a entrega é reconhecida)',
   /saved\.status\s+= '';\s+saved\.status_at\s+= null/.test(f) && /saved\.status2 = '';\s+saved\.status2_at = null/.test(f), true);
ok('sincroniza o faturamento ANTES (retrato) e DEPOIS (vira a pagar)',
   (f.match(/cstFatSincronizar\(\)/g) || []).length >= 2, true);
ok('e o retrato é tirado antes de listar as levas',
   f.indexOf('cstFatSincronizar()') < f.indexOf("cstLevasDe('Em costura')"), true);
ok('sobe modelo a modelo pelo caminho normal', /await salvarNuvem\(key, saved\)/.test(f), true);
ok('pede confirmação — mexe em estoque, que é número de venda', /if \(!confirm\(/.test(f), true);
ok('e diz o que vai acontecer com a leva', /entram no ESTOQUE/.test(f), true);

console.log('\n5) Quem pode fechar');
ok('a função sai fora no perfil de oficina', /if \(ehPerfilOficina\(\)\) return;/.test(f), true);
ok('o botão existe no card FICHAS EM COSTURA', /id="cst-btn-estoque"[^>]*onclick="mandarTudoParaEstoque\(\)"/.test(index), true);
ok('nasce escondido no HTML', /id="cst-btn-estoque"[^>]*display:none/.test(index), true);
ok('e só aparece para a dona, com ficha na tela',
   /btnEst\.style\.display = \(levas\.length && !ehPerfilOficina\(\)\)/.test(main), true);

console.log(falhas ? `\n✗ ${total - falhas}/${total} passaram` : `\n✓ ${total}/${total} passaram`);
process.exit(falhas ? 1 : 0);
