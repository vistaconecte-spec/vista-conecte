/**
 * Vale de compensação por atraso/tentativa de cancelamento, criado AUTOMÁTICO pela Vi quando a
 * cliente confirma que aceita (functions/_vale_atraso.js, functions/api/vale-atraso.js, 12/11/2026).
 *
 * Regra da Bárbara: só automático em pedidos >= R$ 300; código estável por pedido (idempotente);
 * preso à cliente; cupom de valor fixo, uso único; validade aberta (180 dias).
 *
 * Caso de referência (Ana Cecília #9056, R$ 275,29): fica ABAIXO do mínimo, então continua manual.
 *
 * Rodar:  node tests/vale-atraso.test.mjs
 */
import * as VA from '../functions/_vale_atraso.js';
import { onRequestPost } from '../functions/api/vale-atraso.js';

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

console.log('\n1) Código, mínimo e mensagem');
{
  const c = VA.codigoValeAtraso('#9999');
  ok('código começa com DESC + pedido', /^DESC9999[A-Z0-9]{4}$/.test(c), true);
  ok('mesmo pedido, mesmo código', VA.codigoValeAtraso('9999'), c);
  ok('outro pedido, outro código', VA.codigoValeAtraso('9998') !== c, true);
  ok('mínimo é R$ 300', VA.MINIMO_PEDIDO_ATRASO, 300);
  const agora = new Date('2026-11-12T15:00:00Z');
  ok('validade 180 dias', VA.dataValeAtraso(agora).toISOString(), '2027-05-11T15:00:00.000Z');
  const m = VA.mensagemValeAtraso({ valor: 149, codigo: 'DESC9999ABCD', ate: '2027-05-11T15:00:00.000Z' });
  ok('mensagem tem valor, código e validade, sem saudação repetida', [/^Oi /.test(m), m.includes('R$ 149,00'), m.includes('DESC9999ABCD'), m.includes('11/05/2027')], [false, true, true, true]);
  ok('sem travessão, sem dois-pontos, sem "amor"', [/—/.test(m), /:/.test(m), /amor/i.test(m)], [false, false, false]);
}

console.log('\n2) Endpoint (Shopify simulada)');
{
  const criados = [];
  let tags = [];
  let existente = null;
  globalThis.fetch = async (url, opts) => {
    const { query, variables } = JSON.parse(opts.body);
    if (query.includes('orders(')) {
      if (variables.q === 'name:#9150') return new Response(JSON.stringify({ data: { orders: { nodes: [{ id: 'gid://shopify/Order/1', name: '#9150', cancelledAt: null, displayFinancialStatus: 'PAID', customer: { id: 'gid://shopify/Customer/7' }, shippingAddress: { name: 'Ana Cliente' }, currentTotalPriceSet: { shopMoney: { amount: '420.00' } } }] } } }));
      if (variables.q === 'name:#9056') return new Response(JSON.stringify({ data: { orders: { nodes: [{ id: 'gid://shopify/Order/2', name: '#9056', cancelledAt: null, displayFinancialStatus: 'PAID', customer: { id: 'gid://shopify/Customer/8' }, shippingAddress: { name: 'Ana Cecília' }, currentTotalPriceSet: { shopMoney: { amount: '275.29' } } }] } } }));
      if (variables.q === 'name:#9200') return new Response(JSON.stringify({ data: { orders: { nodes: [{ id: 'gid://shopify/Order/3', name: '#9200', cancelledAt: null, displayFinancialStatus: 'PENDING', customer: null, shippingAddress: { name: 'Beatriz' }, currentTotalPriceSet: { shopMoney: { amount: '500.00' } } }] } } }));
      return new Response(JSON.stringify({ data: { orders: { nodes: [] } } }));
    }
    if (query.includes('codeDiscountNodeByCode')) return new Response(JSON.stringify({ data: { codeDiscountNodeByCode: existente } }));
    if (query.includes('tagsAdd')) { tags = [...tags, ...variables.tags]; return new Response(JSON.stringify({ data: { tagsAdd: { userErrors: [] } } })); }
    criados.push(variables.d);
    return new Response(JSON.stringify({ data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://x', codeDiscount: { endsAt: variables.d.endsAt } }, userErrors: [] } } }));
  };
  const chamar = async b => { const r = await onRequestPost({ env: { SHOPIFY_STORE_DOMAIN: 'l', SHOPIFY_ADMIN_TOKEN: 't' }, request: new Request('https://x', { method: 'POST', body: JSON.stringify(b) }) }); return { s: r.status, j: await r.json() }; };

  const r1 = await chamar({ pedido: '#9150', valor: 149, cliente: 'Ana Cliente' });
  ok('pedido acima de 300: cria o cupom preso à cliente', [r1.s, r1.j.ok, criados.length, criados[0]?.context?.customers?.add?.[0]], [200, true, 1, 'gid://shopify/Customer/7']);
  ok('cupom combina com desconto de produto e frete, não com de pedido', criados[0]?.combinesWith, { orderDiscounts: false, productDiscounts: true, shippingDiscounts: true });
  ok('tag vale-atraso-vi gravada no pedido', tags, ['vale-atraso-vi']);
  ok('devolve a mensagem pronta para a Vi mandar', /DESC9150/.test(r1.j.mensagem || ''), true);

  existente = { id: 'gid://x', codeDiscount: { endsAt: r1.j.ate, customerGets: { value: { amount: { amount: '149' } } } } };
  const r1b = await chamar({ pedido: '#9150', valor: 149 });
  ok('segunda chamada não cria outro (idempotente)', [r1b.j.ja_existia, criados.length], [true, 1]);
  existente = null;

  const r2 = await chamar({ pedido: '#9056', valor: 149, cliente: 'Ana Cecília' });
  ok('caso de referência (#9056, R$ 275,29) fica abaixo do mínimo: continua manual', [r2.s, r2.j.abaixo_do_minimo, criados.length], [422, true, 1]);

  const r3 = await chamar({ pedido: '#9200', valor: 149 });
  ok('pagamento não confirmado é recusado', [r3.s, criados.length], [422, 1]);

  const r4 = await chamar({ pedido: '#1', valor: 149 });
  ok('pedido inexistente', r4.s, 404);

  const r5 = await chamar({ pedido: '#9150', valor: 9999 });
  ok('valor acima do pago no pedido é recusado', [r5.s, criados.length], [422, 1]);
}

console.log(falhas ? `\n✗ ${falhas} de ${total} falharam` : `\n✓ TODOS OS TESTES PASSARAM — ${total}/${total}`);
if (falhas) process.exit(1);
