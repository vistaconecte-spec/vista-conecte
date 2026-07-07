/**
 * Cloudflare Pages Function: /api/shopify-menu
 * GET (sem params)      -> lista os menus (id, handle, title)
 * GET ?handle=main-menu -> devolve a árvore de itens de 1 menu
 * POST { handle, items, confirmar } -> substitui a árvore de itens do menu (menuUpdate)
 *   items = array de { title, type, url|resourceId, items? } (recursivo)
 *   sem confirmar:true = dry-run (não grava)
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  const gql = async (query, variables) => {
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json();
    if (j.errors) throw new Error('GraphQL: ' + JSON.stringify(j.errors));
    return j.data;
  };

  const ITEM_FIELDS = `
    id title type url tags
    resourceId
    items {
      id title type url tags
      resourceId
      items {
        id title type url tags
        resourceId
      }
    }
  `;

  try {
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const handle = url.searchParams.get('handle');
      if (!handle) {
        const d = await gql(`{ menus(first: 20) { edges { node { id handle title } } } }`);
        return new Response(JSON.stringify({ menus: d.menus.edges.map(e => e.node) }, null, 2), { headers });
      }
      const d = await gql(`
        query {
          menus(first: 20) { edges { node { id handle title items { ${ITEM_FIELDS} } } } }
        }`, {});
      const menu = d.menus.edges.map(e => e.node).find(m => m.handle === handle);
      if (!menu) return new Response(JSON.stringify({ erro: `menu "${handle}" não encontrado` }), { status: 404, headers });
      return new Response(JSON.stringify(menu, null, 2), { headers });
    }

    // POST = gravar
    const b = await request.json();
    if (!b.handle || !Array.isArray(b.items)) return new Response(JSON.stringify({ erro: 'informe handle e items' }), { status: 400, headers });

    const d0 = await gql(`{ menus(first: 20) { edges { node { id handle title } } } }`);
    const menu = d0.menus.edges.map(e => e.node).find(m => m.handle === b.handle);
    if (!menu) return new Response(JSON.stringify({ erro: `menu "${b.handle}" não encontrado` }), { status: 404, headers });

    if (b.confirmar !== true) {
      return new Response(JSON.stringify({ modo: 'dry-run (nada gravado)', menu_id: menu.id, items_novos: b.items }, null, 2), { headers });
    }

    const mutation = `
      mutation($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
        menuUpdate(id: $id, title: $title, items: $items) {
          menu { id handle }
          userErrors { field message }
        }
      }`;
    const md = await gql(mutation, { id: menu.id, title: b.title || menu.title, items: b.items });
    const errs = md.menuUpdate.userErrors;
    if (errs.length) return new Response(JSON.stringify({ erro: 'falha ao gravar', detalhe: errs }, null, 2), { status: 400, headers });
    return new Response(JSON.stringify({ ok: true, menu: md.menuUpdate.menu }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
