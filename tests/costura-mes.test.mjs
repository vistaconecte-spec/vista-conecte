/**
 * Teste do fechamento do MÊS da costureira (main.js) — o card FATURAMENTO DA COSTURA passou
 * a abrir com o total do mês: o que ela entregou e o que ainda tem a receber.
 *
 * POR QUE ISTO EXISTE: os blocos do card mostram leva a leva; somar seis linhas na mão é
 * onde a conta dela diverge da conta da dona.
 *
 * O que estes testes travam:
 *   1. o mês ser o da ENTREGA, não o do pagamento (leva entregue em julho e paga em agosto
 *      é trabalho de julho);
 *   2. o mês sair do relógio LOCAL — `slice(0,7)` do ISO joga a entrega das 21h do dia 31
 *      para o mês seguinte, bem na virada, que é quando ela confere;
 *   3. "a receber" ser o total em aberto HOJE, de qualquer mês, com a parte antiga separada;
 *   4. o bloco do mês ser o PRIMEIRO do card e a linha do mês abrir o resumo fechado.
 *
 * Rodar:  node tests/costura-mes.test.mjs
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
const nomes = ['cstFatMesDe', 'cstFatMes', 'cstFatMesLabel'];
const { cstFatMesDe, cstFatMes, cstFatMesLabel } =
  new Function(nomes.map(extrair).join('\n') + `; return { ${nomes.join(', ')} };`)();

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

console.log('\n1) O mês sai do relógio local, não do ISO cru');
const viraDoMes = new Date(2026, 6, 31, 22, 0, 0).toISOString(); // 31/07 22h no fuso daqui
ok('entrega das 22h do dia 31 continua sendo do mês 07', cstFatMesDe(viraDoMes), '2026-07');
ok('e o ISO cru mostraria por que a conta ingênua erra', cstFatMesDe(viraDoMes) === viraDoMes.slice(0, 7),
   viraDoMes.slice(0, 7) === '2026-07'); // igual só onde o fuso não vira o dia
ok('sem data, sem mês', cstFatMesDe(''), '');
ok('rótulo em português', cstFatMesLabel('2026-08'), 'agosto de 2026');

const iso = (a, m, d) => new Date(a, m - 1, d, 12, 0, 0).toISOString();
const dados = {
  aPagar: {
    a1: { id: 'a1', nome: 'Vestido Amplo', pecas: 10, unit: 12, valor: 120, entregue_em: iso(2026, 8, 5) },
    a2: { id: 'a2', nome: 'Saia Midi',     pecas:  4, unit: 10, valor:  40, entregue_em: iso(2026, 8, 19) },
    a3: { id: 'a3', nome: 'Calça Flare',   pecas:  5, unit: 10, valor:  50, entregue_em: iso(2026, 7, 28) },
  },
  pagas: [
    // entregue em agosto, paga em agosto
    { id: 'p1', nome: 'Macacão', pecas: 6, unit: 15, valor: 90, entregue_em: iso(2026, 8, 2), pago_em: iso(2026, 8, 10) },
    // entregue em JULHO, paga em agosto — é trabalho de julho
    { id: 'p2', nome: 'Cropped', pecas: 3, unit: 10, valor: 30, entregue_em: iso(2026, 7, 30), pago_em: iso(2026, 8, 3) },
  ],
};
const ago = cstFatMes(dados, '2026-08');
const jul = cstFatMes(dados, '2026-07');

console.log('\n2) O total de agosto');
ok('entregue no mês soma pago + a pagar', ago.entregue.valor, 250);
ok('em peças', ago.entregue.pecas, 20);
ok('em levas', ago.entregue.levas, 3);
ok('já pago no mês', ago.pago.valor, 90);
ok('entregue e ainda não pago (do mês)', ago.aberto.valor, 160);

console.log('\n3) "O que ela vai receber" é tudo que está em aberto hoje');
ok('total a receber inclui a leva de julho ainda sem pagamento', ago.aReceber.valor, 210);
ok('e a parte vinda de meses anteriores aparece separada', ago.atrasado.valor, 50);
ok('com a contagem de levas', ago.atrasado.levas, 1);

console.log('\n4) Mês do pagamento não move a entrega');
ok('a leva paga em agosto conta como entrega de julho', jul.entregue.valor, 80);
ok('e em julho ela já está paga', jul.pago.valor, 30);
ok('sobrando o que julho ainda não recebeu', jul.aberto.valor, 50);

console.log('\n5) Na tela');
const r = main.slice(main.indexOf('function renderFaturamento()'), main.indexOf('// ─── AVIAMENTOS A COMPRAR'));
ok('o card monta o mês corrente e o anterior', /const mes    = cstFatMes\(d, mesAtual\);/.test(r) && /cstFatMes\(d, chaveAnt\)/.test(r), true);
ok('o bloco do mês é o PRIMEIRO do card', /const corpo = blocoMes \+/.test(r), true);
ok('com o total a receber em destaque', /linMes\('TOTAL A RECEBER'/.test(r), true);
ok('e o resumo fechado abre pelo mês dela', /const resumo = \[\s*\['Entregue em ' \+ cstFatMesLabel/.test(r), true);
ok('o mês vem do relógio local, como a função', /hoje\.getFullYear\(\) \+ '-' \+ String\(hoje\.getMonth\(\) \+ 1\)/.test(r), true);
ok('a costureira vê tudo isso — o card inteiro só esconde BOTÃO dela (podePagar)',
   /const podePagar = !ehPerfilOficina\(\);/.test(r) && !/ehPerfilOficina\(\) \? '' : blocoMes/.test(r), true);

console.log(falhas ? `\n✗ ${total - falhas}/${total} passaram` : `\n✓ ${total}/${total} passaram`);
process.exit(falhas ? 1 : 0);
