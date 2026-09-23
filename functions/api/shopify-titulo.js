/**
 * Cloudflare Pages Function: /api/shopify-titulo
 * Renomeia um produto (título). Dry-run por padrão.
 *   POST { id, titulo, confirmar }
 */
const API_VERSION = '2024-04';

export async function onRequest({ request, env }) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ erro: 'use POST' }), { status: 405, headers });
  const token = env.SHOPIFY_ADMIN_TOKEN, store = env.SHOPIFY_STORE_DOMAIN;
  if (!token || !store) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  let b; try { b = await request.json(); } catch (_) { return new Response(JSON.stringify({ erro: 'JSON inválido' }), { status: 400, headers }); }
  const { id, titulo } = b;
  if (!id || !titulo) return new Response(JSON.stringify({ erro: 'informe id e titulo' }), { status: 400, headers });
  const sh = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  const url = `https://${store}/admin/api/${API_VERSION}/products/${id}.json`;

  const r0 = await fetch(url, { headers: sh });
  if (!r0.ok) return new Response(JSON.stringify({ erro: `produto não encontrado: ${r0.status}` }), { status: 404, headers });
  const atual = (await r0.json()).product;

  if (b.confirmar !== true) {
    return new Response(JSON.stringify({ modo: 'dry-run (nada gravado)', id, titulo_atual: atual.title, titulo_novo: titulo, handle_atual: atual.handle }, null, 2), { headers });
  }
  const r = await fetch(url, { method: 'PUT', headers: sh, body: JSON.stringify({ product: { id, title: titulo } }) });
  const j = await r.json();
  if (!r.ok) return new Response(JSON.stringify({ erro: `falha ${r.status}`, detalhe: j }, null, 2), { status: 502, headers });
  return new Response(JSON.stringify({ ok: true, id, titulo_anterior: atual.title, titulo_novo: j.product.title, handle: j.product.handle }, null, 2), { headers });
}
