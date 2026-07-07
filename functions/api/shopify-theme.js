/**
 * Cloudflare Pages Function: /api/shopify-theme (somente leitura, diagnóstico)
 *   (sem params)            → lista os temas (id, nome, role)
 *   ?theme=ID&list=1        → lista as chaves de assets do tema
 *   ?theme=ID&list=1&grep=swatch  → só as chaves que contêm "swatch"
 *   ?theme=ID&key=ASSET     → retorna o conteúdo de um asset (ex: sections/main-product.liquid)
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });
  const qs = new URL(request.url).searchParams;
  const theme = qs.get('theme');
  const key = qs.get('key');
  const list = qs.get('list') === '1';
  const grep = (qs.get('grep') || '').toLowerCase();
  const sh = { 'X-Shopify-Access-Token': token };

  try {
    if (!theme) {
      const r = await fetch(`https://${store}/admin/api/${API_VERSION}/themes.json`, { headers: sh });
      const d = await r.json();
      return new Response(JSON.stringify({ temas: (d.themes || []).map(t => ({ id: t.id, nome: t.name, role: t.role })) }, null, 2), { headers: H });
    }
    if (list) {
      const r = await fetch(`https://${store}/admin/api/${API_VERSION}/themes/${theme}/assets.json`, { headers: sh });
      const d = await r.json();
      let keys = (d.assets || []).map(a => a.key);
      if (grep) keys = keys.filter(k => k.toLowerCase().includes(grep));
      return new Response(JSON.stringify({ total: keys.length, keys }, null, 2), { headers: H });
    }
    if (key) {
      const r = await fetch(`https://${store}/admin/api/${API_VERSION}/themes/${theme}/assets.json?asset[key]=${encodeURIComponent(key)}`, { headers: sh });
      if (!r.ok) return new Response(JSON.stringify({ erro: `Shopify ${r.status}`, detalhe: (await r.text()).slice(0, 200) }), { status: 502, headers: H });
      const d = await r.json();
      return new Response(JSON.stringify({ key, value: (d.asset && d.asset.value) || null }, null, 2), { headers: H });
    }
    return new Response(JSON.stringify({ erro: 'use ?theme=, &list=1 ou &key=' }), { status: 400, headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
