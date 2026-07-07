/**
 * Cloudflare Pages Function: /api/shopify-canais (somente leitura)
 * Lista os canais de venda (publications) disponíveis na loja — ex: "Online Store",
 * "Facebook & Instagram" — e seus IDs, necessários pra publicar produtos neles via API.
 * Requer read_publications.
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  const query = `{
    publications(first: 20) {
      edges { node { id name supportsFuturePublishing } }
    }
  }`;

  try {
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const j = await r.json();
    if (j.errors) return new Response(JSON.stringify({ erro: 'GraphQL', detalhe: j.errors }), { status: 502, headers });
    const canais = (j.data.publications.edges || []).map(e => ({ id: e.node.id, nome: e.node.name }));
    return new Response(JSON.stringify({ canais }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
