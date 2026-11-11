/**
 * Cloudflare Pages Function: /api/credito-uso (exige sessão, como todo /api; somente leitura)
 *
 * POST { pedidos: ['#9185', '#9065'] } → { uso: { '#9185': { saldo, creditado, usado, expirado, ultimo_uso } } }
 *
 * 11/11/2026 (Bárbara): o cartão do crédito precisa dizer se a cliente já usou o saldo. O crédito fica
 * no cadastro da cliente (storeCreditAccounts), então lê pelo cliente do pedido original. Uma conta
 * de crédito por moeda; aqui só existe BRL.
 */
const API_VERSION = '2026-04';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const Q = `query($q: String!) {
  orders(first: 50, query: $q) { nodes { name customer { storeCreditAccounts(first: 3) { nodes {
    balance { amount }
    transactions(first: 50) { nodes { __typename amount { amount } createdAt } }
  } } } } }
}`;

// Soma por tipo de movimento: crédito entra, débito é compra com o saldo, expiração é o que venceu
export function resumoUso(contas) {
  const r = { saldo: 0, creditado: 0, usado: 0, expirado: 0, ultimo_uso: null };
  for (const c of contas || []) {
    r.saldo += Number(c.balance && c.balance.amount) || 0;
    for (const t of (c.transactions && c.transactions.nodes) || []) {
      const v = Math.abs(Number(t.amount && t.amount.amount) || 0);
      if (t.__typename === 'StoreCreditAccountCreditTransaction') r.creditado += v;
      else if (t.__typename === 'StoreCreditAccountDebitTransaction') { r.usado += v; if (!r.ultimo_uso || t.createdAt > r.ultimo_uso) r.ultimo_uso = t.createdAt; }
      else if (t.__typename === 'StoreCreditAccountDebitRevertTransaction') r.usado -= v;
      else if (t.__typename === 'StoreCreditAccountExpirationTransaction') r.expirado += v;
    }
  }
  for (const k of ['saldo', 'creditado', 'usado', 'expirado']) r[k] = Math.round(r[k] * 100) / 100;
  return r;
}

export async function onRequestPost({ env, request }) {
  let b = {};
  try { b = await request.json(); } catch { return json({ erro: 'corpo inválido' }, 400); }
  const nums = [...new Set((b.pedidos || []).map(p => String(p).replace(/\D/g, '')).filter(Boolean))].slice(0, 50);
  if (!nums.length) return json({ uso: {} });
  try {
    const r = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST', headers: { 'X-Shopify-Access-Token': env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: Q, variables: { q: nums.map(n => 'name:#' + n).join(' OR ') } }),
    });
    const j = await r.json();
    if (j.errors) return json({ erro: 'Shopify: ' + JSON.stringify(j.errors).slice(0, 200) }, 502);
    const uso = {};
    for (const o of (j.data && j.data.orders && j.data.orders.nodes) || []) {
      const contas = o.customer && o.customer.storeCreditAccounts && o.customer.storeCreditAccounts.nodes;
      uso[o.name] = contas && contas.length ? resumoUso(contas) : null;
    }
    return json({ uso });
  } catch (e) {
    return json({ erro: e.message }, 502);
  }
}
