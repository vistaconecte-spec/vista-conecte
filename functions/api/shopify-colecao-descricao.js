/**
 * Cloudflare Pages Function: /api/shopify-colecao-descricao
 * Lê/edita a DESCRIÇÃO (texto do topo) de uma coleção. Usa GraphQL (vale p/ smart e custom).
 * POST JSON: { busca, html, confirmar }
 *   - busca: trecho do título da coleção (ex: "combo")
 *   - html : novo descriptionHtml (só usado com confirmar:true)
 *   - confirmar: false (padrão) = só mostra as coleções achadas + descrição atual (dry-run)
 *               true          = grava o html na coleção (exige 1 match único)
 * Requer write_products.
 */
const API_VERSION = '2024-04';

export async function onRequest({ request, env }) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ erro: 'use POST' }), { status: 405, headers });
  const token = env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN;
  const shop = env.SHOPIFY_STORE_DOMAIN;
  if (!token || !shop) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  let b; try { b = await request.json(); } catch (_) { return new Response(JSON.stringify({ erro: 'JSON inválido' }), { status: 400, headers }); }
  const busca = (b.busca || '').trim();
  if (!busca) return new Response(JSON.stringify({ erro: 'campo "busca" obrigatório' }), { status: 400, headers });
  const confirmar = b.confirmar === true;

  const gql = async (query, variables) => {
    const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    return r.json();
  };

  try {
    const q = `query($q:String!){ collections(first:10, query:$q){ edges{ node{ id title handle descriptionHtml updatedAt } } } }`;
    const res = await gql(q, { q: `title:*${busca}*` });
    if (res.errors) return new Response(JSON.stringify({ erro: 'GraphQL', detalhe: res.errors }), { status: 502, headers });
    const nodes = (res.data?.collections?.edges || []).map(e => e.node);

    if (!confirmar) {
      return new Response(JSON.stringify({
        modo: 'dry-run', encontradas: nodes.length,
        colecoes: nodes.map(n => ({ id: n.id, titulo: n.title, handle: n.handle, descricao_atual: n.descriptionHtml || '(vazia)' })),
        dica: 'Reenvie com confirmar:true e o campo html para gravar (exige 1 match único).',
      }, null, 2), { headers });
    }

    if (nodes.length !== 1) {
      return new Response(JSON.stringify({ erro: `Esperava 1 coleção, achei ${nodes.length}. Refine a "busca".`, colecoes: nodes.map(n => n.title) }), { status: 409, headers });
    }
    const temHtml = typeof b.html === 'string' && b.html.trim();
    const temTitulo = typeof b.titulo === 'string' && b.titulo.trim();
    if (!temHtml && !temTitulo) {
      return new Response(JSON.stringify({ erro: 'informe "html" e/ou "titulo" para gravar' }), { status: 400, headers });
    }

    const input = { id: nodes[0].id };
    if (temHtml) input.descriptionHtml = b.html;
    if (temTitulo) input.title = b.titulo;
    const m = `mutation($input: CollectionInput!){ collectionUpdate(input:$input){ collection{ id title handle } userErrors{ field message } } }`;
    const up = await gql(m, { input });
    const ue = up.data?.collectionUpdate?.userErrors || [];
    if (up.errors || ue.length) return new Response(JSON.stringify({ erro: 'Falha ao gravar', detalhe: up.errors || ue }), { status: 502, headers });

    return new Response(JSON.stringify({ ok: true, colecao: up.data.collectionUpdate.collection, msg: 'Descrição da coleção atualizada.' }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
