/**
 * Cloudflare Pages Function: /api/shopify-upload-asset
 * Sobe um arquivo (imagem) como asset do tema.
 * POST JSON: { "theme": "ID", "key": "assets/banner.jpg", "attachment": "<base64>" }
 * Retorna a URL pública do asset.
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });
  if (request.method !== 'POST') return new Response(JSON.stringify({ erro: 'use POST { theme, key, attachment }' }), { status: 405, headers: H });

  let p;
  try { p = await request.json(); } catch (e) { return new Response(JSON.stringify({ erro: 'JSON inválido' }), { status: 400, headers: H }); }
  const { theme, key, attachment } = p;
  if (!theme || !key || !attachment) return new Response(JSON.stringify({ erro: 'informe theme, key, attachment' }), { status: 400, headers: H });

  try {
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/themes/${theme}/assets.json`, {
      method: 'PUT',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset: { key, attachment } }),
    });
    const txt = await r.text();
    if (!r.ok) return new Response(JSON.stringify({ erro: `Shopify ${r.status}`, detalhe: txt.slice(0, 300) }), { status: 502, headers: H });
    const data = JSON.parse(txt);
    return new Response(JSON.stringify({ ok: true, key: data.asset && data.asset.key, public_url: data.asset && data.asset.public_url }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
