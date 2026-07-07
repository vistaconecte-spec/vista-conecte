/**
 * Cloudflare Pages Function: /api/shopify-metafields (somente leitura, diagnóstico)
 * Lista os metafields de uma coleção ou produto — útil pra achar config de apps (ex: Bundler).
 *   ?tipo=collection&id=309896740973
 *   ?tipo=product&id=8142996045933
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  const qs = new URL(request.url).searchParams;
  const tipo = qs.get('tipo');
  const id = qs.get('id');
  if (!tipo || !id) return new Response(JSON.stringify({ erro: 'informe ?tipo=collection|product&id=' }), { status: 400, headers });
  const rota = tipo === 'collection' ? 'collections' : 'products';

  try {
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/${rota}/${id}/metafields.json`, {
      headers: { 'X-Shopify-Access-Token': token },
    });
    if (!r.ok) return new Response(JSON.stringify({ erro: `Shopify ${r.status}`, detalhe: (await r.text()).slice(0, 300) }), { status: 502, headers });
    const d = await r.json();
    return new Response(JSON.stringify({ tipo, id, metafields: d.metafields || [] }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
