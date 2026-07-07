/**
 * Cloudflare Pages Function: /api/shopify-fulfill
 * Marca um pedido como processado (cumprido / fulfilled) na Shopify.
 *
 * Body (POST JSON): { "orderId": 123456789 }
 *
 * Usa a Fulfillment Orders API (2024-04):
 *   1. GET  /orders/{id}/fulfillment_orders.json  → obtém os fulfillment orders abertos
 *   2. POST /fulfillments.json                     → cria o cumprimento (sem notificar o cliente)
 *
 * O token Admin precisa do escopo de escrita:
 *   write_merchant_managed_fulfillment_orders (e/ou write_fulfillments)
 */

const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ erro: 'Método não permitido' }), { status: 405, headers });
  }

  const store = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) {
    return new Response(JSON.stringify({ erro: 'Variáveis de ambiente não configuradas' }), { status: 500, headers });
  }

  let orderId;
  try {
    const body = await request.json();
    orderId = body.orderId;
  } catch (_) {
    return new Response(JSON.stringify({ erro: 'Body JSON inválido' }), { status: 400, headers });
  }
  if (!orderId) {
    return new Response(JSON.stringify({ erro: 'orderId ausente' }), { status: 400, headers });
  }

  const shopHeaders = {
    'X-Shopify-Access-Token': token,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Obtém os fulfillment orders deste pedido
    const foRes = await fetch(
      `https://${store}/admin/api/${API_VERSION}/orders/${orderId}/fulfillment_orders.json`,
      { headers: shopHeaders }
    );
    if (!foRes.ok) {
      const txt = await foRes.text();
      return new Response(JSON.stringify({ erro: `Erro ao buscar fulfillment orders (${foRes.status})`, detalhe: txt }), { status: 502, headers });
    }
    const foData = await foRes.json();
    const fulfillmentOrders = foData.fulfillment_orders || [];

    // Considera apenas os que ainda podem ser cumpridos
    const abertos = fulfillmentOrders.filter(fo => ['open', 'in_progress', 'scheduled'].includes(fo.status));
    if (abertos.length === 0) {
      return new Response(JSON.stringify({ erro: 'Pedido não tem itens pendentes de processamento (já cumprido?)' }), { status: 409, headers });
    }

    // 2. Cria o cumprimento para todos os fulfillment orders abertos, sem notificar o cliente
    const payload = {
      fulfillment: {
        line_items_by_fulfillment_order: abertos.map(fo => ({ fulfillment_order_id: fo.id })),
        notify_customer: false,
      },
    };

    const fRes = await fetch(
      `https://${store}/admin/api/${API_VERSION}/fulfillments.json`,
      { method: 'POST', headers: shopHeaders, body: JSON.stringify(payload) }
    );
    const fText = await fRes.text();
    if (!fRes.ok) {
      return new Response(JSON.stringify({ erro: `Erro ao criar cumprimento (${fRes.status})`, detalhe: fText }), { status: 502, headers });
    }

    const fData = JSON.parse(fText);
    return new Response(JSON.stringify({ ok: true, fulfillment: fData.fulfillment || null }), { headers });

  } catch (err) {
    return new Response(JSON.stringify({ erro: err.message }), { status: 500, headers });
  }
}
