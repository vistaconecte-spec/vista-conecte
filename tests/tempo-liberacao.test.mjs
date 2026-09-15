/**
 * Testes do card TEMPO DE LIBERAÇÃO (dias úteis do pagamento ao envio).
 *
 * POR QUE ISTO EXISTE: a Bárbara pediu em 15/09/2026 um card no painel para acompanhar
 * "a média em dias úteis" dos pedidos liberados. A conta tem armadilhas silenciosas:
 * fuso (a Shopify carimba em UTC; 22h de Brasília já é o dia seguinte lá), feriado,
 * pedido "cancelado na prática" que ficaria eterno como o mais antigo da fila, e a
 * média por semana de PAGAMENTO, que parece melhorar enquanto a fila só cresce.
 *
 * Rodar:  node tests/tempo-liberacao.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const html = readFileSync(join(raiz, 'index.html'), 'utf8');
const css  = readFileSync(join(raiz, 'style.css'), 'utf8');
const api  = await import(pathToFileURL(join(raiz, 'functions', 'api', 'shopify-tempo-liberacao.js')).href);

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  X ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ok ${nome}`);
}

console.log('\n1) Dias úteis: fim de semana, feriado e fuso de Brasília');
{
  const u = api.diasUteisEntre;
  ok('mesmo dia = 0', u('2026-09-15T12:00:00Z', '2026-09-15T20:00:00Z'), 0);
  ok('terça para quarta = 1', u('2026-09-15T12:00:00Z', '2026-09-16T12:00:00Z'), 1);
  ok('sexta para segunda = 1 (fim de semana não conta)', u('2026-09-11T12:00:00Z', '2026-09-14T12:00:00Z'), 1);
  ok('sábado para domingo = 0', u('2026-09-12T12:00:00Z', '2026-09-13T12:00:00Z'), 0);
  ok('sábado para segunda = 1', u('2026-09-12T12:00:00Z', '2026-09-14T12:00:00Z'), 1);
  ok('sexta 04/09 para terça 08/09 = 1 (07/09 é feriado)', u('2026-09-04T12:00:00Z', '2026-09-08T12:00:00Z'), 1);
  ok('duas semanas cheias = 10', u('2026-08-17T12:00:00Z', '2026-08-31T12:00:00Z'), 10);
  ok('duas semanas com feriado no meio = 9', u('2026-08-31T12:00:00Z', '2026-09-14T12:00:00Z'), 9);
  // 2026-09-10T01:00Z é 09/09 às 22h em Brasília: pago dia 9, enviado dia 10 = 1 útil
  ok('carimbo UTC da madrugada fica no dia anterior de Brasília', u('2026-09-10T01:00:00Z', '2026-09-10T15:00:00Z'), 1);
  ok('envio antes do pagamento não dá negativo', u('2026-09-15T12:00:00Z', '2026-09-10T12:00:00Z'), 0);
  ok('aceita timestamp numérico', u(Date.parse('2026-09-11T12:00:00Z'), Date.parse('2026-09-14T12:00:00Z')), 1);
  ok('segunda da semana', api.ymdDoDia(api.segundaDe(api.diaLocal('2026-09-15T12:00:00Z'))), '2026-09-14');
  ok('domingo pertence à semana da segunda anterior', api.ymdDoDia(api.segundaDe(api.diaLocal('2026-09-20T12:00:00Z'))), '2026-09-14');
}

console.log('\n2) Normalizar: quem entra e quem fica de fora');
{
  const nos = [
    { name: '#1', createdAt: '2026-09-01T12:00:00Z', processedAt: '2026-09-01T12:00:01Z', cancelledAt: null, displayFinancialStatus: 'PAID', currentSubtotalLineItemsQuantity: 2, shippingLine: { title: 'Loggi Express' },
      fulfillments: [{ createdAt: '2026-09-05T12:00:00Z', status: 'CANCELLED' }, { createdAt: '2026-09-04T12:00:00Z', status: 'SUCCESS' }, { createdAt: '2026-09-03T12:00:00Z', status: 'SUCCESS' }] },
    { name: '#2 cancelado', createdAt: '2026-09-01T12:00:00Z', processedAt: '2026-09-01T12:00:00Z', cancelledAt: '2026-09-02T00:00:00Z', displayFinancialStatus: 'PAID', currentSubtotalLineItemsQuantity: 1, shippingLine: { title: 'PAC' }, fulfillments: [] },
    { name: '#3 pendente', createdAt: '2026-09-01T12:00:00Z', processedAt: '2026-09-01T12:00:00Z', cancelledAt: null, displayFinancialStatus: 'PENDING', currentSubtotalLineItemsQuantity: 1, shippingLine: { title: 'PAC' }, fulfillments: [] },
    { name: '#4 retirada', createdAt: '2026-09-01T12:00:00Z', processedAt: '2026-09-01T12:00:00Z', cancelledAt: null, displayFinancialStatus: 'PAID', currentSubtotalLineItemsQuantity: 1, shippingLine: { title: 'Loja Conecte' }, fulfillments: [] },
    { name: '#5 itens removidos', createdAt: '2026-01-16T12:00:00Z', processedAt: '2026-01-16T12:00:00Z', cancelledAt: null, displayFinancialStatus: 'PAID', currentSubtotalLineItemsQuantity: 0, shippingLine: { title: 'Loggi Express' }, fulfillments: [] },
    { name: '#6 estorno parcial sem frete', createdAt: '2026-09-02T12:00:00Z', processedAt: null, cancelledAt: null, displayFinancialStatus: 'PARTIALLY_REFUNDED', currentSubtotalLineItemsQuantity: 1, shippingLine: null, fulfillments: [] },
  ];
  const r = api.normalizar(nos);
  ok('só o pago enviado e o estorno parcial entram', r.map(p => p.numero), ['#1', '#6 estorno parcial sem frete']);
  ok('a remessa cancelada não conta e vale a PRIMEIRA remessa boa', r[0].enviado_em, '2026-09-03T12:00:00Z');
  ok('relógio começa em processedAt', r[0].pago_em, '2026-09-01T12:00:01Z');
  ok('sem processedAt cai em createdAt, e sem remessa fica na fila', [r[1].pago_em, r[1].enviado_em], ['2026-09-02T12:00:00Z', null]);
}

console.log('\n3) Resumo: janelas, faixas, semanas de ENVIO e fila');
{
  const agora = Date.parse('2026-09-15T18:00:00Z'); // terça
  const pedidos = [
    { numero: '#A', pago_em: '2026-09-14T12:00:00Z', enviado_em: '2026-09-15T12:00:00Z' }, // 1 útil, semana atual
    { numero: '#B', pago_em: '2026-09-04T12:00:00Z', enviado_em: '2026-09-11T12:00:00Z' }, // 4 úteis (07/09 feriado), semana 07/09
    { numero: '#C', pago_em: '2026-08-10T12:00:00Z', enviado_em: '2026-08-28T12:00:00Z' }, // 14 úteis, semana 24/08
    { numero: '#D', pago_em: '2026-07-01T12:00:00Z', enviado_em: '2026-07-10T12:00:00Z' }, // fora das 8 semanas e dos 30 dias
    { numero: '#E', pago_em: '2026-09-15T12:00:00Z', enviado_em: null },                   // fila, 0 útil
    { numero: '#F', pago_em: '2026-09-01T12:00:00Z', enviado_em: null },                   // fila, 9 úteis (feriado)
  ];
  const r = api.resumir(pedidos, agora);
  ok('7 dias: só #A e #B', r.enviados.d7, { n: 2, media: 2.5, mediana: 4, corridos: 4 });
  ok('30 dias: #A, #B, #C', r.enviados.d30, { n: 3, media: 6.3, mediana: 4, corridos: 8.7 });
  ok('faixas dos 30 dias', r.faixas, { ate2: 1, de3a5: 1, de6a10: 0, mais11: 1 });
  ok('8 semanas de envio, da segunda de 7 semanas atrás até a atual', r.semanas.map(s => s.inicio),
    ['2026-07-27', '2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14']);
  ok('cada envio cai na semana em que SAIU, não em que foi pago', r.semanas.map(s => [s.n, s.media]),
    [[0, null], [0, null], [0, null], [0, null], [1, 14], [0, null], [1, 4], [1, 1]]);
  ok('fila: quantos, média e o mais antigo', r.fila, { n: 2, media: 4.5, mais_antigo: { numero: '#F', uteis: 9, corridos: 14 } });
  ok('sem pedido nenhum não quebra', api.resumir([], agora).enviados.d7, { n: 0, media: null, mediana: null, corridos: null });
  ok('fila vazia sem mais antigo', api.resumir([], agora).fila, { n: 0, media: null, mais_antigo: null });
}

console.log('\n4) Leitura da Shopify: GraphQL paginado, 90 dias + abertos de qualquer data');
{
  const chamadas = [];
  const fetchFalso = async (url, opts) => {
    const body = JSON.parse(opts.body);
    chamadas.push(body.variables);
    const seg = body.variables.cursor === 'c1';
    return { ok: true, json: async () => ({ data: { orders: {
      edges: [{ cursor: seg ? 'c2' : 'c1', node: { name: seg ? '#2' : '#1' } }],
      pageInfo: { hasNextPage: !seg },
    } } }) };
  };
  const agora = Date.parse('2026-09-15T18:00:00Z');
  const nos = await api.buscarPedidos('loja', 'tok', 90, fetchFalso, agora);
  ok('segue o cursor até acabar', nos.map(n => n.name), ['#1', '#2']);
  ok('segunda página usa o cursor da primeira', chamadas.map(c => c.cursor), [null, 'c1']);
  ok('filtro: 90 dias OU aberto sem envio', chamadas[0].q, 'created_at:>=2026-06-17 OR (fulfillment_status:unfulfilled AND status:open)');
  const erro = await api.buscarPedidos('loja', 'tok', 90, async () => ({ ok: false, status: 429 })).catch(e => e.message);
  ok('HTTP ruim vira erro, não lista vazia', erro, 'Shopify GraphQL: HTTP 429');
}

console.log('\n5) A tela tem o card e o ciclo de 30 min');
{
  ok('card no painel', /id="card-tempo-lib"/.test(html) && /id="dash-tempo"/.test(html), true);
  ok('card vem logo depois dos mini-cards', html.indexOf('id="card-tempo-lib"') > html.indexOf('id="mini-ab-sub"') && html.indexOf('id="card-tempo-lib"') < html.indexOf('id="card-prontos"'), true);
  ok('renderDashboard repinta o card', /renderMiniCards\(totalPedidos\);\s*renderTempoLiberacao\(\);/.test(main), true);
  ok('lê na abertura e a cada 30 min', /carregarTempoLiberacao\(\);\s*setInterval\(carregarTempoLiberacao, TL_INTERVALO\)/.test(main) && /TL_INTERVALO = 30 \* 60 \* 1000/.test(main), true);
  ok('oficina e modelagem não chamam a API', /async function carregarTempoLiberacao\(\) \{\s*if \(ehPerfilDeUmaAba\(\)\) return;/.test(main), true);
  ok('css do card existe', /\.tl-tiles/.test(css) && /\.tl-semanas/.test(css), true);

  // O desenho: roda tempoLiberacaoHTML com um resumo de mentira
  const i = main.indexOf('const tlNum ='), f = main.indexOf('function renderTempoLiberacao()');
  const desenhar = new Function('d', main.slice(i, f) + '\nreturn tempoLiberacaoHTML(d);');
  const htmlCard = desenhar({
    enviados: { d7: { n: 1, media: 7.4, mediana: 7, corridos: 11.4 }, d30: { n: 0, media: null, mediana: null, corridos: null } },
    faixas: { ate2: 1, de3a5: 0, de6a10: 1, mais11: 2 },
    semanas: [{ inicio: '2026-09-07', n: 3, media: 10.3 }, { inicio: '2026-09-14', n: 0, media: null }],
    fila: { n: 93, media: 7.1, mais_antigo: { numero: '#8564', uteis: 41, corridos: 60 } },
    gerado_em: '2026-09-15T19:00:00Z',
  });
  ok('média com vírgula', htmlCard.includes('7,4<small>dias úteis</small>'), true);
  ok('janela sem envio mostra traço, não NaN', htmlCard.includes('—<small>dias úteis</small>') && !/NaN|null|undefined/.test(htmlCard), true);
  ok('fila com o mais antigo', htmlCard.includes('mais antigo #8564 (41 dias úteis)'), true);
  ok('faixas em porcentagem', htmlCard.includes('até 2 dias úteis <b>25%</b>') && htmlCard.includes('11 ou mais <b>50%</b>'), true);
  ok('semanas com o dia da segunda', htmlCard.includes('>07/09<') && htmlCard.includes('>14/09<'), true);
}

console.log(`\n${total - falhas}/${total} passaram`);
if (falhas) process.exit(1);
