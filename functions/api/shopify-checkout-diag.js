/**
 * Cloudflare Pages Function: /api/shopify-checkout-diag (somente leitura, diagnóstico)
 * Investiga customizações de checkout (Shopify Functions de apps) que podem estar
 * quebrando o checkout: payment customizations, delivery customizations, webhooks ativos.
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });

  const query = `
    query {
      paymentCustomizations(first: 20) {
        edges { node { id title enabled functionId } }
      }
      deliveryCustomizations(first: 20) {
        edges { node { id title enabled functionId } }
      }
      shop {
        name
        checkoutApiSupported
      }
      webhookSubscriptions(first: 50) {
        edges { node { id topic callbackUrl createdAt } }
      }
    }
  `;

  try {
    const res = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    return new Response(JSON.stringify(data, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
