/**
 * Cloudflare Pages Function: /api/shopify-criar-produto
 * Cria um produto na Shopify.
 * Body (POST JSON): { titulo, preco, tamanhos:[], status, peso_g, tipo, tags, descricao }
 * Requer write_products.
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ erro: 'Método não permitido' }), { status: 405, headers });
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  let b; try { b = await request.json(); } catch (_) { return new Response(JSON.stringify({ erro: 'JSON inválido' }), { status: 400, headers }); }
  if (!b.titulo || !(parseFloat(b.preco) > 0)) return new Response(JSON.stringify({ erro: 'titulo e preco obrigatórios' }), { status: 400, headers });

  const tamanhos = Array.isArray(b.tamanhos) && b.tamanhos.length ? b.tamanhos : ['Único'];
  const preco = parseFloat(b.preco).toFixed(2);
  const peso = b.peso_g || 0;
  const variants = tamanhos.map(t => ({ option1: t, price: preco, weight: peso, weight_unit: 'g', inventory_management: null }));

  const produto = {
    title: b.titulo,
    body_html: b.descricao || '',
    product_type: b.tipo || '',
    status: b.status === 'ativo' ? 'active' : 'draft',
    tags: b.tags || '',
    options: [{ name: 'Tamanho' }],
    variants,
  };

  try {
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/products.json`,
      { method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ product: produto }) });
    const txt = await r.text();
    if (!r.ok) return new Response(JSON.stringify({ erro: `Shopify ${r.status}`, detalhe: txt.slice(0, 400) }), { status: 502, headers });
    const p = JSON.parse(txt).product;
    return new Response(JSON.stringify({ ok: true, id: p.id, titulo: p.title, status: p.status, variantes: (p.variants || []).length, admin_url: `https://${store}/admin/products/${p.id}` }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
