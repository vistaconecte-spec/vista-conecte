/**
 * Cloudflare Pages Function: /api/shopify-publicar-produto
 * Diagnostica e corrige a VISIBILIDADE de um produto na loja.
 * Motivos comuns de "criei por API e não aparece no site":
 *   - status = draft  (rascunho)
 *   - não publicado no canal "Loja Online" (published_at = null)
 *
 * Body (POST JSON): { busca, confirmar }
 *   - busca: trecho do título (ex: "cozy"); case-insensitive
 *   - confirmar: false (padrão) = só diagnostica (dry-run)
 *                true          = põe status=active e publica na Loja Online
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
  const busca = (b.busca || '').trim().toLowerCase();
  if (!busca) return new Response(JSON.stringify({ erro: 'campo "busca" obrigatório (trecho do título)' }), { status: 400, headers });
  const confirmar = b.confirmar === true;

  const sh = (path, opts) => fetch(`https://${store}/admin/api/${API_VERSION}/${path}`,
    { ...opts, headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', ...(opts && opts.headers) } });

  try {
    // 1) Procura o produto em qualquer status (inclui draft), publicado ou não
    const encontrados = [];
    let url = `products.json?status=active,draft,archived&published_status=any&limit=250&fields=id,title,status,published_at,published_scope`;
    while (url) {
      const res = await sh(url);
      if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}`, detalhe: (await res.text()).slice(0, 300) }), { status: 502, headers });
      const data = await res.json();
      for (const p of (data.products || [])) {
        if ((p.title || '').toLowerCase().includes(busca)) encontrados.push(p);
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+products\.json[^>]*)>;\s*rel="next"/);
      url = next ? next[1].split('/admin/api/' + API_VERSION + '/')[1] : null;
    }

    if (encontrados.length === 0) {
      return new Response(JSON.stringify({ ok: false, encontrados: 0, msg: `Nenhum produto com "${b.busca}" no título — talvez não tenha sido criado, ou tenha outro nome.` }, null, 2), { headers });
    }

    const diagnostico = encontrados.map(p => ({
      id: p.id,
      titulo: p.title,
      status: p.status,                                   // active | draft | archived
      loja_online: p.published_at ? 'publicado' : 'NÃO publicado',
      published_at: p.published_at,
      visivel_no_site: p.status === 'active' && !!p.published_at,
      admin_url: `https://${store}/admin/products/${p.id}`,
    }));

    if (!confirmar) {
      return new Response(JSON.stringify({
        ok: true, modo: 'dry-run (nada alterado)', encontrados: encontrados.length,
        diagnostico,
        dica: 'Reenvie com "confirmar":true para pôr active + publicar na Loja Online.',
      }, null, 2), { headers });
    }

    // 2) Corrige: status=active + published=true (publica na Loja Online)
    const resultado = [];
    for (const p of encontrados) {
      const put = await sh(`products/${p.id}.json`, {
        method: 'PUT',
        body: JSON.stringify({ product: { id: p.id, status: 'active', published: true } }),
      });
      const txt = await put.text();
      if (!put.ok) { resultado.push({ id: p.id, titulo: p.title, ok: false, erro: `Shopify ${put.status}`, detalhe: txt.slice(0, 300) }); continue; }
      const np = JSON.parse(txt).product;
      resultado.push({
        id: np.id, titulo: np.title, ok: true,
        status: np.status, loja_online: np.published_at ? 'publicado' : 'NÃO publicado',
        visivel_no_site: np.status === 'active' && !!np.published_at,
        admin_url: `https://${store}/admin/products/${np.id}`,
      });
    }

    return new Response(JSON.stringify({ ok: true, modo: 'aplicado', resultado }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
