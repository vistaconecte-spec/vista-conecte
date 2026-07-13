/**
 * Cloudflare Pages Function: /api/shopify-pedido-returns (diagnóstico read-only)
 * Busca as devoluções (Return) de um pedido via GraphQL — pesquisa pra decidir como
 * integrar o sistema nativo de devolução da Shopify com a aba Atendimento.
 *   ?numero=8153
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });

  let numero = (new URL(request.url).searchParams.get('numero') || '').trim().replace(/^#/, '');
  if (!numero) return new Response(JSON.stringify({ erro: 'informe ?numero=' }), { status: 400, headers: H });

  try {
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($q: String!) {
          orders(first: 1, query: $q) {
            nodes {
              name returnStatus
              customer { displayName }
              returns(first: 10) {
                nodes {
                  id name status createdAt requestApprovedAt
                  returnLineItems(first: 20) {
                    nodes {
                      ... on ReturnLineItem {
                        id quantity returnReason returnReasonNote
                        fulfillmentLineItem { lineItem { title variantTitle } }
                      }
                    }
                  }
                  refunds(first: 5) { nodes { id totalRefundedSet { presentmentMoney { amount currencyCode } } } }
                }
              }
            }
          }
        }`,
        variables: { q: `name:#${numero}` },
      }),
    });
    const j = await r.json();
    return new Response(JSON.stringify(j, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
