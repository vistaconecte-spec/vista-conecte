/**
 * Cloudflare Pages Function: /api/shopify-set-setting
 * Define UMA configuração do tema (settings_data.json → current[key] = value).
 *   ?theme=ID&key=product_color_display&value=swatch          → dry-run
 *   ?theme=ID&key=product_color_display&value=swatch&apply=1  → grava
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });
  const qs = new URL(request.url).searchParams;
  const theme = qs.get('theme'), key = qs.get('key'), value = qs.get('value'), apply = qs.get('apply') === '1';
  if (!theme || !key || value === null) return new Response(JSON.stringify({ erro: 'informe ?theme= &key= &value=' }), { status: 400, headers: H });
  const sh = { 'X-Shopify-Access-Token': token };
  const base = `https://${store}/admin/api/${API_VERSION}/themes/${theme}/assets.json`;

  try {
    const get = await fetch(base + '?asset[key]=config/settings_data.json', { headers: sh });
    if (!get.ok) return new Response(JSON.stringify({ erro: `Shopify ${get.status}` }), { status: 502, headers: H });
    const data = JSON.parse((await get.json()).asset.value);
    if (!data.current || typeof data.current !== 'object') return new Response(JSON.stringify({ erro: 'sem current' }), { status: 500, headers: H });
    const antes = data.current[key];
    data.current[key] = value;

    let resultado = 'dry-run (nada escrito)';
    if (apply) {
      const put = await fetch(base, {
        method: 'PUT', headers: { ...sh, 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset: { key: 'config/settings_data.json', value: JSON.stringify(data) } }),
      });
      resultado = put.ok ? 'aplicado' : `falha ${put.status}: ${(await put.text()).slice(0, 200)}`;
    }
    return new Response(JSON.stringify({ key, antes, depois: value, modo: apply ? 'APLICAR' : 'dry-run', resultado }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
