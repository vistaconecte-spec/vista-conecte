/**
 * Cloudflare Pages Function: /api/shopify-origem-pedidos?dias=1 (somente leitura)
 * De onde veio cada pedido: página de entrada, site de origem e parâmetros UTM.
 * Serve pra saber qual anúncio trouxe a venda, sem depender só da atribuição da Meta.
 */
const API_VERSION = '2024-10';

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const store = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_ADMIN_TOKEN || env.SHOPIFY_PRODUCTS_TOKEN;
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  const url = new URL(request.url);
  const dias = Math.max(1, Math.min(30, parseInt(url.searchParams.get('dias') || '1', 10)));
  const desde = new Date(Date.now() - dias * 86400000).toISOString();

  const campo = (s, chave) => {
    if (!s) return null;
    const m = s.match(new RegExp('[?&]' + chave + '=([^&#]*)'));
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
  };

  try {
    const api = `https://${store}/admin/api/${API_VERSION}/orders.json?status=any&created_at_min=${encodeURIComponent(desde)}&limit=250&fields=id,name,created_at,total_price,financial_status,landing_site,referring_site,source_name,customer_journey_summary,line_items,discount_codes`;
    const res = await fetch(api, { headers: { 'X-Shopify-Access-Token': token } });
    const data = await res.json();
    if (!res.ok) return new Response(JSON.stringify({ erro: 'Shopify', detalhe: data }, null, 2), { status: res.status, headers });

    const pedidos = (data.orders || []).map(o => {
      const ls = o.landing_site || '';
      return {
        pedido: o.name,
        data: o.created_at,
        total: parseFloat(o.total_price),
        status: o.financial_status,
        pecas: (o.line_items || []).reduce((a, i) => a + i.quantity, 0),
        itens: (o.line_items || []).map(i => i.title),
        cupons: (o.discount_codes || []).map(d => d.code),
        origem: o.source_name || null,
        veio_de: o.referring_site || null,
        utm_source: campo(ls, 'utm_source'),
        utm_campaign: campo(ls, 'utm_campaign'),
        utm_content: campo(ls, 'utm_content'),      // costuma trazer o nome do anúncio
        tem_fbclid: /fbclid=/.test(ls),
        pagina_de_entrada: ls ? ls.split('?')[0] : null,
      };
    }).sort((a, b) => a.data.localeCompare(b.data));

    return new Response(JSON.stringify({
      dias, desde, total_pedidos: pedidos.length, pedidos,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e) }), { status: 500, headers });
  }
}
