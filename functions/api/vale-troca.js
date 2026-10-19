/**
 * Cloudflare Pages Function: /api/vale-troca (exige sessão, como todo /api)
 *
 * POST { pedido: '#9250', item_id, valor, cliente } → cria na Shopify o cupom do vale-troca da
 * cliente que preferiu crédito na loja (regras em functions/_vale.js) e devolve o código e a
 * mensagem pronta para a Marcelly mandar no WhatsApp.
 *
 * Idempotente: o código sai do item da lista, então clicar duas vezes devolve o cupom que já
 * existe em vez de criar outro. O valor é conferido contra o total pago do pedido.
 */
import { codigoVale, validarValor, mensagemVale, inputDesconto, dataVale } from '../_vale.js';

const API_VERSION = '2024-10';

const Q_PEDIDO = `query($q: String!) {
  orders(first: 1, query: $q) { nodes { name email customer { id } shippingAddress { name } currentTotalPriceSet { shopMoney { amount } } } }
}`;
const Q_EXISTE = `query($code: String!) {
  codeDiscountNodeByCode(code: $code) { id codeDiscount { ... on DiscountCodeBasic { endsAt status customerGets { value { ... on DiscountAmount { amount { amount } } } } } } }
}`;
const MUTATION = `mutation($d: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $d) {
    codeDiscountNode { id codeDiscount { ... on DiscountCodeBasic { endsAt status codes(first: 1) { nodes { code } } } } }
    userErrors { field message }
  }
}`;

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function onRequestPost({ env, request }) {
  let b = {};
  try { b = await request.json(); } catch { return json({ erro: 'corpo inválido' }, 400); }
  const numero = String(b.pedido || '').replace(/\D/g, '');
  if (!numero || !b.item_id) return json({ erro: 'informe pedido e item_id' }, 400);

  const gql = async (query, variables) => {
    const r = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST', headers: { 'X-Shopify-Access-Token': env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json();
    if (j.errors) throw new Error('Shopify: ' + JSON.stringify(j.errors).slice(0, 200));
    return j.data;
  };

  try {
    const o = ((await gql(Q_PEDIDO, { q: `name:#${numero}` })).orders.nodes || [])[0];
    if (!o || o.name !== '#' + numero) return json({ erro: `pedido #${numero} não encontrado na Shopify` }, 404);
    const nome = b.cliente || (o.shippingAddress && o.shippingAddress.name) || '';
    const codigo = codigoVale(numero, b.item_id);

    const existe = (await gql(Q_EXISTE, { code: codigo })).codeDiscountNodeByCode;
    if (existe) {
      const d = existe.codeDiscount || {};
      const valor = Number(d.customerGets?.value?.amount?.amount) || Number(b.valor) || 0;
      return json({ ok: true, ja_existia: true, codigo, valor, ate: d.endsAt, mensagem: mensagemVale({ nome, valor, codigo, ate: d.endsAt }) });
    }

    const v = validarValor(b.valor, o.currentTotalPriceSet?.shopMoney?.amount);
    if (v.erro) return json({ erro: v.erro }, 422);
    const agora = new Date();
    const r = (await gql(MUTATION, { d: inputDesconto({ codigo, valor: v.valor, titulo: `Vale troca #${numero} ${nome}`.trim(), customerId: o.customer && o.customer.id, agora }) })).discountCodeBasicCreate;
    if (r.userErrors && r.userErrors.length) return json({ erro: 'Shopify recusou o cupom: ' + r.userErrors.map(e => e.message).join('; ') }, 400);
    const ate = r.codeDiscountNode?.codeDiscount?.endsAt || dataVale(agora).toISOString();
    return json({ ok: true, codigo, valor: v.valor, ate, preso_a_cliente: !!(o.customer && o.customer.id), mensagem: mensagemVale({ nome, valor: v.valor, codigo, ate }) });
  } catch (e) {
    return json({ erro: e.message }, 502);
  }
}
