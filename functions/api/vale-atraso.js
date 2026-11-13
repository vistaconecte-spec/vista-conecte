/**
 * Cloudflare Pages Function: /api/vale-atraso
 *
 * POST { pedido, valor, cliente } cria, direto na Shopify, o cupom de compensação por atraso
 * ou tentativa de cancelamento (regras em functions/_vale_atraso.js) e devolve o código e a
 * mensagem pronta para a Vi mandar na hora, SEM passar pela equipe.
 *
 * Regra da Bárbara (12/11/2026): só automático em pedidos com total atual >= R$ 300,00; abaixo
 * disso devolve erro com `abaixo_do_minimo: true` e a Vi continua registrando o caso para a
 * equipe criar o link à mão, como era antes.
 *
 * Quem chama é a Vi (worker do Wati), com o header X-VC-Token (mesmo mecanismo das rotinas
 * automáticas que já furam o cadeado de sessão em functions/api/_middleware.js).
 *
 * Idempotente: código estável por pedido (ver codigoValeAtraso), chamar duas vezes devolve o
 * cupom que já existe em vez de criar outro.
 */
import { validarValor } from '../_vale.js';
import { MINIMO_PEDIDO_ATRASO, codigoValeAtraso, dataValeAtraso, mensagemValeAtraso } from '../_vale_atraso.js';

const API_VERSION = '2026-04';

const Q_PEDIDO = `query($q: String!) {
  orders(first: 1, query: $q) { nodes { id name cancelledAt displayFinancialStatus customer { id } shippingAddress { name } currentTotalPriceSet { shopMoney { amount } } } }
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
const M_TAG = `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`;

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// Mesmo formato de input do cupom que o vale-troca usa (context, não customerSelection; uso
// único; preso à cliente). Duplicado aqui de propósito com título diferente — inputDesconto do
// _vale.js monta o título a partir do vale de devolução, este é o de compensação.
function inputDescontoAtraso({ codigo, valor, titulo, customerId, agora }) {
  return {
    title: titulo,
    code: codigo,
    startsAt: agora.toISOString(),
    endsAt: dataValeAtraso(agora).toISOString(),
    usageLimit: 1,
    appliesOncePerCustomer: true,
    context: customerId ? { customers: { add: [customerId] } } : { all: 'ALL' },
    customerGets: { value: { discountAmount: { amount: String(valor), appliesOnEachItem: false } }, items: { all: true } },
    combinesWith: { orderDiscounts: false, productDiscounts: true, shippingDiscounts: true },
  };
}

export async function onRequestPost({ env, request }) {
  let b = {};
  try { b = await request.json(); } catch { return json({ erro: 'corpo inválido' }, 400); }
  const numero = String(b.pedido || '').replace(/\D/g, '');
  if (!numero) return json({ erro: 'informe o pedido' }, 400);
  const valorPedido = Number(b.valor) || 149;

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
    if (o.cancelledAt) return json({ erro: 'pedido cancelado: não dá para gerar o desconto' }, 422);
    if (o.displayFinancialStatus !== 'PAID') return json({ erro: 'o pagamento do pedido não está confirmado' }, 422);

    const totalPedido = Number(o.currentTotalPriceSet?.shopMoney?.amount) || 0;
    if (totalPedido < MINIMO_PEDIDO_ATRASO) {
      return json({ erro: `pedido de ${totalPedido.toFixed(2)} está abaixo do mínimo de R$ ${MINIMO_PEDIDO_ATRASO.toFixed(2)}: este caso continua manual`, abaixo_do_minimo: true, total_pedido: totalPedido }, 422);
    }

    const nome = b.cliente || (o.shippingAddress && o.shippingAddress.name) || '';
    const codigo = codigoValeAtraso(numero);

    const existe = (await gql(Q_EXISTE, { code: codigo })).codeDiscountNodeByCode;
    if (existe) {
      const d = existe.codeDiscount || {};
      const valor = Number(d.customerGets?.value?.amount?.amount) || valorPedido;
      return json({ ok: true, ja_existia: true, codigo, valor, ate: d.endsAt, mensagem: mensagemValeAtraso({ valor, codigo, ate: d.endsAt }) });
    }

    const v = validarValor(valorPedido, totalPedido);
    if (v.erro) return json({ erro: v.erro }, 422);
    const agora = new Date();
    const r = (await gql(MUTATION, { d: inputDescontoAtraso({ codigo, valor: v.valor, titulo: `Compensação atraso #${numero} ${nome}`.trim(), customerId: o.customer && o.customer.id, agora }) })).discountCodeBasicCreate;
    if (r.userErrors && r.userErrors.length) return json({ erro: 'Shopify recusou o cupom: ' + r.userErrors.map(e => e.message).join('; ') }, 400);
    const ate = r.codeDiscountNode?.codeDiscount?.endsAt || dataValeAtraso(agora).toISOString();
    await gql(M_TAG, { id: o.id, tags: ['vale-atraso-vi'] }).catch(() => {});
    return json({ ok: true, codigo, valor: v.valor, ate, preso_a_cliente: !!(o.customer && o.customer.id), mensagem: mensagemValeAtraso({ valor: v.valor, codigo, ate }) });
  } catch (e) {
    return json({ erro: e.message }, 502);
  }
}
