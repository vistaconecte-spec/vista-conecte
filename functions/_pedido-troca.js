/**
 * Pedido de troca de R$ 0 na Shopify (19/10/2026, fluxo validado com a Bárbara).
 *
 * É o mesmo pedido que a equipe já fazia à mão (rascunho com 100% de desconto e a nota
 * "TROCA", ex. #9347), agora criado sozinho QUANDO A CLIENTE PEDE a troca no portal, para a
 * peça nova entrar na produção enquanto a antiga vem pelos Correios. Ele nasce TRAVADO:
 *  - na Shopify, com o envio "em espera" (motivo AWAITING_RETURN_ITEMS, aguardando a devolução);
 *  - com a tag `troca-aguardando`, que o card PRONTOS PARA ENVIO e o robô de etiquetas leem.
 * A equipe destrava no botão "conferido" da aba TROCAS, depois de abrir o pacote da peça antiga.
 *
 * Fica fora da nota do Bling sozinho (a rotina só emite para total > 0) e soma R$ 0 no
 * faturamento, como os manuais de hoje.
 */

export const TAG_TROCA = 'troca';
export const TAG_AGUARDANDO = 'troca-aguardando';
export const TAG_LIBERADA = 'troca-liberada';
export const tagProtocolo = protocolo => 'tp-' + String(protocolo || '').toLowerCase();

const Q_ORIGINAL = `query($q: String!) {
  orders(first: 1, query: $q) { nodes {
    id name email phone customer { id }
    shippingAddress { firstName lastName address1 address2 city provinceCode zip countryCodeV2 phone company }
    localizedFields(first: 5) { nodes { key value } }
  } }
}`;
const Q_JA_EXISTE = `query($q: String!) { orders(first: 1, query: $q) { nodes { id name } } }`;
const M_CRIAR = `mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id } userErrors { field message } } }`;
const M_COMPLETAR = `mutation($id: ID!) { draftOrderComplete(id: $id) { draftOrder { order { id name } } userErrors { field message } } }`;
const Q_FULFILLMENT_ORDERS = `query($id: ID!) { order(id: $id) { id name tags fulfillmentOrders(first: 10) { nodes { id status } } } }`;
const M_SEGURAR = `mutation($id: ID!, $h: FulfillmentOrderHoldInput!) { fulfillmentOrderHold(id: $id, fulfillmentHold: $h) { fulfillmentOrder { id status } userErrors { field message } } }`;
const M_SOLTAR = `mutation($id: ID!) { fulfillmentOrderReleaseHold(id: $id) { fulfillmentOrder { id status } userErrors { field message } } }`;
const M_TIRAR_TAG = `mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`;
const M_POR_TAG = `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`;

const erros = (r, nome) => {
  const e = (r && r.userErrors) || [];
  if (e.length) throw new Error(`${nome}: ${e.map(x => x.message).join('; ')}`);
};

// Rascunho igual ao manual: mesma cliente, mesmo endereço e CPF do pedido original, peças
// novas com 100% de desconto, frete zero. Sem descontos automáticos (combo) por cima.
export function montarRascunho({ original, itens, protocolo, numeroOriginal }) {
  const a = original.shippingAddress || {};
  const endereco = {
    firstName: a.firstName || '', lastName: a.lastName || '', address1: a.address1 || '', address2: a.address2 || '',
    city: a.city || '', provinceCode: a.provinceCode || '', zip: a.zip || '', countryCode: a.countryCodeV2 || 'BR',
    phone: a.phone || original.phone || '', company: a.company || '',
  };
  const cpf = ((original.localizedFields && original.localizedFields.nodes) || []).find(n => n.key === 'TAX_CREDENTIAL_BR');
  const num = String(numeroOriginal || original.name || '').replace(/\D/g, '');
  return {
    ...(original.customer && original.customer.id ? { purchasingEntity: { customerId: original.customer.id } } : {}),
    email: original.email || undefined,
    phone: original.phone || undefined,
    shippingAddress: endereco,
    billingAddress: endereco,
    ...(cpf ? { localizedFields: [{ key: 'TAX_CREDENTIAL_BR', value: cpf.value }] } : {}),
    lineItems: itens.map(it => ({
      variantId: it.nova_variante_id,
      quantity: it.qtd || 1,
      appliedDiscount: { valueType: 'PERCENTAGE', value: 100, title: 'Troca' },
    })),
    shippingLine: { title: 'Troca grátis', priceWithCurrency: { amount: 0, currencyCode: 'BRL' } },
    acceptAutomaticDiscounts: false,
    note: `TROCA do pedido #${num} pelo portal (protocolo ${protocolo}). Peça nova só sai depois que a antiga chegar e for conferida (aba TROCAS).`,
    tags: [TAG_TROCA, TAG_AGUARDANDO, 'troca-de-' + num, tagProtocolo(protocolo)],
  };
}

// Cria (ou acha, se já foi criado para este protocolo) o pedido de troca e trava o envio.
export async function criarPedidoTroca(gql, { numeroOriginal, itens, protocolo }) {
  const num = String(numeroOriginal || '').replace(/\D/g, '');
  const trocas = (itens || []).filter(i => i.tipo === 'troca' && i.nova_variante_id);
  if (!trocas.length) return null;

  const ja = ((await gql(Q_JA_EXISTE, { q: `tag:${tagProtocolo(protocolo)}` })).orders.nodes || [])[0];
  if (ja) return { id: ja.id, name: ja.name, ja_existia: true };

  const original = ((await gql(Q_ORIGINAL, { q: `name:#${num}` })).orders.nodes || [])[0];
  if (!original || original.name !== '#' + num) throw new Error(`pedido original #${num} não encontrado`);

  const criado = (await gql(M_CRIAR, { input: montarRascunho({ original, itens: trocas, protocolo, numeroOriginal: num }) })).draftOrderCreate;
  erros(criado, 'rascunho');
  const fim = (await gql(M_COMPLETAR, { id: criado.draftOrder.id })).draftOrderComplete;
  erros(fim, 'completar rascunho');
  const order = fim.draftOrder.order;
  const travado = await segurar(gql, order.id);
  return { id: order.id, name: order.name, travado };
}

async function segurar(gql, orderId) {
  // O fulfillment order às vezes nasce um instante depois do pedido
  for (let i = 0; i < 3; i++) {
    const fos = ((await gql(Q_FULFILLMENT_ORDERS, { id: orderId })).order.fulfillmentOrders.nodes || []).filter(f => f.status === 'OPEN');
    if (fos.length) {
      for (const f of fos) {
        const r = (await gql(M_SEGURAR, { id: f.id, h: { reason: 'AWAITING_RETURN_ITEMS', reasonNotes: 'Aguardando a peça antiga da troca chegar e ser conferida', notifyMerchant: false } })).fulfillmentOrderHold;
        erros(r, 'travar envio');
      }
      return true;
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  return false; // a tag troca-aguardando continua segurando no painel e no robô
}

// Botão "conferido": solta o envio na Shopify e troca a tag
export async function liberarPedidoTroca(gql, orderId) {
  const o = (await gql(Q_FULFILLMENT_ORDERS, { id: orderId })).order;
  if (!o) throw new Error('pedido de troca não encontrado');
  let soltos = 0;
  for (const f of o.fulfillmentOrders.nodes || []) {
    if (f.status !== 'ON_HOLD') continue;
    const r = (await gql(M_SOLTAR, { id: f.id })).fulfillmentOrderReleaseHold;
    erros(r, 'soltar envio');
    soltos++;
  }
  await gql(M_TIRAR_TAG, { id: o.id, tags: [TAG_AGUARDANDO] });
  await gql(M_POR_TAG, { id: o.id, tags: [TAG_LIBERADA] });
  return { id: o.id, name: o.name, soltos };
}

export function gqlDe(env, versao = '2026-04') {
  return async (query, variables) => {
    const r = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${versao}/graphql.json`, {
      method: 'POST', headers: { 'X-Shopify-Access-Token': env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json();
    if (j.errors) throw new Error('Shopify: ' + JSON.stringify(j.errors).slice(0, 300));
    return j.data;
  };
}
