/**
 * Cloudflare Pages Function: /api/shopify-set-desc
 * Define a descrição (body_html) de UM produto.
 * POST JSON: { "id": 123, "html": "<p>...</p>" }
 *   ?apply=1 grava; sem apply = dry-run (mostra a descrição atual + tamanho da nova).
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });
  if (request.method !== 'POST') return new Response(JSON.stringify({ erro: 'use POST { id, html }' }), { status: 405, headers: H });
  const apply = new URL(request.url).searchParams.get('apply') === '1';

  let payload;
  try { payload = await request.json(); } catch (e) { return new Response(JSON.stringify({ erro: 'JSON inválido' }), { status: 400, headers: H }); }
  const id = payload.id, html = payload.html;
  if (!id || typeof html !== 'string') return new Response(JSON.stringify({ erro: 'informe id e html' }), { status: 400, headers: H });

  const base = `https://${store}/admin/api/${API_VERSION}/products/${id}.json`;
  const sh = { 'X-Shopify-Access-Token': token };
  try {
    const get = await fetch(base + '?fields=id,title,body_html', { headers: sh });
    if (!get.ok) return new Response(JSON.stringify({ erro: `Shopify ${get.status}`, detalhe: (await get.text()).slice(0, 200) }), { status: 502, headers: H });
    const p = (await get.json()).product;
    const antesLen = (p.body_html || '').length;

    let resultado = 'dry-run (nada escrito)';
    if (apply) {
      const put = await fetch(base, {
        method: 'PUT', headers: { ...sh, 'Content-Type': 'application/json' },
        body: JSON.stringify({ product: { id: Number(id), body_html: html } }),
      });
      resultado = put.ok ? 'aplicado' : `falha ${put.status}: ${(await put.text()).slice(0, 200)}`;
    }
    return new Response(JSON.stringify({
      produto: p.title, id: p.id,
      descricao_antes_chars: antesLen, descricao_nova_chars: html.length,
      modo: apply ? 'APLICAR' : 'dry-run', resultado,
    }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
