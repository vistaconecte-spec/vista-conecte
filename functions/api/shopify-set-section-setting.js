/**
 * Cloudflare Pages Function: /api/shopify-set-section-setting
 * Define uma config de uma SEÇÃO dentro de um template JSON.
 *   ?template=collection&section=main&key=filter_position&value=drawer          → dry-run
 *   ?template=collection&section=main&key=filter_position&value=drawer&apply=1  → grava
 * value: 'true'/'false' viram booleano; números viram int; senão string.
 */
const API_VERSION = '2024-04';

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });
  const qs = new URL(request.url).searchParams;
  const template = qs.get('template'), section = qs.get('section'), key = qs.get('key'), value = qs.get('value'), apply = qs.get('apply') === '1';
  if (!template || !section || !key || value === null) return new Response(JSON.stringify({ erro: 'informe ?template= &section= &key= &value=' }), { status: 400, headers: H });
  const sh = { 'X-Shopify-Access-Token': token };
  const assetKey = `templates/${template}.json`;
  const base = `https://${store}/admin/api/${API_VERSION}/themes/${qs.get('theme')}/assets.json`;

  try {
    const get = await fetch(base + '?asset[key]=' + encodeURIComponent(assetKey), { headers: sh });
    if (!get.ok) return new Response(JSON.stringify({ erro: `Shopify ${get.status}` }), { status: 502, headers: H });
    const data = JSON.parse((await get.json()).asset.value);
    if (!data.sections || !data.sections[section]) return new Response(JSON.stringify({ erro: `seção "${section}" não existe em ${assetKey}` }), { status: 400, headers: H });
    data.sections[section].settings = data.sections[section].settings || {};
    const antes = data.sections[section].settings[key];
    data.sections[section].settings[key] = coerce(value);

    let resultado = 'dry-run (nada escrito)';
    if (apply) {
      const put = await fetch(base, {
        method: 'PUT', headers: { ...sh, 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset: { key: assetKey, value: JSON.stringify(data) } }),
      });
      resultado = put.ok ? 'aplicado' : `falha ${put.status}: ${(await put.text()).slice(0, 200)}`;
    }
    return new Response(JSON.stringify({ template, section, key, antes, depois: coerce(value), modo: apply ? 'APLICAR' : 'dry-run', resultado }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
