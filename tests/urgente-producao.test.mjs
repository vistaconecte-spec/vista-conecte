/**
 * Teste do botão "Mandar tudo p/ produção" do card URGENTE — A PRODUZIR (main.js).
 *
 * POR QUE ISTO EXISTE: este botão grava leva de produção em vários modelos de uma vez. Se
 * ele escolher a leva errada ou repetir o que a outra leva já produz, o tecido é comprado
 * em dobro — o mesmo erro de 28/07/2026, agora multiplicado por todos os modelos do card.
 *
 * Rodar:  node tests/urgente-producao.test.mjs
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
const nomes = ['chaveCor', 'coresDoModelo', 'tamanhosDe', 'necessidadeLeva', 'calcFaltaLiquido',
               'prodTotalCor', 'urgentesParaProducao'];

// Roda a função com um "mundo" montado à mão: catálogo + o que está salvo por modelo
function rodar(MODELOS, salvos, CONJUNTO_PECAS = {}) {
  const corpo = nomes.map(extrair).join('\n');
  return new Function('MODELOS', 'CONJUNTO_PECAS', 'salvos',
    `const loadLocal = k => salvos[k.replace('vc:', '')] || null;\n${corpo}\nreturn urgentesParaProducao();`
  )(MODELOS, CONJUNTO_PECAS, salvos);
}

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

const MOD = {
  saia:  { nome: 'Mini Saia Canelada',      cores: ['Preto'], aberto: { Preto: [0,1,3,1,0] } },
  calca: { nome: 'Calça Pantalona Moletom', cores: ['Bege'],  aberto: { Bege:  [0,1,0,2,2] } },
};

console.log('\n1) Modelo parado (sem leva em produção) entra na leva 1');
{
  const r = rodar(MOD, { saia: {}, calca: {} });
  ok('as duas urgências viram leva', r.levas.map(l => [l.nome, l.leva, l.total]),
     [['Mini Saia Canelada', 1, 5], ['Calça Pantalona Moletom', 1, 5]]);
  ok('quantidade gravada por cor = o que falta', r.levas[0].prod, { Preto: [0,1,3,1,0] });
  ok('ninguém fica bloqueado', r.bloqueados, []);
}

console.log('\n2) Estoque e produção já existente são descontados');
{
  const r = rodar(MOD, { saia: { est: { Preto: [0,1,0,0,0] } }, calca: { est: { Bege: [0,0,0,2,2] } } });
  ok('saia: 5 pedidos − 1 estoque = 4', r.levas.find(l => l.leva && l.nome.includes('Saia')).prod, { Preto: [0,0,3,1,0] });
  ok('calça: só o P continua faltando', r.levas.find(l => l.nome.includes('Calça')).total, 1);
}

console.log('\n3) Leva 1 já em produção → a nova vai para a 2ª leva, descontando a leva 1');
{
  const r = rodar(MOD, {
    saia:  { status: 'Em corte', prod: { Preto: [0,1,1,0,0] } },
    calca: {},
  });
  const saia = r.levas.find(l => l.nome.includes('Saia'));
  ok('saia recebe 2ª leva', saia.leva, 2);
  ok('2ª leva pede só o que a leva 1 não cobre', saia.prod, { Preto: [0,0,2,1,0] });
}

console.log('\n4) As duas levas em produção → modelo fica de fora, e é avisado');
{
  const r = rodar(MOD, {
    saia:  { status: 'Em corte', prod: { Preto: [0,1,1,0,0] }, status2: 'Comprando tecido', prod2: { Preto: [0,0,1,0,0] } },
    calca: {},
  });
  ok('só a calça entra', r.levas.map(l => l.nome), ['Calça Pantalona Moletom']);
  ok('a saia é listada como bloqueada', r.bloqueados, ['Mini Saia Canelada']);
}

console.log('\n5) Nada urgente → nada a gravar (e conjunto nunca entra)');
{
  ok('produção em dia não gera leva',
     rodar(MOD, { saia: { est: { Preto: [0,1,3,1,0] } }, calca: { est: { Bege: [0,1,0,2,2] } } }).levas, []);
  ok('conjunto é ignorado (as peças dele já contam sozinhas)',
     rodar(MOD, { saia: {}, calca: {} }, { saia: true, calca: true }).levas, []);
}

console.log('\n6) Tamanho único conta por total, na posição 0');
{
  const MODTU = { bolsa: { nome: 'Bolsa', cores: ['Preto'], tamanhoUnico: true, aberto: { Preto: [1,2,0,0,0] } } };
  ok('3 pedidos, 1 no estoque → 2 na posição 0',
     rodar(MODTU, { bolsa: { est: { Preto: [1,0,0,0,0] } } }).levas[0].prod, { Preto: [2,0,0,0,0] });
}

console.log('\n7) A ordem é do mais urgente para o menos');
{
  const r = rodar({
    a: { nome: 'A', cores: ['X'], aberto: { X: [0,1,0,0,0] } },
    b: { nome: 'B', cores: ['X'], aberto: { X: [0,9,0,0,0] } },
  }, { a: {}, b: {} });
  ok('maior falta primeiro', r.levas.map(l => l.nome), ['B', 'A']);
}

console.log(falhas ? `\n✗ ${falhas} de ${total} falharam` : `\n✓ ${total}/${total} passaram`);
process.exit(falhas ? 1 : 0);
