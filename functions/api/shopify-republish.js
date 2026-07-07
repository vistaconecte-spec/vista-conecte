/**
 * /api/shopify-republish  — re-publica o tema ativo (role:main) pra forçar
 * invalidação da cache de página da home. Re-afirma o MESMO tema main (seguro).
 */
const API_VERSION = '2024-04';
export async function onRequest({ request, env }) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  const token = env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN;
  const shop = env.SHOPIFY_STORE_DOMAIN;
  if (!token || !shop) return new Response(JSON.stringify({ erro: 'env' }), { status: 500, headers });
  const sh = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  try {
    const themes = (await (await fetch(`https://${shop}/admin/api/${API_VERSION}/themes.json`, { headers: sh })).json()).themes || [];
    const main = themes.find(t => t.role === 'main');
    if (!main) return new Response(JSON.stringify({ erro: 'sem tema main' }), { status: 404, headers });
    const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/themes/${main.id}.json`, {
      method: 'PUT', headers: sh, body: JSON.stringify({ theme: { id: main.id, role: 'main' } }),
    });
    const txt = await r.text();
    return new Response(JSON.stringify({ ok: r.ok, status: r.status, tema: main.name, id: main.id, resp: txt.slice(0, 200) }, null, 2), { status: r.ok ? 200 : 502, headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
