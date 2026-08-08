/**
 * Cloudflare Pages Function: /api/shopify-colecao-ordem
 * Lê e reordena os produtos de uma coleção de ordenação MANUAL.
 *
 *   GET  ?handle=primavera-verao            -> ordem atual (posição, título, handle, id)
 *   POST { handle, produto_id, posicao, confirmar }
 *        -> move UM produto para a posição informada (1 = primeiro). Os demais deslizam.
 *
 * Dry-run por padrão. Recusa coleção que não esteja em ordenação manual —
 * nesse caso a ordem é calculada pela Shopify e mexer não teria efeito.
 */
const API_VERSION = '2024-04';

export async function onRequest({ request, env }) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  const token = env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN;
  const store = env.SHOPIFY_STORE_DOMAIN;
  if (!token || !store) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  const gql = async (query, variables) => {
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json();
    if (j.errors) throw new Error('GraphQL: ' + JSON.stringify(j.errors));
    return j.data;
  };

  const Q = `
    query($handle: String!) {
      collectionByHandle(handle: $handle) {
        id title handle sortOrder
        products(first: 100) { nodes { id title handle } }
      }
    }`;

  try {
    const url = new URL(request.url);
    const handle = ((request.method === 'POST' ? null : url.searchParams.get('handle')) || '').trim();
    const body = request.method === 'POST' ? await request.json() : {};
    const h = handle || (body.handle || '').trim();
    if (!h) return new Response(JSON.stringify({ erro: 'informe handle' }), { status: 400, headers });

    const d = await gql(Q, { handle: h });
    const col = d.collectionByHandle;
    if (!col) return new Response(JSON.stringify({ erro: `coleção "${h}" não encontrada` }), { status: 404, headers });
    const lista = col.products.nodes.map((p, i) => ({ posicao: i + 1, id: p.id.split('/').pop(), gid: p.id, titulo: p.title, handle: p.handle }));

    if (request.method === 'GET') {
      return new Response(JSON.stringify({ colecao: col.title, handle: col.handle, ordenacao: col.sortOrder, total: lista.length, produtos: lista }, null, 2), { headers });
    }

    if (col.sortOrder !== 'MANUAL') {
      return new Response(JSON.stringify({ erro: `coleção está em ordenação ${col.sortOrder}, não MANUAL — reordenar não teria efeito`, ordenacao: col.sortOrder }), { status: 400, headers });
    }

    const alvoId = String(body.produto_id || '').split('/').pop();
    const posicao = parseInt(body.posicao, 10);
    if (!alvoId || !posicao || posicao < 1) return new Response(JSON.stringify({ erro: 'informe produto_id e posicao (>=1)' }), { status: 400, headers });
    const atual = lista.find(p => p.id === alvoId);
    if (!atual) return new Response(JSON.stringify({ erro: `produto ${alvoId} não está nesta coleção` }), { status: 404, headers });

    const nova = lista.filter(p => p.id !== alvoId);
    nova.splice(posicao - 1, 0, atual);
    const previa = nova.slice(0, Math.max(6, posicao + 2)).map((p, i) => ({ posicao: i + 1, titulo: p.titulo }));

    if (body.confirmar !== true) {
      return new Response(JSON.stringify({
        modo: 'dry-run (nada gravado)', colecao: col.title, ordenacao: col.sortOrder,
        movendo: atual.titulo, de_posicao: atual.posicao, para_posicao: posicao,
        previa_do_inicio: previa, dica: 'reenvie com confirmar:true',
      }, null, 2), { headers });
    }

    const M = `
      mutation($id: ID!, $moves: [MoveInput!]!) {
        collectionReorderProducts(id: $id, moves: $moves) {
          job { id done }
          userErrors { field message }
        }
      }`;
    const md = await gql(M, { id: col.id, moves: [{ id: atual.gid, newPosition: String(posicao - 1) }] });
    const errs = md.collectionReorderProducts.userErrors || [];
    if (errs.length) return new Response(JSON.stringify({ erro: 'falha ao reordenar', detalhe: errs }, null, 2), { status: 400, headers });
    return new Response(JSON.stringify({
      ok: true, movido: atual.titulo, de: atual.posicao, para: posicao,
      job: md.collectionReorderProducts.job,
      nota: 'a Shopify processa a reordenação em segundo plano; pode levar alguns segundos',
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e && e.message || e) }), { status: 500, headers });
  }
}
