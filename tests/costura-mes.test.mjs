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
const nomes = ['cstFatMesDe', 'cstFatMes', 'cstFatMesLabel', 'cstFatInicioSemana', 'cstFatSemana', 'fatMesesDisponiveis', 'fatLevasDoMes'];
const { cstFatMesDe, cstFatMes, cstFatMesLabel, cstFatInicioSemana, cstFatSemana, fatMesesDisponiveis, fatLevasDoMes } =
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

console.log('\n6) O seletor de mês (14/09/2026)');
// A Bárbara achou o card confuso: mês corrente, semana, a receber de qualquer mês e o mês
// anterior tudo num bloco só. Agora se escolhe o mês, e cada mês mostra o seu.
ok('os meses vão do mais antigo com entrega até o corrente, sem buraco, mais recente primeiro',
   fatMesesDisponiveis(dados, '2026-09'), ['2026-09', '2026-08', '2026-07']);
ok('sem entrega nenhuma, só o mês corrente', fatMesesDisponiveis({ aPagar: {}, pagas: [] }, '2026-09'), ['2026-09']);
ok('entrega no futuro não abre mês adiante do corrente', fatMesesDisponiveis(dados, '2026-07'), ['2026-07']);
ok('as levas do mês juntam pagas e a receber, na ordem da entrega',
   fatLevasDoMes(dados, '2026-08').map(p => p.id), ['p1', 'a1', 'a2']);
ok('e julho tem a paga em agosto (é entrega de julho) mais a que ficou aberta',
   fatLevasDoMes(dados, '2026-07').map(p => p.id), ['a3', 'p2']);

console.log('\n7) Na tela: o card mês a mês');
const r = main.slice(main.indexOf('function fatCardHTML('), main.indexOf('function renderFaturamento()'));
ok('o seletor é a primeira coisa do corpo, seguido do bloco do mês, das levas do mês e do HOJE',
   /seletor \+ blocoMes \+ blocoLevas \+ blocoHoje \+ blocoAgora \+ blocoVindo \+ aviso/.test(r), true);
ok('com seta para trás, a lista dos meses e seta para a frente',
   /fatMudarMes\('\$\{cfg\.qual\}', -1\)/.test(r) && /fatEscolherMes\('\$\{cfg\.qual\}', this\.value\)/.test(r) && /fatMudarMes\('\$\{cfg\.qual\}', 1\)/.test(r), true);
ok('a seta para a frente trava no mês corrente', /\$\{ehAtual \? 'disabled' : ''\} title="mês seguinte"/.test(r), true);
ok('o mês escolhido nunca é futuro',
   /function fatMesSelecionado\(qual\) \{[\s\S]*?return \(sel && sel <= hoje\) \? sel : hoje;/.test(main), true);
ok('o mês vem do relógio local, como a função', /function fatMesChave\(d\) \{\s*\r?\n\s*return d\.getFullYear\(\) \+ '-' \+ String\(d\.getMonth\(\) \+ 1\)/.test(main), true);
ok('o bloco do mês abre com pago e a receber DO MÊS',
   /linMes\('Já pago', nLevas\(mes\.pago\.levas\), mes\.pago\.valor\)[\s\S]{0,40}linMes\('Entregue e ainda não pago'[\s\S]{0,120}mes\.aberto\.valor\)/.test(r), true);
ok('no mês corrente, segue com o que está na etapa, a previsão e o total (as quatro somadas)',
   /ehAtual\s*\r?\n\s*\? linMes\(cfg\.agora\.rotulo, 'ainda não entregue', totalAgora\)\s*\r?\n\s*\+ linMes\(cfg\.previsao\.rotulo, 'previsão do que vai entrar', cfg\.previsao\.valor\)\s*\r?\n\s*\+ linMes\('TOTAL DO MÊS \(previsto\)', 'as quatro linhas acima somadas', totalMes, true\)/.test(r), true);
ok('e o total do mês é a soma EXATA dessas quatro (o a receber de meses anteriores fica fora, senão entra duas vezes)',
   /const totalMes = Math\.round\(\(mes\.pago\.valor \+ mes\.aberto\.valor \+ totalAgora \+ cfg\.previsao\.valor\) \* 100\) \/ 100;/.test(r), true);
ok('num mês passado, o total é o entregue (pago + a receber), sem previsão',
   /: linMes\('TOTAL DO MÊS', 'pago \+ a receber', mes\.entregue\.valor, true\)/.test(r), true);
ok('as levas do mês são UMA lista, cada uma dizendo se está paga ou a receber',
   /const levasMes = fatLevasDoMes\(d, sel\);/.test(r)
   && /p\.pago_em \? `<span class="fat-pago">pago em \$\{dia\(p\.pago_em\)\}<\/span>` : '<span class="fat-alerta">a receber<\/span>'/.test(r), true);
ok('com o botão certo ao lado: desfazer na paga, pago na aberta',
   /p\.pago_em\s*\r?\n\s*\? `<button[^`]*onclick="\$\{cfg\.pagar\}\('\$\{esc\(p\.id\)\}', true\)"[^`]*desfazer<\/button>`\s*\r?\n\s*: `<button[^`]*onclick="\$\{cfg\.pagar\}\('\$\{esc\(p\.id\)\}'\)"[^`]*pago<\/button>`/.test(r), true);
ok('o bloco HOJE mostra tudo a receber, de qualquer mês, com a semana do acerto',
   /'A RECEBER HOJE', mes\.aReceber\.valor,/.test(r) && /linMes\('Entregue essa semana', semana\.aReceber\.levas/.test(r), true);
ok('e avisa quanto disso é de meses anteriores, apontando o seletor',
   /mes\.atrasado\.valor && ehAtual[\s\S]{0,40}linMes\('Sendo de meses anteriores'/.test(r), true);
ok('a costureira vê tudo isso — o card inteiro só esconde BOTÃO dela (podePagar)',
   /const podePagar = !ehPerfilOficina\(\);/.test(r) && !/ehPerfilOficina\(\) \? '' : blocoMes/.test(r), true);
ok('trocar o mês redesenha o card certo', /if \(qual === 'corte'\) renderFaturamentoCorte\(\); else renderFaturamento\(\);/.test(main), true);

console.log(falhas ? `\n✗ ${total - falhas}/${total} passaram` : `\n✓ ${total}/${total} passaram`);
process.exit(falhas ? 1 : 0);
