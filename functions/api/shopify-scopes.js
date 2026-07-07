/**
 * Cloudflare Pages Function: /api/shopify-scopes
 * Diagnóstico: retorna os escopos (permissões) concedidos ao token Admin atual.
 * Não modifica nada na loja. Usado para conferir se há permissão de escrita
 * de cumprimento (write_fulfillments / write_merchant_managed_fulfillment_orders).
 */

const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  const store = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) {
    return new Response(JSON.stringify({ erro: 'Variáveis de ambiente não configuradas' }), { status: 500, headers });
  }

  try {
    const res = await fetch(
      `https://${store}/admin/oauth/access_scopes.json`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    const text = await res.text();
    if (!res.ok) {
      return new Response(JSON.stringify({ erro: `Erro ${res.status}`, detalhe: text }), { status: 502, headers });
    }
    const data = JSON.parse(text);
    const handles = (data.access_scopes || []).map(s => s.handle);
    const podeCumprir =
      handles.includes('write_fulfillments') ||
      handles.includes('write_merchant_managed_fulfillment_orders') ||
      handles.includes('write_assigned_fulfillment_orders');

    return new Response(JSON.stringify({
      escopos: handles,
      pode_cumprir_pedidos: podeCumprir,
    }), { headers });
  } catch (err) {
    return new Response(JSON.stringify({ erro: err.message }), { status: 500, headers });
  }
}
