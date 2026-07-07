/**
 * Cloudflare Pages Function: /api/shopify-colecoes
 * GET  → lista coleções (custom + smart) com id, título, sort_order, tipo.
 * POST { id, tipo, sort_order } → atualiza a ordenação da coleção.
 * Requer write_products (coleções fazem parte do escopo de produtos).
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  const sh = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  try {
    if (request.method === 'POST') {
      const body = await request.json();

      if (body.adicionar && body.colecao_id && Array.isArray(body.titulos)) {
        const alvos = body.titulos.map(t => t.toLowerCase().trim());
        const achados = {};
        let purl = `https://${store}/admin/api/${API_VERSION}/products.json?status=active&limit=250&fields=id,title`;
        while (purl) {
          const pr = await fetch(purl, { headers: { 'X-Shopify-Access-Token': token } });
          if (!pr.ok) return new Response(JSON.stringify({ erro: `Shopify ${pr.status}` }), { status: 502, headers });
          const pd = await pr.json();
          for (const p of (pd.products || [])) if (alvos.includes((p.title || '').toLowerCase().trim())) achados[p.title] = p.id;
          const link = pr.headers.get('Link') || '';
          const next = link.match(/<([^>]+)>;\s*rel="next"/);
          purl = next ? next[1] : null;
        }
        const resultados = [];
        for (const [titulo, pid] of Object.entries(achados)) {
          const cr = await fetch(`https://${store}/admin/api/${API_VERSION}/collects.json`,
            { method: 'POST', headers: sh, body: JSON.stringify({ collect: { product_id: pid, collection_id: body.colecao_id } }) });
          resultados.push({ titulo, status: cr.ok ? 'adicionado' : `erro ${cr.status}` });
        }
        const naoAchados = body.titulos.filter(t => !Object.keys(achados).some(k => k.toLowerCase().trim() === t.toLowerCase().trim()));
        return new Response(JSON.stringify({ ok: true, resultados, nao_encontrados: naoAchados }, null, 2), { headers });
      }

      const { id, tipo, sort_order } = body;
      if (!id || !tipo || !sort_order) return new Response(JSON.stringify({ erro: 'informe id, tipo, sort_order' }), { status: 400, headers });
      const path = tipo === 'smart' ? 'smart_collections' : 'custom_collections';
      const key = tipo === 'smart' ? 'smart_collection' : 'custom_collection';
      const r = await fetch(`https://${store}/admin/api/${API_VERSION}/${path}/${id}.json`,
        { method: 'PUT', headers: sh, body: JSON.stringify({ [key]: { id, sort_order } }) });
      const txt = await r.text();
      if (!r.ok) return new Response(JSON.stringify({ erro: `Shopify ${r.status}`, detalhe: txt.slice(0, 300) }), { status: 502, headers });
      const data = JSON.parse(txt);
      return new Response(JSON.stringify({ ok: true, colecao: data[key]?.title, sort_order: data[key]?.sort_order }), { headers });
    }

    const colId = new URL(request.url).searchParams.get('produtos');
    if (colId) {
      const titulos = [];
      let url = `https://${store}/admin/api/${API_VERSION}/collections/${colId}/products.json?limit=250&fields=id,title`;
      while (url) {
        const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
        if (!r.ok) return new Response(JSON.stringify({ erro: `Shopify ${r.status}`, detalhe: (await r.text()).slice(0, 200) }), { status: 502, headers });
        const data = await r.json();
        for (const p of (data.products || [])) titulos.push(p.title);
        const link = r.headers.get('Link') || '';
        const next = link.match(/<([^>]+)>;\s*rel="next"/);
        url = next ? next[1] : null;
      }
      return new Response(JSON.stringify({ colecao_id: colId, total: titulos.length, produtos: titulos }, null, 2), { headers });
    }

    const out = [];
    for (const [path, tipo] of [['custom_collections', 'custom'], ['smart_collections', 'smart']]) {
      let url = `https://${store}/admin/api/${API_VERSION}/${path}.json?limit=250&fields=id,title,sort_order,products_count,handle`;
      while (url) {
        const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
        if (!r.ok) return new Response(JSON.stringify({ erro: `Shopify ${r.status} em ${path}`, detalhe: (await r.text()).slice(0, 200) }), { status: 502, headers });
        const data = await r.json();
        for (const c of (data[path] || [])) out.push({ id: c.id, tipo, titulo: c.title, sort_order: c.sort_order, produtos: c.products_count, handle: c.handle });
        const link = r.headers.get('Link') || '';
        const next = link.match(/<([^>]+)>;\s*rel="next"/);
        url = next ? next[1] : null;
      }
    }
    return new Response(JSON.stringify({ total: out.length, colecoes: out }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
