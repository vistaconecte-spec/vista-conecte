/**
 * Cloudflare Pages Function: /api/shopify-pedido-lookup (somente leitura)
 * Busca um pedido pelo número (com ou sem #) e devolve cliente, itens, status e rastreio —
 * usado pra pré-visualizar o pedido na aba Atendimento (SAC/Troca) assim que digita o número.
 *   ?numero=8265
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });

  let numero = (new URL(request.url).searchParams.get('numero') || '').trim();
  if (!numero) return new Response(JSON.stringify({ erro: 'informe ?numero=' }), { status: 400, headers: H });
  numero = numero.replace(/^#/, '');
  const sh = { 'X-Shopify-Access-Token': token };

  try {
    const url = `https://${store}/admin/api/${API_VERSION}/orders.json?name=${encodeURIComponent('#' + numero)}&status=any&fields=name,created_at,financial_status,fulfillment_status,shipping_address,line_items,fulfillments,cancelled_at`;
    const res = await fetch(url, { headers: sh });
    if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}` }), { status: 502, headers: H });
    const data = await res.json();
    const o = (data.orders || [])[0];
    if (!o) return new Response(JSON.stringify({ encontrado: false }), { headers: H });

    const cliente = o.shipping_address?.name
      || `${o.shipping_address?.first_name || ''} ${o.shipping_address?.last_name || ''}`.trim()
      || null;
    const itens = (o.line_items || []).map(li => ({ titulo: li.title, variante: li.variant_title, qtd: li.quantity }));
    const rastreios = (o.fulfillments || []).flatMap(f => f.tracking_numbers || []);

    return new Response(JSON.stringify({
      encontrado: true,
      numero: o.name,
      cliente,
      itens,
      status_financeiro: o.financial_status,
      status_envio: o.fulfillment_status || 'unfulfilled',
      cancelado: !!o.cancelled_at,
      rastreio: rastreios[0] || null,
      criado_em: o.created_at,
    }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
