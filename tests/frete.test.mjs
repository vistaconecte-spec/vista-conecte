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
  ok('sem medidas, usa o Saco P (24×15×10), a embalagem padrão da Frenet', [chamadas[0].ShippingItemArray[0].Length, chamadas[0].ShippingItemArray[0].Width, chamadas[0].ShippingItemArray[0].Height], [24, 15, 10]);
  await cotApi.cotar('tok', { cep: '01310100', valor: 149, peso: 2.5, alt: 12, larg: 35, comp: 45 }, fetchFalso);
  ok('com medidas (Saco GG), manda as medidas', [chamadas[1].ShippingItemArray[0].Length, chamadas[1].ShippingItemArray[0].Width, chamadas[1].ShippingItemArray[0].Height], [45, 35, 12]);
}

console.log('\n2) /api/frete-mes: período do mês e normalização dos pedidos');
{
  ok('setembro vai de 01/09 a antes de 01/10', mesApi.periodoDoMes('2026-09'), { ini: '2026-09-01', prox: '2026-10-01' });
  ok('dezembro vira o ano', mesApi.periodoDoMes('2026-12'), { ini: '2026-12-01', prox: '2027-01-01' });
  ok('mês inválido é recusado', mesApi.periodoDoMes('2026-13'), null);
  const nos = [
    { name: '#1', createdAt: '2026-09-02T12:00:00Z', displayFinancialStatus: 'PAID', currentSubtotalLineItemsQuantity: 2, totalWeight: 700,
      shippingLine: { title: 'Loggi Express', discountedPriceSet: { shopMoney: { amount: '19.0' } } }, shippingAddress: { provinceCode: 'SP', zip: '01310-100' },
      currentTotalPriceSet: { shopMoney: { amount: '318.9' } },
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
  ok('CEP só dígitos e valor total do pedido (pra rotina cotar o custo de tabela)', [p[0].cep, p[0].valor, p[1].cep], ['01310100', 318.9, null]);
  ok('retirada na loja é marcada', p[1].retirada, true);
  ok('remessa cancelada não conta como enviado nem traz etiqueta', [p[2].enviado, p[2].etiquetas], [false, []]);
  const chamadas = [];
  const fetchFalso = async (url, opts) => { chamadas.push(JSON.parse(opts.body).variables.q); return { ok: true, json: async () => ({ data: { orders: { edges: [], pageInfo: { hasNextPage: false } } } }) }; };
  await mesApi.buscarPedidos('loja', 'tok', '2026-09', fetchFalso);
  ok('a busca corta o mês no fuso de Brasília', chamadas[0], "created_at:>='2026-09-01T00:00:00-03:00' AND created_at:<'2026-10-01T00:00:00-03:00'");
  ok('antes=2 volta dois meses (etiqueta de outubro pode ser de pedido de agosto)', mesApi.periodoDoMes('2026-10', 2), { ini: '2026-08-01', prox: '2026-11-01' });
  ok('antes atravessa o ano', mesApi.periodoDoMes('2027-01', 2), { ini: '2026-11-01', prox: '2027-02-01' });
  ok('antes tem teto de 3 meses (CPU do plano grátis)', mesApi.periodoDoMes('2026-10', 9).ini, '2026-07-01');
  await mesApi.buscarPedidos('loja', 'tok', '2026-10', fetchFalso, 2);
  ok('a busca com antes=2 começa em agosto', chamadas[1], "created_at:>='2026-08-01T00:00:00-03:00' AND created_at:<'2026-11-01T00:00:00-03:00'");
  const comNome = mesApi.normalizar([{ ...nos[0], shippingAddress: { provinceCode: 'SP', zip: '01310-100', name: 'Ana Souza', city: 'São Paulo' } }]);
  ok('traz nome e cidade da entrega (casamento com a etiqueta da Frenet)', [comNome[0].nome, comNome[0].cidade], ['Ana Souza', 'São Paulo']);
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

console.log('\n4) Custo pela Frenet (frtCalcularMesFrenet): etiqueta casada com o pedido');
{
  const i = main.indexOf('const FRT_FRENET_DESDE'), f = main.indexOf('function frtRenderMesFrenet');
  ok('a conta da Frenet existe no main.js', i > 0 && f > i, true);
  const calcular = new Function('pedidos', 'frenet', main.slice(i, f) + '\nreturn frtCalcularMesFrenet(pedidos, frenet);');
  const pedidos = [
    { numero: '#1', criado_em: '2026-09-20T12:00:00Z', cobrado: 19, retirada: false, etiquetas: ['ABCD1234'], nome: 'Ana Souza' },
    { numero: '#2', criado_em: '2026-09-28T12:00:00Z', cobrado: 24.9, retirada: false, etiquetas: [], nome: 'Bruna  Lima' },
    { numero: '#3', criado_em: '2026-10-02T12:00:00Z', cobrado: 0, retirada: false, etiquetas: [], nome: 'Carla Maria Dias' },
    { numero: '#4', criado_em: '2026-10-03T12:00:00Z', cobrado: 30, retirada: false, etiquetas: [], nome: 'Bruna Lima' },
    { numero: '#5', criado_em: '2026-10-03T12:00:00Z', cobrado: 0, retirada: true, etiquetas: [], nome: 'Dani Retira' },
    { numero: '#6', criado_em: '2026-10-09T12:00:00Z', cobrado: 18, retirada: false, etiquetas: [], nome: 'Eva Depois' },
  ];
  const frenet = { puxado_em: '2026-10-08T12:00:00Z', etiquetas: [
    { id: 1, d: '2026-10-05T13:00:00.000Z', n: 'Ana Souza', s: 'Loggi', v: 20, div: 0, cod: 'abcd1234' },          // pelo rastreio
    { id: 2, d: '2026-10-05T14:00:00.000Z', n: 'Bruna Lima', s: 'Loggi', v: 22, div: 0, cod: '' },                  // pelo nome: o pedido mais recente (#4)
    { id: 3, d: '2026-10-06T14:00:00.000Z', n: 'Bruna Lima', s: 'Loggi', v: 21, div: 0, cod: '' },                  // segunda etiqueta da Bruna: o pedido anterior (#2)
    { id: 4, d: '2026-10-06T15:00:00.000Z', n: 'Carla Dias', s: 'PAC', v: 25, div: 4.5, cod: '' },                  // primeiro + último nome; divergência soma no custo
    { id: 5, d: '2026-10-06T16:00:00.000Z', n: 'VISTA CONECTE LTDA', s: 'PAC', v: 23.3, div: 0, cod: 'AP1BR' },     // troca voltando para a loja
    { id: 6, d: '2026-10-07T10:00:00.000Z', n: 'Eva Depois', s: 'Sedex', v: 30, div: 0, cod: '' },                  // pedido é posterior à etiqueta: não casa
    { id: 7, d: '2026-10-07T11:00:00.000Z', n: 'Ana Souza', s: 'Sedex', v: 40, div: 0, cod: 'ABCD1234' },           // 2ª etiqueta do mesmo pedido: frete da cliente não conta de novo
  ] };
  const c = calcular(pedidos, frenet);
  ok('casa 2 pelo rastreio (maiúscula/minúscula não importa) e 3 pelo nome', c.casados, { codigo: 2, nome: 3 });
  ok('envios de cliente não contam a troca', [c.envios, c.trocas], [6, 1]);
  ok('cliente pagou: 19 (#1, uma vez só) + 30 (#4) + 24,9 (#2) + 0 (#3)', c.cobrado, 73.9);
  ok('custo: etiquetas + divergência + troca', c.custo, 20 + 22 + 21 + 29.5 + 23.3 + 30 + 40);
  ok('divergência separada', c.divergencia, 4.5);
  ok('saldo e por envio', [c.saldo, c.por_envio], [Math.round((73.9 - 185.8) * 100) / 100, Math.round((73.9 - 185.8) / 6 * 100) / 100]);
  ok('etiqueta sem pedido aparece pra conferir', c.sem_pedido.map(x => x.n), ['Eva Depois']);
  ok('tabela por serviço da Frenet com a troca em linha própria', Object.keys(c.por_metodo).sort(), ['Loggi', 'PAC', 'Sedex', 'Trocas e devoluções (para a loja)']);
  ok('Loggi: 3 envios, cobrou 73,9, custou 63', [c.por_metodo.Loggi.envios, c.por_metodo.Loggi.cobrado, c.por_metodo.Loggi.custo], [3, 73.9, 63]);
  ok('pedido com duas etiquetas pagas aparece (#1: Loggi + Sedex)', c.varias_etiquetas.map(x => [x.numero, x.etiquetas.map(t => t.s)]), [['#1', ['Loggi', 'Sedex']]]);
  const comMetodo = pedidos.map(p => ({ ...p, metodo: 'Loggi Express' })); // todas escolheram Loggi no checkout
  const c2 = calcular(comMetodo, frenet);
  ok('escolheu Loggi e saiu PAC/Sedex é apontado; Loggi Express x Loggi não', c2.outro_servico.map(x => [x.numero, x.saiu]), [['#3', 'PAC'], ['#1', 'Sedex']]);
  const vazio = calcular(pedidos, null);
  ok('sem etiquetas puxadas, tudo zero', [vazio.envios, vazio.custo, vazio.saldo], [0, 0, 0]);
  ok('outubro/2026 em diante usa a Frenet, setembro segue com a fatura da Loggi', /const FRT_FRENET_DESDE = '2026-10';/.test(main) && /if \(frenet\) frtRenderMesFrenet\(d, loadLocal\('vc:frete-frenet-' \+ mes\)\);/.test(main), true);
  ok('o rótulo do custo muda conforme a fonte', /set\('frt-m-custo-label', 'CUSTO REAL \(FRENET\)'\)/.test(main) && /set\('frt-m-custo-label', 'LOGGI COBROU \(FATURA\)'\)/.test(main) && /id="frt-m-custo-label"/.test(html), true);
}

console.log('\n5) Tela e ligações');
{
  ok('a aba FRETE tem painel próprio com cadeado', /id="panel-frete"/.test(html) && /id="frt-gate"/.test(html) && /id="frt-content"/.test(html), true);
  ok('a sidebar tem o botão FRETE e ele abre a aba', /frtItem\.onclick = \(\) => abrirFrete\(frtItem\);/.test(main), true);
  ok('abrir a aba carrega o mês (com a senha do Financeiro já dada)', /if \(ok\) frtCarregarMes\(\); else setTimeout/.test(main), true);
  ok('o hash #frete restaura a aba após F5', /frete: '__frete__'/.test(main) && /abrirFrete\(null\); \/\/ restaura/.test(main), true);
  ok('a aba não ficou duplicada no Atendimento', /atd-sub-frete|atd-pill-frete/.test(html), false);
  ok('as regras vigentes estão escritas na tela', /Regras vigentes \(Frenet, desde 19\/09\/2026\)/.test(html), true);
  ok('o campo de valor diz o que é', /Valor da compra R\$/.test(html), true);
  ok('a consulta lê /api/frenet-cotacao com embalagem, medidas, peso e valor (igual à calculadora da Frenet)', /fetch\(`\/api\/frenet-cotacao\?cep=\$\{cep\}&valor=\$\{valor\}&peso=\$\{peso\}&alt=\$\{alt\}&larg=\$\{larg\}&comp=\$\{comp\}`/.test(main), true);
  ok('os sacos da Frenet estão no seletor e preenchem as medidas', /id="frt-embalagem"/.test(html) && /24x15x10x0\.35/.test(html) && /45x35x12x2\.5/.test(html) && /function frtEmbalagem\(\)/.test(main), true);
  ok('o mês lê /api/frete-mes (com 2 meses antes quando é mês da Frenet)', /fetch\(`\/api\/frete-mes\?mes=\$\{mes\}\$\{frenet \? '&antes=2' : ''\}`/.test(main), true);
  ok('a fatura importada é gravada sem histórico (salvarNuvemREST direto)', /return salvarNuvemREST\('frete-faturas', cfg\);/.test(main), true);
  ok('reimportar a mesma fatura apaga antes o que ela tinha em cada etiqueta', /if \(et\.f && et\.f\[id\] != null\) delete et\.f\[id\];/.test(main), true);
  ok('o leitor de planilha só carrega na importação', /xlsx\.full\.min\.js/.test(main) && !/xlsx\.full\.min\.js/.test(html), true);
  ok('o card diz que a estimativa vem da média das faturas', /custo estimado pela média das faturas/.test(main), true);
  ok('o card avisa que PAC/Sedex entram pelo cobrado', /frete livre\): custo considerado igual ao cobrado/.test(main), true);
}

console.log(`\n${total - falhas}/${total} ok${falhas ? `, ${falhas} falha(s)` : ''}`);
process.exit(falhas ? 1 : 0);
