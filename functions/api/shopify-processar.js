/**
 * Cloudflare Pages Function: /api/shopify-processar
 *
 * Processa (fulfillment) um pedido na Shopify com o código de rastreio da etiqueta da Frenet.
 * Pedido da Bárbara em 26/10/2026: a Manu processava cada pedido à mão na Shopify e digitava o
 * código (às vezes com o link errado, "rastreio.frenet.com.br/" sem o código). Agora o robô de
 * etiquetas vê a etiqueta paga na Frenet e chama esta rota. Com o envio registrado COM código,
 * a Shopify manda o e-mail de envio e o Wati dispara sozinho o pedido_despachado_vi.
 *
 * Decisões dela (26/10/2026): processa logo depois de pagar (não espera a postagem) e só
 * etiqueta ligada ao pedido com certeza (feita pelo robô, ou importada da Shopify pela Frenet);
 * etiqueta feita à mão no simulador da Frenet fica de fora.
 *
 *   POST { numero, codigo, url, transportadora, nome, cidade, confirmar }
 *   → { numero, acao: 'processar' | 'processado' | 'ja_processado' | 'pular', motivo, itens }
 *
 * Sem confirmar:true só diz o que faria. Nome e cidade da etiqueta têm que bater com o endereço
 * de entrega do pedido: é a segunda trava contra código no pedido errado.
 */
const API_VERSION = '2024-04';
const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const normCod = s => String(s || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();

/** Nome da etiqueta e da entrega batem se o primeiro nome e o último sobrenome são iguais. Pura (testes). */
export function mesmaPessoa(a, b) {
  const x = norm(a).split(' '), y = norm(b).split(' ');
  if (!x[0] || !y[0]) return false;
  return x[0] === y[0] && x[x.length - 1] === y[y.length - 1];
}

/** O que fazer com este pedido. Pura (testes). */
export function avaliar(o, et) {
  if (!o) return { acao: 'pular', motivo: 'pedido não encontrado na Shopify' };
  const cod = normCod(et.codigo);
  if (!/^[A-Z0-9]{8,13}$/.test(cod)) return { acao: 'pular', motivo: 'código de rastreio estranho: ' + et.codigo };
  const jaTem = (o.fulfillments || []).flatMap(f => f.trackingInfo || []).map(t => normCod(t.number));
  if (jaTem.includes(cod)) return { acao: 'ja_processado', motivo: 'já está na Shopify com este código' };
  if (o.cancelledAt) return { acao: 'pular', motivo: 'pedido cancelado' };
  if (!['PAID', 'PARTIALLY_REFUNDED'].includes(o.displayFinancialStatus)) return { acao: 'pular', motivo: 'pagamento ' + o.displayFinancialStatus };
  if ((o.tags || []).includes('troca-aguardando')) return { acao: 'pular', motivo: 'troca esperando a peça antiga' };
  if (o.displayFulfillmentStatus === 'FULFILLED') return { acao: 'pular', motivo: 'já processado com outro código (' + (jaTem.join(', ') || 'sem código') + ')' };
  const a = o.shippingAddress || {};
  const nomeEntrega = a.name || [a.firstName, a.lastName].filter(Boolean).join(' ');
  if (!mesmaPessoa(et.nome, nomeEntrega) || norm(et.cidade) !== norm(a.city))
    return { acao: 'pular', motivo: `etiqueta (${et.nome}, ${et.cidade}) não bate com a entrega (${nomeEntrega}, ${a.city})` };
  const abertos = ((o.fulfillmentOrders && o.fulfillmentOrders.edges) || []).map(e => e.node)
    .filter(f => ['OPEN', 'IN_PROGRESS'].includes(f.status))
    .map(f => ({ id: f.id, itens: ((f.lineItems && f.lineItems.edges) || []).reduce((s, e) => s + (e.node.remainingQuantity || 0), 0) }))
    .filter(f => f.itens > 0);
  if (!abertos.length) return { acao: 'pular', motivo: 'nada a enviar neste pedido' };
  return { acao: 'processar', motivo: '', abertos, itens: abertos.reduce((s, f) => s + f.itens, 0) };
}

const QUERY = `query($q: String) {
  orders(first: 5, query: $q) { edges { node {
    id name cancelledAt displayFinancialStatus displayFulfillmentStatus tags
    shippingAddress { name firstName lastName city }
    fulfillments { trackingInfo { number } }
    fulfillmentOrders(first: 10) { edges { node { id status lineItems(first: 50) { edges { node { remainingQuantity } } } } } }
  } } }
}`;
const MUTATION = `mutation($f: FulfillmentV2Input!) {
  fulfillmentCreateV2(fulfillment: $f) { fulfillment { id status } userErrors { field message } }
}`;

async function gql(env, query, variables) {
  const r = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST', headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error('Shopify GraphQL: HTTP ' + r.status);
  const j = await r.json();
  if (j.errors) throw new Error('GraphQL: ' + JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

export async function onRequestPost({ env, request }) {
  if (!env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_ADMIN_TOKEN) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });
  let b; try { b = await request.json(); } catch (_) { return new Response(JSON.stringify({ erro: 'JSON inválido' }), { status: 400, headers: H }); }
  const numero = '#' + String(b.numero || '').replace(/\D/g, '');
  if (numero === '#') return new Response(JSON.stringify({ erro: 'informe numero' }), { status: 400, headers: H });
  try {
    const d = await gql(env, QUERY, { q: 'name:' + numero });
    const o = d.orders.edges.map(e => e.node).find(x => x.name === numero);
    const r = avaliar(o, b);
    const base = { numero, codigo: normCod(b.codigo), acao: r.acao, motivo: r.motivo, itens: r.itens || 0 };
    if (r.acao !== 'processar' || b.confirmar !== true) return new Response(JSON.stringify(base), { headers: H });
    const m = await gql(env, MUTATION, { f: {
      lineItemsByFulfillmentOrder: r.abertos.map(f => ({ fulfillmentOrderId: f.id })),
      trackingInfo: { company: b.transportadora || 'Frenet', number: normCod(b.codigo), url: b.url || `https://rastreio.frenet.com.br/LOG/${normCod(b.codigo)}` },
      notifyCustomer: true,
    } });
    const res = m.fulfillmentCreateV2;
    if (res.userErrors && res.userErrors.length) return new Response(JSON.stringify({ ...base, acao: 'pular', motivo: 'Shopify recusou: ' + res.userErrors.map(e => e.message).join('; ') }), { headers: H });
    return new Response(JSON.stringify({ ...base, acao: 'processado', fulfillment: res.fulfillment && res.fulfillment.id }), { headers: H });
  } catch (err) {
    return new Response(JSON.stringify({ numero, erro: err.message }), { status: 502, headers: H });
  }
}
