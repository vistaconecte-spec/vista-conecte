/**
 * Cloudflare Pages Function: /api/shopify-tema-asset
 * Lê/edita arquivos (assets) do tema ativo — pra ajustes em Liquid.
 * GET  ?listar=price            -> lista chaves de assets que casam com o termo
 * GET  ?key=snippets/price.liquid -> devolve o conteúdo do arquivo
 * POST { key, value, confirmar } -> grava (confirmar:true); sem confirmar = dry-run (não grava)
 * Requer write_products (mesmo token dos outros).
 */
const API_VERSION = '2024-04';

export async function onRequest({ request, env }) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  const token = env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN;
  const shop = env.SHOPIFY_STORE_DOMAIN;
  if (!token || !shop) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  const sh = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  try {
    const tRes = await fetch(`https://${shop}/admin/api/${API_VERSION}/themes.json`, { headers: sh });
    const theme = (await tRes.json()).themes.find(t => t.role === 'main');
    if (!theme) return new Response(JSON.stringify({ erro: 'sem tema ativo' }), { status: 404, headers });
    const base = `https://${shop}/admin/api/${API_VERSION}/themes/${theme.id}/assets.json`;

    if (request.method === 'GET') {
      const url = new URL(request.url);
      const listar = url.searchParams.get('listar');
      const key = url.searchParams.get('key');
      if (listar) {
        const all = (await (await fetch(base, { headers: sh })).json()).assets || [];
        const re = new RegExp(listar, 'i');
        return new Response(JSON.stringify({ tema: theme.name, chaves: all.map(a => a.key).filter(k => re.test(k)) }, null, 2), { headers });
      }
      if (key) {
        const r = await fetch(`${base}?asset[key]=${encodeURIComponent(key)}`, { headers: sh });
        if (!r.ok) return new Response(JSON.stringify({ erro: `read ${r.status}` }), { status: 502, headers });
        const v = (await r.json()).asset?.value || '';
        return new Response(JSON.stringify({ key, tamanho: v.length, conteudo: v }, null, 2), { headers });
      }
      return new Response(JSON.stringify({ uso: 'GET ?listar=termo  ou  ?key=caminho/arquivo.liquid' }, null, 2), { headers });
    }

    // POST = gravar
    const b = await request.json();
    if (!b.key || typeof b.value !== 'string') return new Response(JSON.stringify({ erro: 'key e value obrigatórios' }), { status: 400, headers });
    if (b.confirmar !== true) return new Response(JSON.stringify({ modo: 'dry-run (nada gravado)', key: b.key, tamanho_novo: b.value.length, dica: 'reenvie com confirmar:true' }, null, 2), { headers });
    const w = await fetch(base, { method: 'PUT', headers: sh, body: JSON.stringify({ asset: { key: b.key, value: b.value } }) });
    const wd = await w.json();
    if (!w.ok) return new Response(JSON.stringify({ erro: 'falha ao gravar', detalhe: wd }), { status: w.status, headers });
    return new Response(JSON.stringify({ ok: true, key: b.key, msg: 'asset gravado' }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
