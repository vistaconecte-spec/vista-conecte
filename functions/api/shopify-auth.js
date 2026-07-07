/**
 * Cloudflare Pages Function: /api/shopify-auth
 * Redireciona para a tela de autorização Shopify
 */

export async function onRequest(context) {
  const { env } = context;

  const clientId   = env.SHOPIFY_CLIENT_ID || 'df9f6b2f41b2f6f65758fc9c82ae9eba';
  const shop       = env.SHOPIFY_STORE_DOMAIN || '7660e4-dd.myshopify.com';
  const redirectUri = `https://vistaconecte.pages.dev/api/shopify-callback`;
  // read_orders → últimos 60 dias | read_all_orders → TODO o histórico (remove o limite de 60 dias)
  // write_*fulfillment* → marcar pedidos como processados (cumprimento)
  const scopes     = 'read_orders,read_all_orders,read_products,write_products,write_merchant_managed_fulfillment_orders,write_assigned_fulfillment_orders,write_fulfillments';

  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${clientId}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=vistaconecte`;

  return Response.redirect(authUrl, 302);
}
