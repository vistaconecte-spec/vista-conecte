/**
 * Cloudflare Pages Function: /api/shopify-redirects
 * GET  (sem params)                  -> lista os redirects existentes
 * GET  ?path=/products/x             -> verifica se já existe redirect pra esse path
 * POST { path, target, confirmar }   -> cria um redirect (path -> target). Sem confirmar:true = dry-run.
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  const sh = { 'X-Shopify-Access-Token': token };
  const api = (p) => `https://${store}/admin/api/${API_VERSION}/${p}`;

  try {
    if (request.method === 'GET') {
      const path = new URL(request.url).searchParams.get('path');
      let url = path ? api(`redirects.json?path=${encodeURIComponent(path)}`) : api('redirects.json?limit=250');
      const acc = [];
      while (url) {
        const res = await fetch(url, { headers: sh });
        const data = await res.json();
        acc.push(...(data.redirects || []));
        const link = res.headers.get('Link') || '';
        const next = link.match(/<([^>]+)>;\s*rel="next"/);
        url = next ? next[1] : null;
      }
      return new Response(JSON.stringify({ total: acc.length, redirects: acc }, null, 2), { headers });
    }

    const b = await request.json();
    if (!b.path || !b.target) return new Response(JSON.stringify({ erro: 'informe path e target' }), { status: 400, headers });
    if (b.confirmar !== true) {
      return new Response(JSON.stringify({ modo: 'dry-run (nada criado)', path: b.path, target: b.target }, null, 2), { headers });
    }
    const r = await fetch(api('redirects.json'), {
      method: 'POST', headers: { ...sh, 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect: { path: b.path, target: b.target } }),
    });
    const j = await r.json();
    if (!r.ok) return new Response(JSON.stringify({ erro: `falha ${r.status}`, detalhe: j }, null, 2), { status: 502, headers });
    return new Response(JSON.stringify({ ok: true, redirect: j.redirect }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
