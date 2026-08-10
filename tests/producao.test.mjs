/**
 * Teste das contas de produção (main.js).
 *
 * POR QUE ISTO EXISTE: em 28/07/2026 a leva 1 calculava "pedidos − estoque" sem descontar
 * a 2ª leva. Resultado: o sistema mandava comprar tecido de novo para peças que já estavam
 * na costura. Estes testes travam a regra: cada leva desconta a outra.
 *
 * Rodar:  node tests/producao.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');

// Extrai funções top-level pelo nome (terminam com "}" na coluna 0)
function extrair(nome) {
  const i = main.indexOf(`function ${nome}(`);
  if (i < 0) throw new Error(`função ${nome} não encontrada em main.js`);
  const fim = main.indexOf('\n}', i);
  return main.slice(i, fim + 2);
}
const nomes = ['chaveCor', 'corCanonica', 'coresDoModelo', 'necessidadeLeva', 'calcFaltaLeva',
               'calcFalta', 'calcFaltaLiquido', 'prodTotalCor'];
const F = new Function(nomes.map(extrair).join('\n') + `; return { ${nomes.join(', ')} };`)();

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

console.log('\n1) Uma leva NUNCA repete o que a outra já está produzindo');
// Caso real Calça Peace 28/07: Marsala M tinha 2 pedidos e 2 peças já na costura (2ª leva).
// A leva 1 pedia 2 de novo → tecido comprado em dobro.
ok('Marsala: 2 pedidos, 2 na 2ª leva → leva 1 não pede nada',
   F.necessidadeLeva([1,0,2,0,1], [0,0,0,1,1], [0,0,2,0,0], false, 5), [1,0,0,0,0]);
ok('sem 2ª leva, comporta-se como antes',
   F.necessidadeLeva([1,0,2,0,1], [0,0,0,1,1], [], false, 5), [1,0,2,0,0]);
ok('2ª leva maior que o pedido não gera número negativo',
   F.necessidadeLeva([0,0,1,0,0], [0,0,0,0,0], [0,0,5,0,0], false, 5), [0,0,0,0,0]);
ok('estoque também é descontado',
   F.necessidadeLeva([2,2,2,2,2], [1,1,1,1,1], [1,0,0,0,0], false, 5), [0,1,1,1,1]);

console.log('\n2) Tamanho único conta por TOTAL, estoque só na posição 0');
ok('4 pedidos − 2 estoque − 1 na outra leva = 1',
   F.necessidadeLeva([1,0,2,1,0], [2,0,0,0,0], [1,0,0,0,0], true, 5), [1,0,0,0,0]);
ok('total já coberto → zero',
   F.necessidadeLeva([1,1,0,0,0], [2,0,0,0,0], [], true, 5), [0,0,0,0,0]);

console.log('\n3) Falta líquida (card A PRODUZIR) desconta as DUAS levas');
ok('pedidos 7, estoque 0, levas 3+4 → 0',
   F.calcFaltaLiquido([2,0,2,3,0], [0,0,0,0,0], [2,0,2,3,0], false), 0);
ok('pedidos 7, estoque 0, levas 5 → falta 2',
   F.calcFaltaLiquido([2,0,2,3,0], [0,0,0,0,0], [2,0,2,1,0], false), 2);
ok('soma leva1+leva2 por cor', F.prodTotalCor({ prod:{ Preto:[1,0,1,0,0] }, prod2:{ Preto:[0,2,0,0,0] } }, 'Preto'), [1,2,1,0,0]);

console.log('\n4) Cor: caixa e acento não podem criar cor paralela');
ok('CINZA == Cinza',        F.chaveCor('CINZA') === F.chaveCor('Cinza'), true);
ok('Petroleo == Petróleo',  F.chaveCor('Petroleo') === F.chaveCor('Petróleo'), true);
ok('espaços não contam',    F.chaveCor(' Off  White ') === F.chaveCor('off white'), true);
const defCor = { cores:['Preto','Cinza'], aberto:{ Preto:[1,0,0,0,0], 'CINZA':[0,0,1,0,0] } };
ok('CINZA do pedido casa com Cinza do modelo', F.corCanonica(defCor, 'CINZA'), 'Cinza');
ok('cor realmente nova é preservada',          F.corCanonica(defCor, 'Roxo'),  'Roxo');

console.log('\n5) Pedido em cor não cadastrada NÃO pode sumir da tela');
const defTela = { cores:['Preto','Off White'], aberto:{ Preto:[1,0,0,0,0], 'Off White':[0,0,0,0,0], 'Verde Militar + Preta':[0,0,0,2,0] } };
ok('cor com pedido entra na lista', F.coresDoModelo(defTela, null), ['Preto','Off White','Verde Militar + Preta']);
ok('cor sem pedido e sem cadastro fica de fora',
   F.coresDoModelo({ cores:['Preto'], aberto:{ Preto:[1,0,0,0,0], Roxo:[0,0,0,0,0] } }, null), ['Preto']);
ok('cor salva pela usuária é mantida',
   F.coresDoModelo({ cores:['Preto'], aberto:{} }, { cores:['Preto','Telha'] }), ['Preto','Telha']);

console.log(`\n${falhas === 0 ? '✅ TODOS OS TESTES PASSARAM' : '❌ ' + falhas + ' FALHA(S)'} — ${total - falhas}/${total}\n`);
process.exit(falhas === 0 ? 0 : 1);
