/**
 * Pedido de troca de R$ 0 (functions/_pedido-troca.js, /api/troca-pedido e a trava no
 * painel e nas etiquetas, 19/10/2026).
 *
 * Fluxo validado com a Bárbara: o pedido da peça nova nasce quando a cliente pede a troca no
 * portal, igual ao que a equipe fazia à mão (rascunho com 100% de desconto, nota "TROCA"),
 * mas TRAVADO até o "conferido" da peça antiga. Trava aqui:
 *  1. rascunho com a mesma cliente, endereço e CPF do pedido original, 100% de desconto,
 *     frete zero, sem desconto automático, e as tags que o painel e o robô leem;
 *  2. não cria dois pedidos para o mesmo protocolo;
 *  3. trava o envio na Shopify (AWAITING_RETURN_ITEMS) e o "conferido" solta e troca a tag;
 *  4. o painel e as etiquetas enxergam a trava.
 *
 * Rodar:  node tests/pedido-troca.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { montarRascunho, criarPedidoTroca, liberarPedidoTroca, TAG_AGUARDANDO } from '../functions/_pedido-troca.js';
import { casarPedidosDeTroca } from '../functions/api/troca-busca.js';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

const original = {
  id: 'gid://shopify/Order/1', name: '#9250', email: 'l@x.com', phone: '+5511999999999', customer: { id: 'gid://shopify/Customer/7' },
  shippingAddress: { firstName: 'Lais', lastName: 'Jarilho', address1: 'Rua A, 10', address2: 'Bairro', city: 'São Paulo', provinceCode: 'SP', zip: '02860-070', countryCodeV2: 'BR', phone: '11999999999', company: null },
  localizedFields: { nodes: [{ key: 'TAX_CREDENTIAL_BR', value: '123.456.789-00' }] },
};
const itens = [
  { tipo: 'troca', nova_variante_id: 'gid://shopify/ProductVariant/M', qtd: 1 },
  { tipo: 'credito', qtd: 1 },
];

console.log('\n1) Rascunho igual ao manual');
{
  const d = montarRascunho({ original, itens: itens.filter(i => i.tipo === 'troca'), protocolo: 'TP9250-K2AB', numeroOriginal: '9250' });
  ok('mesma cliente', d.purchasingEntity, { customerId: 'gid://shopify/Customer/7' });
  ok('mesmo endereço', [d.shippingAddress.city, d.shippingAddress.zip, d.shippingAddress.countryCode], ['São Paulo', '02860-070', 'BR']);
  ok('CPF copiado do pedido original', d.localizedFields, [{ key: 'TAX_CREDENTIAL_BR', value: '123.456.789-00' }]);
  ok('peça nova com 100% de desconto', d.lineItems, [{ variantId: 'gid://shopify/ProductVariant/M', quantity: 1, appliedDiscount: { valueType: 'PERCENTAGE', value: 100, title: 'Troca' } }]);
  ok('frete zero e sem desconto automático', [d.shippingLine.priceWithCurrency.amount, d.acceptAutomaticDiscounts], [0, false]);
  ok('tags que o painel e o robô leem', d.tags, ['troca', 'troca-aguardando', 'troca-de-9250', 'tp-tp9250-k2ab']);
  ok('nota começa com TROCA, como os manuais', /^TROCA do pedido #9250/.test(d.note), true);
}

function shopifyFalsa({ jaExiste = null, foStatus = 'OPEN' } = {}) {
  const chamadas = [];
  const gql = async (query, vars) => {
    chamadas.push({ query, vars });
    if (query.includes('orders(first: 1, query: $q) { nodes { id name } }')) return { orders: { nodes: jaExiste ? [jaExiste] : [] } };
    if (query.includes('localizedFields')) return { orders: { nodes: vars.q === 'name:#9250' ? [original] : [] } };
    if (query.includes('draftOrderCreate')) return { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/1' }, userErrors: [] } };
    if (query.includes('draftOrderComplete')) return { draftOrderComplete: { draftOrder: { order: { id: 'gid://shopify/Order/99', name: '#9401' } }, userErrors: [] } };
    if (query.includes('fulfillmentOrders')) return { order: { id: 'gid://shopify/Order/99', name: '#9401', tags: [TAG_AGUARDANDO], fulfillmentOrders: { nodes: [{ id: 'gid://shopify/FulfillmentOrder/5', status: foStatus }] } } };
    if (query.includes('fulfillmentOrderHold(')) return { fulfillmentOrderHold: { fulfillmentOrder: { id: vars.id, status: 'ON_HOLD' }, userErrors: [] } };
    if (query.includes('fulfillmentOrderReleaseHold')) return { fulfillmentOrderReleaseHold: { fulfillmentOrder: { id: vars.id, status: 'OPEN' }, userErrors: [] } };
    if (query.includes('tagsRemove')) return { tagsRemove: { userErrors: [] } };
    if (query.includes('tagsAdd')) return { tagsAdd: { userErrors: [] } };
    throw new Error('consulta inesperada: ' + query.slice(0, 60));
  };
  return { gql, chamadas };
}

console.log('\n2) Criar e travar');
{
  const { gql, chamadas } = shopifyFalsa();
  const r = await criarPedidoTroca(gql, { numeroOriginal: '#9250', itens, protocolo: 'TP9250-K2AB' });
  ok('pedido criado e travado', [r.name, r.travado], ['#9401', true]);
  const hold = chamadas.find(c => c.query.includes('fulfillmentOrderHold('));
  ok('trava com o motivo de devolução pendente', hold && hold.vars.h.reason, 'AWAITING_RETURN_ITEMS');
  const criou = chamadas.find(c => c.query.includes('draftOrderCreate'));
  ok('só a peça da troca entra (crédito não)', criou.vars.input.lineItems.length, 1);
}
{
  const { gql, chamadas } = shopifyFalsa({ jaExiste: { id: 'gid://shopify/Order/88', name: '#9400' } });
  const r = await criarPedidoTroca(gql, { numeroOriginal: '9250', itens, protocolo: 'TP9250-K2AB' });
  ok('protocolo que já tem pedido não cria outro', [r.name, r.ja_existia, chamadas.some(c => c.query.includes('draftOrderCreate'))], ['#9400', true, false]);
}
{
  const { gql } = shopifyFalsa();
  ok('sem peça para trocar, nada é criado', await criarPedidoTroca(gql, { numeroOriginal: '9250', itens: [{ tipo: 'credito' }], protocolo: 'X' }), null);
}

console.log('\n3) Conferido solta o envio');
{
  const { gql, chamadas } = shopifyFalsa({ foStatus: 'ON_HOLD' });
  const r = await liberarPedidoTroca(gql, 'gid://shopify/Order/99');
  ok('soltou a espera', r.soltos, 1);
  ok('tirou troca-aguardando e pôs troca-liberada', [chamadas.find(c => c.query.includes('tagsRemove')).vars.tags, chamadas.find(c => c.query.includes('tagsAdd')).vars.tags], [['troca-aguardando'], ['troca-liberada']]);
}

console.log('\n4) Trava vista pelo painel e pelas etiquetas');
{
  const so = readFileSync(join(raiz, 'functions/api/shopify-orders.js'), 'utf8');
  ok('produção lê as tags e marca aguarda_troca', [/total_price,tags'/.test(so), /aguarda_troca:/.test(so)], [true, true]);
  const et = readFileSync(join(raiz, 'functions/api/etiquetas-dados.js'), 'utf8');
  ok('etiquetas marcam travado_troca', /travado_troca: \(o\.tags \|\| \[\]\)\.includes\('troca-aguardando'\)/.test(et), true);
  const main = readFileSync(join(raiz, 'main.js'), 'utf8');
  ok('PRONTOS PARA ENVIO separa o pedido de troca', /if \(ped\.aguarda_troca\) \{ aguardandoTroca\.push\(ped\); continue; \}/.test(main), true);
  const a = main.indexOf('function portalPedidoTroca'), b = main.indexOf('// Acrescenta só o que ainda não está na lista');
  const { portalPedidoTroca, portalAtualizarPedidoTroca } = new Function(`${main.slice(a, b)}; return { portalPedidoTroca, portalAtualizarPedidoTroca };`)();
  ok('linha do portal leva o pedido de troca', portalPedidoTroca({ pedido_troca: { id: 'g1', name: '#9401' } }), { pedido_troca: '#9401', pedido_troca_id: 'g1', erro_pedido_troca: '' });
  ok('ou o erro, se a Shopify falhou', portalPedidoTroca({ erro_pedido_troca: 'falhou' }).erro_pedido_troca, 'falhou');
  const cfg = { itens: [{ id: 'x', pedido_troca_id: '' }] };
  ok('linha já importada recebe o pedido criado depois', [portalAtualizarPedidoTroca(cfg, [{ id: 'x', pedido_troca: '#9401', pedido_troca_id: 'g1' }]), cfg.itens[0].pedido_troca], [1, '#9401']);
}

console.log('\n5) Pedido de troca feito à mão (casos reais de 19/10/2026)');
{
  const cli = id => ({ id: 'gid://shopify/Customer/' + id });
  const originais = [
    { name: '#8672', createdAt: '2026-07-29T14:46:27Z', email: 'aline@x.com', customer: cli(1) },
    { name: '#8560', createdAt: '2026-07-17T14:16:13Z', email: 'lis@x.com', customer: cli(2) },
    { name: '#8705', createdAt: '2026-08-03T00:40:48Z', email: 'ludi@x.com', customer: cli(3) },
  ];
  const r = (o) => ({ cancelledAt: null, tags: [], fulfillments: [], displayFulfillmentStatus: 'UNFULFILLED', ...o });
  const rascunhos = [
    r({ name: '#9196', id: 'g9196', createdAt: '2026-09-30T16:41:38Z', customer: cli(1), note: 'Troca', currentTotalPriceSet: { shopMoney: { amount: '0.0' } }, displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ createdAt: '2026-10-16T18:30:29Z', trackingInfo: [{ number: 'DZ6GH63P' }] }] }),
    r({ name: '#9175', id: 'g9175', createdAt: '2026-09-28T12:09:17Z', customer: cli(2), note: 'TROCA', currentTotalPriceSet: { shopMoney: { amount: '150.0' } } }),
    r({ name: '#9300', id: 'g9300', createdAt: '2026-10-10T00:00:00Z', customer: cli(3), note: 'PAGO PELO PIX', currentTotalPriceSet: { shopMoney: { amount: '201.33' } } }),
    r({ name: '#8000', id: 'g8000', createdAt: '2026-07-01T00:00:00Z', customer: cli(1), note: 'Troca', currentTotalPriceSet: { shopMoney: { amount: '0.0' } } }),
  ];
  const m = casarPedidosDeTroca(originais, rascunhos);
  ok('R$ 0 da mesma cliente depois do original, enviado com rastreio', [m['#8672'].name, m['#8672'].enviado, m['#8672'].rastreio], ['#9196', true, 'DZ6GH63P']);
  ok('TROCA com diferença paga (R$ 150) também conta', m['#8560'].name, '#9175');
  ok('venda comum por rascunho (Pix) não é pedido de troca', m['#8705'], null);
}

console.log(falhas ? `\n✗ ${falhas} de ${total} falharam` : `\n✓ TODOS OS TESTES PASSARAM — ${total}/${total}`);
if (falhas) process.exit(1);
