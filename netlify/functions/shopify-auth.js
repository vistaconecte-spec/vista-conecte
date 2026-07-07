exports.handler = async () => {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const shop = '7660e4-dd.myshopify.com';
  const redirectUri = 'https://vistaconecte.netlify.app/.netlify/functions/shopify-callback';
  const scopes = 'read_orders,read_products';

  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${clientId}` +
    `&scope=${scopes}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  return {
    statusCode: 302,
    headers: { Location: authUrl },
    body: '',
  };
};
