/**
 * Cloudflare Pages Function: /api/shopify-vincular-imagem
 * Vincula uma imagem já existente de um produto a uma lista de variant_ids
 * (corrige o caso de foto nova enviada mas não "linkada" à cor/variante).
 * POST { produto_id, imagem_id, variant_ids: [...], confirmar }
 */
const API_VERSION = '2024-04';

export async function onRequest({ request, env }) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ erro: 'use POST' }), { status: 405, headers });
  const token = env.SHOPIFY_ADMIN_TOKEN, store = env.SHOPIFY_STORE_DOMAIN;
  if (!token || !store) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  let b; try { b = await request.json(); } catch (_) { return new Response(JSON.stringify({ erro: 'JSON inválido' }), { status: 400, headers }); }
  const { produto_id, imagem_id, variant_ids } = b;
  if (!produto_id || !imagem_id || !Array.isArray(variant_ids)) {
    return new Response(JSON.stringify({ erro: 'informe produto_id, imagem_id e variant_ids' }), { status: 400, headers });
  }
  const sh = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  const base = `https://${store}/admin/api/${API_VERSION}/products/${produto_id}/images/${imagem_id}.json`;

  if (b.confirmar !== true) {
    return new Response(JSON.stringify({ modo: 'dry-run (nada gravado)', produto_id, imagem_id, variant_ids }, null, 2), { headers });
  }
  try {
    const r = await fetch(base, { method: 'PUT', headers: sh, body: JSON.stringify({ image: { id: imagem_id, variant_ids } }) });
    const j = await r.json();
    if (!r.ok) return new Response(JSON.stringify({ erro: `falha ${r.status}`, detalhe: j }, null, 2), { status: 502, headers });
    return new Response(JSON.stringify({ ok: true, image: j.image }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
