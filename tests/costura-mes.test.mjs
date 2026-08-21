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
const nomes = ['cstFatMesDe', 'cstFatMes', 'cstFatMesLabel', 'cstFatInicioSemana', 'cstFatSemana'];
const { cstFatMesDe, cstFatMes, cstFatMesLabel, cstFatInicioSemana, cstFatSemana } =
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

console.log('\n5) A semana do acerto (segunda → domingo)');
const seg = new Date(2026, 7, 17, 9, 0, 0);   // segunda-feira
const qui = new Date(2026, 7, 20, 9, 0, 0);   // quinta da mesma semana
const dom = new Date(2026, 7, 23, 23, 0, 0);  // domingo à noite: ainda é a mesma semana
ok('a semana começa na segunda', new Date(cstFatInicioSemana(qui)).getDate(), 17);
ok('e domingo à noite ainda pertence a ela', cstFatInicioSemana(dom), cstFatInicioSemana(seg));
ok('a segunda seguinte já abre outra', cstFatInicioSemana(new Date(2026, 7, 24, 8, 0, 0)) > cstFatInicioSemana(dom), true);

const semanal = {
  aPagar: {
    s1: { id: 's1', pecas: 5, valor: 50, entregue_em: new Date(2026, 7, 18, 10, 0).toISOString() }, // terça desta semana
    s2: { id: 's2', pecas: 2, valor: 20, entregue_em: new Date(2026, 7, 20, 10, 0).toISOString() }, // quinta desta semana
    s0: { id: 's0', pecas: 4, valor: 40, entregue_em: new Date(2026, 7, 13, 10, 0).toISOString() }, // quinta PASSADA, não paga
  },
  pagas: [{ id: 'sp', pecas: 3, valor: 30, entregue_em: new Date(2026, 7, 19, 10, 0).toISOString(), pago_em: new Date(2026, 7, 21, 10, 0).toISOString() }],
};
const sem = cstFatSemana(semanal, qui);
ok('"entregue essa semana (a receber)" só conta o que ainda não foi pago', sem.aReceber.valor, 70);
ok('em levas', sem.aReceber.levas, 2);
ok('o que ficou de antes sem pagamento aparece separado', sem.antes.valor, 40);
ok('e o entregue da semana conta também o que já foi pago', sem.entregue.valor, 100);

console.log('\n6) Na tela');
const r = main.slice(main.indexOf('function renderFaturamento()'), main.indexOf('// ─── AVIAMENTOS A COMPRAR'));
ok('o card monta o mês corrente e o anterior', /const mes    = cstFatMes\(d, mesAtual\);/.test(r) && /cstFatMes\(d, chaveAnt\)/.test(r), true);
ok('o bloco do mês é o PRIMEIRO do card', /const corpo = blocoMes \+/.test(r), true);
ok('com o total a receber em destaque', /linMes\('TOTAL A RECEBER'/.test(r), true);
ok('e a linha do que vai entrar no total: a receber + na máquina + vem por aí',
   /const totalPrevisto = Math\.round\(\(mes\.aReceber\.valor \+ totalAgora \+ totalVindo\) \* 100\) \/ 100;/.test(r), true);
ok('ela vem DEPOIS do "a receber" — é previsão, não pode ocupar o lugar do que já é dela',
   r.indexOf("linMes('TOTAL A RECEBER'") < r.indexOf("linMes('TOTAL QUE VAI ENTRAR'"), true);
ok('e o bloco fecha com a previsão do mês (o que já foi pago conta; tecido em compra não)',
   /const totalMes = Math\.round\(\(mes\.entregue\.valor \+ totalAgora \+ totalCorte\) \* 100\) \/ 100;/.test(r), true);

console.log('\n7) As cinco linhas do resumo fechado, na ordem que ela pediu');
const bloco5 = r.slice(r.indexOf('const resumo = ['), r.indexOf('const frase ='));
const rotulos = ["['Total já entregue em '", "['Entregue essa semana'", "['Na máquina agora'", "['Em corte'", "['Total do mês'"];
ok('as cinco estão lá', rotulos.filter(t => bloco5.includes(t)).length, 5);
ok('nesta ordem', rotulos.map(t => bloco5.indexOf(t)).every((v, i, a) => i === 0 || v > a[i - 1]), true);
ok('e nenhuma outra linha se meteu no meio', (bloco5.match(/\['/g) || []).length, 5);
ok('a linha da semana avisa quando sobrou saldo de antes (senão parece ser tudo que ela tem a receber)',
   /semana\.antes\.valor \? ` · mais \$\{finBRL\(semana\.antes\.valor\)\} de antes` : ''/.test(r), true);
ok('"em corte" continua dizendo que é previsão — sem isso a linha se lê como custo de corte',
   /\['Em corte', 'previsão do que vai entrar', totalCorte\]/.test(r), true);
ok('e o total do mês fecha a lista', /\['Total do mês', 'entregue \+ na máquina \+ em corte', totalMes\]/.test(r), true);
ok('o mês vem do relógio local, como a função', /hoje\.getFullYear\(\) \+ '-' \+ String\(hoje\.getMonth\(\) \+ 1\)/.test(r), true);
ok('a costureira vê tudo isso — o card inteiro só esconde BOTÃO dela (podePagar)',
   /const podePagar = !ehPerfilOficina\(\);/.test(r) && !/ehPerfilOficina\(\) \? '' : blocoMes/.test(r), true);

console.log(falhas ? `\n✗ ${total - falhas}/${total} passaram` : `\n✓ ${total}/${total} passaram`);
process.exit(falhas ? 1 : 0);
