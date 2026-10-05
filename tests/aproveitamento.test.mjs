/**
 * Teste do aproveitamento do corte no card PRODUÇÃO ACIMA DO NECESSÁRIO (main.js).
 *
 * POR QUE ISTO EXISTE: em 05/10/2026 o card acusava 29 peças a mais e nenhuma era erro:
 * 14 eram pilotos e 13 o cortador cortou além da ficha porque a Bárbara pediu para usar
 * o tecido. Peça de aproveitamento vem marcada na leva (`aprov`/`aprov2`) e sai do alerta,
 * mas só na MESMA leva: leva nova não pode herdar o aproveitamento da anterior, senão o
 * card volta a esconder sobra de verdade.
 *
 * Rodar:  node tests/aproveitamento.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const html = readFileSync(join(raiz, 'index.html'), 'utf8');

function extrair(nome) {
  const i = main.indexOf(`function ${nome}(`);
  if (i < 0) throw new Error(`função ${nome} não encontrada em main.js`);
  const fim = main.indexOf('\n}', i);
  return main.slice(i, fim + 2);
}
const funcs = ['chaveCor', 'coresDoModelo', 'sobrasNaCompra', 'aproveitamentoDaLeva'].map(extrair).join('\n');
const ap = new Function('saved', 'leva', `${extrair('aproveitamentoDaLeva')}\nreturn aproveitamentoDaLeva(saved, leva);`);

// O bloco do card, rodado de verdade com um DOM de mentira
const iCard = main.indexOf('// ── Card Produção acima do necessário');
const fCard = main.indexOf('// ── Card Em Produção');
const card = main.slice(iCard, fCard);
function rodarCard(MODELOS, salvos, pilotos = []) {
  const els = {};
  const document = { getElementById: id => (els[id] = els[id] || { style: {}, innerHTML: '', textContent: '' }) };
  new Function('document', 'MODELOS', 'CONJUNTO_PECAS', 'ehPiloto', 'loadLocal',
    `${funcs}\n${card}`)(document, MODELOS, {}, k => pilotos.includes(k), k => salvos[k.slice(3)] || null);
  return els;
}

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a === b) console.log(`  ✓ ${nome}`);
  else { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${b}\n      veio:     ${a}`); }
}

const T0 = '2026-10-01T20:55:20.254Z';
const DEF = () => ({ nome: 'Saia Midi', cores: ['Preto'], aberto: { Preto: [0,0,1,0,0] } });

console.log('\n1) Quando o aproveitamento vale');
{
  const base = { status: 'Em costura', status_at: T0, prod: { Preto: [0,0,2,0,0] } };
  ok('mesma leva (at = status_at) → vale', ap({ ...base, aprov: { at: T0, cores: { Preto: [0,0,1,0,0] } } }, 1), { Preto: [0,0,1,0,0] });
  ok('leva nova (status_at depois) → não vale', ap({ ...base, status_at: '2026-10-09T10:00:00.000Z', aprov: { at: T0, cores: { Preto: [0,0,1,0,0] } } }, 1), null);
  ok('leva em compra → não vale', ap({ ...base, status: 'Comprando tecido', aprov: { at: T0, cores: { Preto: [0,0,1,0,0] } } }, 1), null);
  ok('sem aprov → null', ap(base, 1), null);
  ok('2ª leva lê aprov2 e status2', ap({ status2: 'Em corte', status2_at: T0, aprov2: { at: T0, cores: { Nude: [1] } } }, 2), { Nude: [1] });
}

console.log('\n2) Card: aproveitamento sai do alerta e vira linha à parte');
{
  // pedido M1, leva cortada M2, 1 de aproveitamento → nenhuma sobra de verdade
  const els = rodarCard({ 'saia-midi': DEF() }, { 'saia-midi': { status: 'Em costura', status_at: T0, prod: { Preto: [0,0,2,0,0] }, aprov: { at: T0, cores: { Preto: [0,0,1,0,0] } } } });
  ok('total de sobra vazio', els['dash-duplicado-total'].textContent, '');
  ok('card continua visível', els['card-duplicado'].style.display, '');
  ok('título vira APROVEITAMENTO DO CORTE', /APROVEITAMENTO DO CORTE/.test(els['dash-duplicado-titulo'].innerHTML), true);
  ok('linha cita o modelo e a peça', /Aproveitamento do corte, 1 peça[\s\S]*Saia Midi 1/.test(els['dash-duplicado'].innerHTML), true);
  ok('sem tabela de sobra', /<table>/.test(els['dash-duplicado'].innerHTML), false);
}

console.log('\n3) Card: sobra de verdade continua acusando, mesmo com aproveitamento junto');
{
  // pedido M1, leva M3, aproveitamento 1 → 1 sobra de verdade + 1 aproveitamento
  const els = rodarCard({ 'saia-midi': DEF() }, { 'saia-midi': { status: 'Em costura', status_at: T0, prod: { Preto: [0,0,3,0,0] }, aprov: { at: T0, cores: { Preto: [0,0,1,0,0] } } } });
  ok('1 peça a mais', els['dash-duplicado-total'].textContent, '1 peça a mais');
  ok('título de alerta', /PRODUÇÃO ACIMA DO NECESSÁRIO/.test(els['dash-duplicado-titulo'].innerHTML), true);
  ok('tabela e linha de aproveitamento juntas', /<table>[\s\S]*Aproveitamento do corte, 1 peça/.test(els['dash-duplicado'].innerHTML), true);
}

console.log('\n4) Card: aproveitamento velho não esconde a leva nova');
{
  const els = rodarCard({ 'saia-midi': DEF() }, { 'saia-midi': { status: 'Em corte', status_at: '2026-10-09T10:00:00.000Z', prod: { Preto: [0,0,2,0,0] }, aprov: { at: T0, cores: { Preto: [0,0,1,0,0] } } } });
  ok('1 peça a mais', els['dash-duplicado-total'].textContent, '1 peça a mais');
  ok('sem linha de aproveitamento', /Aproveitamento do corte/.test(els['dash-duplicado'].innerHTML), false);
}

console.log('\n5) Card: aproveitamento não passa da leva (pedido novo consome a peça)');
{
  // pedido M2, leva M2 com 1 de aproveitamento → nada sobra, nada de aproveitamento a mostrar
  const def = DEF(); def.aberto.Preto = [0,0,2,0,0];
  const els = rodarCard({ 'saia-midi': def }, { 'saia-midi': { status: 'Em costura', status_at: T0, prod: { Preto: [0,0,2,0,0] }, aprov: { at: T0, cores: { Preto: [0,0,1,0,0] } } } });
  ok('card escondido', els['card-duplicado'].style.display, 'none');
}

console.log('\n6) Piloto fora do card');
{
  const els = rodarCard({ 'top-v': { nome: 'Top V', cores: ['Preto'], aberto: {} } }, { 'top-v': { status: 'Em costura', status_at: T0, prod: { Preto: [0,1,0,0,0] } } }, ['top-v']);
  ok('card escondido', els['card-duplicado'].style.display, 'none');
}

console.log('\n7) Tela');
ok('título do card tem id para trocar o texto', /id="dash-duplicado-titulo"/.test(html), true);

console.log(falhas ? `\n✗ ${falhas} de ${total} falharam` : `\n✓ ${total}/${total} passaram`);
process.exit(falhas ? 1 : 0);
