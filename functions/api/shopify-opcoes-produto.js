/**
 * Cloudflare Pages Function: /api/shopify-opcoes-produto (diagnóstico read-only)
 * Mostra as opções de um produto via GraphQL, incluindo o linkedMetafieldValue de cada
 * valor (necessário quando a opção "Cor" é vinculada a metafield/swatch).
 *   ?id=7528785641581
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });

  const id = (new URL(request.url).searchParams.get('id') || '').trim();
  if (!id) return new Response(JSON.stringify({ erro: 'informe ?id=' }), { status: 400, headers: H });

  try {
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($id: ID!) {
          product(id: $id) {
            id title
            options {
              id name position
              linkedMetafield { namespace key }
              optionValues { id name linkedMetafieldValue }
            }
          }
        }`,
        variables: { id: `gid://shopify/Product/${id}` },
      }),
    });
    const j = await r.json();
    return new Response(JSON.stringify(j, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
