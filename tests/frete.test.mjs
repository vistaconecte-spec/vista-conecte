/**
 * Testes da sub-aba FRETE do Atendimento (consulta na Frenet + custo real do mês).
 *
 * POR QUE ISTO EXISTE: em 18/09/2026 cruzamos 5 faturas da Loggi com a Shopify e a cliente
 * pagava R$19 enquanto a Loggi cobrava R$34 por envio (R$11.500 bancados em 2,5 meses).
 * A conta do mês tem armadilhas: a etiqueta aparece em duas faturas (entrega numa,
 * volumetria na seguinte), pedido de retirada não tem frete, pedido pago e não enviado não
 * pode entrar como "envio", e o que ainda não veio na fatura precisa ser estimado, senão o
 * começo do mês parece lucro.
 *
 * Rodar:  node tests/frete.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const html = readFileSync(join(raiz, 'index.html'), 'utf8');
const mesApi = await import(pathToFileURL(join(raiz, 'functions', 'api', 'frete-mes.js')).href);
const cotApi = await import(pathToFileURL(join(raiz, 'functions', 'api', 'frenet-cotacao.js')).href);

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  X ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ok ${nome}`);
}

console.log('\n1) /api/frenet-cotacao: CEP, opções e o que a loja banca');
{
  ok('CEP com hífen vira 8 dígitos', cotApi.normalizarCep('01310-100'), '01310100');
  ok('CEP curto é inválido', cotApi.normalizarCep('1310'), null);
  const resp = { ShippingSevicesArray: [
    { ServiceCode: '03298', ServiceDescription: 'PAC', Carrier: 'Correios', ShippingPrice: '23.81', OriginalShippingPrice: '23.81', DeliveryTime: '5', Error: false },
    { ServiceCode: 'LOG_VIP_WS', ServiceDescription: 'Loggi Express', Carrier: 'Loggi', ShippingPrice: '19.00', OriginalShippingPrice: '27.25', DeliveryTime: '3', Error: false },
    { ServiceCode: 'X', ServiceDescription: 'Jadlog', Carrier: 'Jadlog', Error: true, Msg: 'CEP não atendido' },
  ] };
  const o = cotApi.montarOpcoes(resp);
  ok('mais barata primeiro, erro por último', o.map(x => x.servico), ['Loggi Express', 'PAC', 'Jadlog']);
  ok('traz o que a cliente paga E a tabela (a diferença é o que a loja banca)', [o[0].cliente_paga, o[0].tabela], [19, 27.25]);
  ok('serviço com erro não derruba os outros', o[2].erro, 'CEP não atendido');
  const chamadas = [];
  const fetchFalso = async (url, opts) => { chamadas.push(JSON.parse(opts.body)); return { ok: true, json: async () => resp }; };
  await cotApi.cotar('tok', { cep: '01310100', valor: 149, peso: 2 }, fetchFalso);
  ok('cota a partir da loja (88067200) com o peso pedido', [chamadas[0].SellerCEP, chamadas[0].ShippingItemArray[0].Weight], ['88067200', 2]);
}

console.log('\n2) /api/frete-mes: período do mês e normalização dos pedidos');
{
  ok('setembro vai de 01/09 a antes de 01/10', mesApi.periodoDoMes('2026-09'), { ini: '2026-09-01', prox: '2026-10-01' });
  ok('dezembro vira o ano', mesApi.periodoDoMes('2026-12'), { ini: '2026-12-01', prox: '2027-01-01' });
  ok('mês inválido é recusado', mesApi.periodoDoMes('2026-13'), null);
  const nos = [
    { name: '#1', createdAt: '2026-09-02T12:00:00Z', displayFinancialStatus: 'PAID', currentSubtotalLineItemsQuantity: 2, totalWeight: 700,
      shippingLine: { title: 'Loggi Express', discountedPriceSet: { shopMoney: { amount: '19.0' } } }, shippingAddress: { provinceCode: 'SP' },
      fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'BLI_1 ' }] }] },
    { name: '#2', createdAt: '2026-09-03T12:00:00Z', displayFinancialStatus: 'PAID', currentSubtotalLineItemsQuantity: 1, totalWeight: 350,
      shippingLine: { title: 'Loja Conecte', discountedPriceSet: { shopMoney: { amount: '0.0' } } }, shippingAddress: null, fulfillments: [] },
    { name: '#3', createdAt: '2026-09-04T12:00:00Z', displayFinancialStatus: 'PENDING', currentSubtotalLineItemsQuantity: 1, shippingLine: { title: 'PAC' }, fulfillments: [] },
    { name: '#4', createdAt: '2026-09-05T12:00:00Z', cancelledAt: '2026-09-06T12:00:00Z', displayFinancialStatus: 'PAID', currentSubtotalLineItemsQuantity: 1, shippingLine: { title: 'PAC' }, fulfillments: [] },
    { name: '#5', createdAt: '2026-09-07T12:00:00Z', displayFinancialStatus: 'PAID', currentSubtotalLineItemsQuantity: 1, totalWeight: 0,
      shippingLine: { title: 'PAC', discountedPriceSet: { shopMoney: { amount: '0.0' } } }, shippingAddress: { provinceCode: 'MG' },
      fulfillments: [{ status: 'CANCELLED', trackingInfo: [{ number: 'BLI_X' }] }] },
  ];
  const p = mesApi.normalizar(nos);
  ok('pendente e cancelado ficam fora', p.map(x => x.numero), ['#1', '#2', '#5']);
  ok('etiqueta sem espaço, cobrado com desconto, peso e UF', [p[0].etiquetas, p[0].cobrado, p[0].peso_g, p[0].uf, p[0].enviado], [['BLI_1'], 19, 700, 'SP', true]);
  ok('retirada na loja é marcada', p[1].retirada, true);
  ok('remessa cancelada não conta como enviado nem traz etiqueta', [p[2].enviado, p[2].etiquetas], [false, []]);
  const chamadas = [];
  const fetchFalso = async (url, opts) => { chamadas.push(JSON.parse(opts.body).variables.q); return { ok: true, json: async () => ({ data: { orders: { edges: [], pageInfo: { hasNextPage: false } } } }) }; };
  await mesApi.buscarPedidos('loja', 'tok', '2026-09', fetchFalso);
  ok('a busca corta o mês no fuso de Brasília', chamadas[0], "created_at:>='2026-09-01T00:00:00-03:00' AND created_at:<'2026-10-01T00:00:00-03:00'");
}

console.log('\n3) Conta do mês na tela (frtCalcularMes): fatura por etiqueta, estimativa e exclusões');
{
  const i = main.indexOf('const frtCustoEtiqueta'), f = main.indexOf('function frtRenderMes');
  ok('as funções da conta existem no main.js', i > 0 && f > i, true);
  const calcular = new Function('pedidos', 'cfg', main.slice(i, f) + '\nreturn frtCalcularMes(pedidos, cfg);');
  const cfg = { faturas: { '2026-09-01': {} }, etiquetas: {
    BLI_A: { f: { '2026-09-01': 20, '2026-09-16': 10 } }, // entrega numa fatura, volumetria na outra
    BLI_B: { f: { '2026-09-01': 40 } },
  } };
  const pedidos = [
    { numero: '#1', metodo: 'Loggi Express', cobrado: 19, enviado: true, retirada: false, etiquetas: ['BLI_A'] },
    { numero: '#2', metodo: 'Loggi Express', cobrado: 19, enviado: true, retirada: false, etiquetas: ['BLI_B'] },
    { numero: '#3', metodo: 'Loggi Express', cobrado: 19, enviado: true, retirada: false, etiquetas: ['BLI_C'] }, // ainda sem fatura
    { numero: '#4', metodo: 'PAC', cobrado: 30, enviado: true, retirada: false, etiquetas: ['AP1BR'] }, // frete livre, fora da fatura
    { numero: '#5', metodo: 'Loja Conecte', cobrado: 0, enviado: true, retirada: true, etiquetas: [] },
    { numero: '#6', metodo: 'Loggi Express', cobrado: 19, enviado: false, retirada: false, etiquetas: [] },
  ];
  const c = calcular(pedidos, cfg);
  ok('etiqueta em duas faturas soma as duas (30); PAC entra pelo cobrado (30+40+30)', c.custo, 100);
  ok('só envios contam: retirada e não enviado ficam fora', [c.envios, c.retiradas, c.nao_enviados], [4, 1, 1]);
  ok('quem ainda não tem fatura entra pela média das etiquetas faturadas (35)', [c.pendentes, c.estimado, c.media_etiqueta], [1, 35, 35]);
  ok('saldo desconta o real E o estimado (87 - 100 - 35)', c.saldo, -48);
  ok('por envio', c.por_envio, -12);
  ok('tabela por método separa Loggi e PAC', Object.keys(c.por_metodo).sort(), ['Loggi Express', 'PAC']);
  ok('PAC (livre): custo igual ao cobrado e não entra nos pendentes', [c.por_metodo.PAC.cobrado, c.por_metodo.PAC.custo, c.por_metodo.PAC.pendentes, c.livres], [30, 30, 0, 1]);
  const vazio = calcular(pedidos, { faturas: {}, etiquetas: {} });
  ok('sem fatura nenhuma, nada é estimado (média 0) e só a Loggi fica pendente', [vazio.custo, vazio.estimado, vazio.pendentes], [30, 0, 3]);
}

console.log('\n4) Tela e ligações');
{
  ok('a aba FRETE tem painel próprio com cadeado', /id="panel-frete"/.test(html) && /id="frt-gate"/.test(html) && /id="frt-content"/.test(html), true);
  ok('a sidebar tem o botão FRETE e ele abre a aba', /frtItem\.onclick = \(\) => abrirFrete\(frtItem\);/.test(main), true);
  ok('abrir a aba carrega o mês (com a senha do Financeiro já dada)', /if \(ok\) frtCarregarMes\(\); else setTimeout/.test(main), true);
  ok('o hash #frete restaura a aba após F5', /frete: '__frete__'/.test(main) && /abrirFrete\(null\); \/\/ restaura/.test(main), true);
  ok('a aba não ficou duplicada no Atendimento', /atd-sub-frete|atd-pill-frete/.test(html), false);
  ok('as regras vigentes estão escritas na tela', /Regras vigentes \(Frenet, desde 19\/09\/2026\)/.test(html), true);
  ok('o campo de valor diz o que é', /Valor da compra R\$/.test(html), true);
  ok('a consulta lê /api/frenet-cotacao', /fetch\(`\/api\/frenet-cotacao\?cep=\$\{cep\}&valor=\$\{valor\}&peso=\$\{peso\}`/.test(main), true);
  ok('o mês lê /api/frete-mes', /fetch\(`\/api\/frete-mes\?mes=\$\{mes\}`/.test(main), true);
  ok('a fatura importada é gravada sem histórico (salvarNuvemREST direto)', /return salvarNuvemREST\('frete-faturas', cfg\);/.test(main), true);
  ok('reimportar a mesma fatura apaga antes o que ela tinha em cada etiqueta', /if \(et\.f && et\.f\[id\] != null\) delete et\.f\[id\];/.test(main), true);
  ok('o leitor de planilha só carrega na importação', /xlsx\.full\.min\.js/.test(main) && !/xlsx\.full\.min\.js/.test(html), true);
  ok('o card diz que a estimativa vem da média das faturas', /custo estimado pela média das faturas/.test(main), true);
  ok('o card avisa que PAC/Sedex entram pelo cobrado', /frete livre\): custo considerado igual ao cobrado/.test(main), true);
}

console.log(`\n${total - falhas}/${total} ok${falhas ? `, ${falhas} falha(s)` : ''}`);
process.exit(falhas ? 1 : 0);
