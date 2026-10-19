/**
 * Cloudflare Pages Function: /api/troca-busca (exige sessão, como todo /api)
 *
 * POST { pedidos: ['#8483', '#8672', ...] } → para cada troca lançada à mão, o pedido de troca
 * de R$ 0 que a equipe criou na Shopify (pedido da Bárbara, 19/10/2026: "temos que confirmar se
 * foi criado o pedido de troca manual da Shopify pela Marcelly").
 *
 * Casamento: pedido feito por rascunho (source shopify_draft_order), de R$ 0 OU com "troca" na nota
 * (o #9175 da Lis é TROCA de R$ 150: ela pagou a diferença), da MESMA cliente
 * (id ou e-mail) e criado DEPOIS do pedido original. É o padrão dos manuais (#9347, #9196...).
 * Quando há mais de um, fica o mais antigo depois do original. O filtro total_price da busca da
 * Shopify não funciona (devolve pedido de R$ 385), por isso o R$ 0 é conferido aqui.
 */
const API_VERSION = '2026-04';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const Q_ORIGINAIS = `query($q: String!) { orders(first: 50, query: $q) { nodes { name createdAt email customer { id } } } }`;
const Q_RASCUNHOS = `query($q: String!, $after: String) {
  orders(first: 250, query: $q, after: $after, sortKey: CREATED_AT) {
    nodes { id name createdAt email customer { id } note tags displayFulfillmentStatus cancelledAt
      currentTotalPriceSet { shopMoney { amount } }
      fulfillments(first: 3) { createdAt trackingInfo { number } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

export function casarPedidosDeTroca(originais, rascunhos) {
  const out = {};
  for (const o of originais) {
    const cand = rascunhos
      .filter(r => !r.cancelledAt && (Number(r.currentTotalPriceSet?.shopMoney?.amount) === 0 || /troca/i.test(r.note || '') || (r.tags || []).includes('troca')))
      .filter(r => r.name !== o.name && String(r.createdAt) > String(o.createdAt))
      .filter(r => (o.customer && r.customer && r.customer.id === o.customer.id)
        || (o.email && r.email && r.email.toLowerCase() === o.email.toLowerCase()))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const r = cand[0];
    out[o.name] = r ? {
      name: r.name, id: r.id, criado_em: r.createdAt,
      enviado: r.displayFulfillmentStatus === 'FULFILLED',
      rastreio: ((r.fulfillments || []).flatMap(f => f.trackingInfo || []).map(t => t.number).filter(Boolean)[0]) || '',
      enviado_em: ((r.fulfillments || [])[0] || {}).createdAt || '',
      nota: String(r.note || '').slice(0, 80),
    } : null;
  }
  return out;
}

export async function onRequestPost({ env, request }) {
  let b = {};
  try { b = await request.json(); } catch { return json({ erro: 'corpo inválido' }, 400); }
  const nums = [...new Set((b.pedidos || []).map(p => String(p).replace(/\D/g, '')).filter(Boolean))].slice(0, 50);
  if (!nums.length) return json({ pedidos: {} });
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
    const originais = [];
    for (let i = 0; i < nums.length; i += 25) {
      const q = nums.slice(i, i + 25).map(n => `name:#${n}`).join(' OR ');
      originais.push(...(await gql(Q_ORIGINAIS, { q })).orders.nodes);
    }
    if (!originais.length) return json({ pedidos: {} });
    const desde = originais.map(o => o.createdAt).sort()[0].slice(0, 10);
    const rascunhos = [];
    let after = null;
    for (let pg = 0; pg < 4; pg++) {
      const d = (await gql(Q_RASCUNHOS, { q: `source_name:shopify_draft_order AND created_at:>=${desde}`, after })).orders;
      rascunhos.push(...d.nodes);
      if (!d.pageInfo.hasNextPage) break;
      after = d.pageInfo.endCursor;
    }
    return json({ pedidos: casarPedidosDeTroca(originais, rascunhos) });
  } catch (e) {
    return json({ erro: e.message }, 502);
  }
}
