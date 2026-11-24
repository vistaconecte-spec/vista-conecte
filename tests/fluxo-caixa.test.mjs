/**
 * Testes da aba FLUXO DE CAIXA renovada (24/11/2026).
 *
 * POR QUE ISTO EXISTE: a Bárbara pediu uma tela que diga de cara se a semana fecha. A conta
 * tem armadilhas silenciosas: mensal no dia 31 em mês curto, parcela que some ao mudar a
 * data, pagamento "sai do cofrinho" contado duas vezes, e celular e PC apagando o que o
 * outro marcou. Cada bloco abaixo trava uma delas.
 *
 * Rodar:  node tests/fluxo-caixa.test.mjs
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
// As duas constantes ficam juntas no main.js: do CX_AJUSTES_PADRAO até o fim do bloco CX_CATS.
const ini = main.indexOf('const CX_AJUSTES_PADRAO =');
const consts = main.slice(ini, main.indexOf('\n};', main.indexOf('const CX_CATS =', ini)) + 3);
const nomes = ['cxIso', 'cxSomaDias', 'cxSegunda', 'cxOcorrencias', 'cxInstancias', 'cxProjecao', 'cxDivida', 'cxMesclar', 'cxSemente'];
const cx = new Function(`${consts}\n${nomes.map(extrair).join('\n')}\nreturn { ${nomes.join(', ')} };`)();

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}
const datas = lst => lst.map(o => o.data);

console.log('\n1) Datas');
ok('segunda da terça 24/11/2026', cx.cxSegunda('2026-11-24'), '2026-11-23');
ok('segunda do domingo 29/11', cx.cxSegunda('2026-11-29'), '2026-11-23');
ok('segunda da própria segunda', cx.cxSegunda('2026-11-30'), '2026-11-30');
ok('soma dias vira o mês', cx.cxSomaDias('2026-11-28', 5), '2026-12-03');

console.log('\n2) Repetição');
{
  const sem = { id: 'nubank', freq: 'semanal', inicio: '2026-11-27', valor: 500 };
  ok('semanal toda sexta', datas(cx.cxOcorrencias(sem, '2026-11-24', '2026-12-12')), ['2026-11-27', '2026-12-04', '2026-12-11']);
  ok('semanal não aparece antes do início', datas(cx.cxOcorrencias(sem, '2026-11-01', '2026-11-26')), []);
  ok('semanal respeita o fim', datas(cx.cxOcorrencias(Object.assign({}, sem, { fim: '2026-12-05' }), '2026-11-24', '2026-12-31')), ['2026-11-27', '2026-12-04']);
  const m31 = { id: 'x', freq: 'mensal', inicio: '2027-01-31' };
  ok('mensal dia 31 cai no último dia de fevereiro', datas(cx.cxOcorrencias(m31, '2027-01-01', '2027-04-30')), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  const acordo = { id: 'acordo-mp', freq: 'mensal', inicio: '2026-12-07', parcelas: 12 };
  const tudo = cx.cxOcorrencias(acordo, '2000-01-01', '2100-01-01');
  ok('acordo tem 12 parcelas', tudo.length, 12);
  ok('última parcela do acordo em 07/11/2027', tudo[11], { data: '2027-11-07', n: 12 });
  ok('regra apagada não gera nada', cx.cxOcorrencias(Object.assign({}, sem, { apagado: true }), '2026-11-01', '2026-12-31'), []);
  ok('única fora do período', cx.cxOcorrencias({ freq: 'unica', inicio: '2026-12-11' }, '2026-11-24', '2026-11-30'), []);
}

console.log('\n3) O que foi marcado e mudado vale na lista');
{
  const cfg = {
    regras: {
      tecido: { id: 'tecido', desc: 'Tecido', valor: 4400, cat: 'producao', freq: 'semanal', inicio: '2026-11-30', estimado: true },
      alvaro: { id: 'alvaro', desc: 'Álvaro', valor: 6500, cat: 'divida', freq: 'unica', inicio: '2026-12-01', grupo: 'alvaro' },
    },
    estado: {
      'tecido@2026-11-30': { valor: 3980, pago: true, em: '2026-11-30' },
      'tecido@2026-12-07': { data: '2026-12-08' },
      'tecido@2026-12-14': { apagado: true },
    },
  };
  const l = cx.cxInstancias(cfg, '2026-11-24', '2026-12-20');
  ok('valor digitado substitui o estimado', l.filter(i => i.id === 'tecido@2026-11-30').map(i => [i.valor, i.estimado, i.pago]), [[3980, false, true]]);
  ok('ocorrência empurrada aparece na data nova', l.filter(i => i.regra === 'tecido').map(i => i.data), ['2026-11-30', '2026-12-08']);
  ok('ocorrência apagada some', l.some(i => i.id === 'tecido@2026-12-14'), false);
  ok('lista em ordem de data', datas(l), ['2026-11-30', '2026-12-01', '2026-12-08']);
  const empurrada = cx.cxInstancias({ regras: cfg.regras, estado: { 'alvaro@2026-12-01': { data: '2026-11-20' } } }, '2026-11-24', '2026-12-31');
  ok('ocorrência puxada pra antes do período sai dele', empurrada.some(i => i.regra === 'alvaro'), false);
}

console.log('\n4) Folga do caixa: o pior dia dos próximos 30');
{
  const base = { hoje: '2026-11-24', dias: 30, saldo: 4656, piso: 3500, entradaDia: 5000, dasPct: 10, metaDia: 1590, freteDia: 400, cofrinhoDia: 342, outrosDia: 300 };
  // líquido por dia = 5000 − 500 de DAS − 1590 − 400 − 342 − 300 = 1868
  const semConta = cx.cxProjecao(Object.assign({}, base, { contas: [] }));
  ok('sem conta nenhuma o pior dia é hoje', [semConta.pior.data, semConta.folga], ['2026-11-24', 1156]);
  const amanha = cx.cxProjecao(Object.assign({}, base, { contas: [{ data: '2026-11-25', valor: 10000 }] }));
  ok('conta grande amanhã vira o pior dia', [amanha.pior.data, amanha.pior.saldo], ['2026-11-25', 4656 + 1868 - 10000]);
  ok('falta aparece negativa', amanha.folga, 4656 + 1868 - 10000 - 3500);
  ok('detalhe da conta até o pior dia', [amanha.ate.entradas, amanha.ate.das, amanha.ate.contas], [5000, 500, 10000]);
  const dia8 = cx.cxProjecao(Object.assign({}, base, { saldo: 2000, entradaDia: 3000, contas: [{ data: '2026-12-02', valor: 6500 }] }));
  ok('conta do 8º dia entra (a 1ª versão olhava só 7)', dia8.pior.data, '2026-12-02');
  const atrasada = cx.cxProjecao(Object.assign({}, base, { contas: [{ data: '2026-11-20', valor: 3000 }] }));
  ok('atrasada pesa já hoje', [atrasada.pior.data, atrasada.pior.saldo], ['2026-11-24', 1656]);
  const caindo = cx.cxProjecao(Object.assign({}, base, { entradaDia: 1000, contas: [] }));
  ok('vendendo pouco o pior dia é o último', caindo.pior.data, '2026-12-24');
  ok('sem dados não quebra', cx.cxProjecao({ hoje: '2026-11-24' }).folga, 0);
}

console.log('\n5) Dívidas');
{
  const insts = [
    { grupo: 'alvaro', valor: 5000, pago: true, data: '2026-11-24' },
    { grupo: 'alvaro', valor: 6500, pago: false, data: '2026-12-01' },
    { grupo: 'alvaro', valor: 6491.2, pago: false, data: '2026-12-11' },
  ];
  const r = cx.cxDivida({ id: 'alvaro', total: 17991.2 }, insts);
  ok('fatura do Álvaro: pago e falta', [r.pago, r.falta, r.pct], [5000, 12991.2, 28]);
  ok('próxima parte é a de 01/12', r.proxima, { data: '2026-12-01', valor: 6500 });
  const s = cx.cxDivida({ id: 'simples', parcelas: 60, pagasAntes: 1, valorParcela: 3308.5 }, [{ grupo: 'simples', valor: 3308.5, pago: true, data: '2026-11-30' }]);
  ok('Simples conta as pagas antes da tela', [s.pagasN, s.pago, s.total], [2, 6617, 198510]);
  ok('falta nunca fica negativa', cx.cxDivida({ id: 'z', total: 100 }, [{ grupo: 'z', valor: 150, pago: true, data: '2026-01-01' }]).falta, 0);
}

console.log('\n6) Celular e PC não se apagam');
{
  const pc = { regras: { a: { id: 'a', valor: 100, alt: '2026-11-24T10:00:00Z' } }, estado: { 'a@2026-11-30': { pago: true, alt: '2026-11-24T12:00:00Z' } } };
  const cel = { regras: { a: { id: 'a', valor: 150, alt: '2026-11-24T11:00:00Z' }, b: { id: 'b', valor: 9, alt: '2026-11-24T11:00:00Z' } }, estado: {} };
  const m = cx.cxMesclar(pc, cel);
  ok('valor mais novo ganha', m.regras.a.valor, 150);
  ok('regra criada no celular fica', !!m.regras.b, true);
  ok('pago marcado no PC fica', m.estado['a@2026-11-30'].pago, true);
  const apagou = cx.cxMesclar(m, { regras: { b: { id: 'b', apagado: true, alt: '2026-11-24T13:00:00Z' } } });
  ok('apagar (com data nova) vence a versão velha', apagou.regras.b.apagado, true);
  ok('ajustes padrão quando ninguém mexeu', cx.cxMesclar({}).ajustes.piso, 3500);
  ok('mesclar nada não quebra', Object.keys(cx.cxMesclar(null, undefined).regras).length, 0);
}

console.log('\n7) Combinado de 24/11 entra na primeira carga');
{
  const s = cx.cxSemente();
  const l = cx.cxInstancias(s, '2026-11-24', '2026-12-11');
  const alv = l.filter(i => i.grupo === 'alvaro').map(i => [i.data, i.valor]);
  ok('Álvaro: 5.000 hoje, 6.500 em 01/12 e 6.491,20 em 11/12', alv, [['2026-11-24', 5000], ['2026-12-01', 6500], ['2026-12-11', 6491.2]]);
  ok('Pix do Nubank toda sexta', l.filter(i => i.regra === 'nubank').map(i => i.data), ['2026-11-27', '2026-12-04', '2026-12-11']);
  ok('acordo e Simples saem do cofrinho', l.filter(i => i.cofrinho).map(i => i.regra).sort(), ['acordo-mp', 'simples-p2']);
  ok('fatura do Álvaro soma 17.991,20', Math.round(l.filter(i => i.grupo === 'alvaro').reduce((t, i) => t + i.valor, 0) * 100) / 100, 17991.2);
}

console.log('\n8) Tela');
ok('painel novo no index', ['cx-hero', 'cx-lista', 'cx-semana', 'cx-dividas', 'cx-ajustes', 'cx-modal'].every(id => html.includes(`id="${id}"`)), true);
ok('portão de senha continua', html.includes('id="flx-gate"') && html.includes('id="flx-senha"'), true);
ok('renderFluxo é a versão nova', /async function renderFluxo\(forcar\)/.test(main), true);

console.log(`\n${total - falhas}/${total} ok`);
if (falhas) { console.log(`${falhas} falha(s)`); process.exit(1); }
