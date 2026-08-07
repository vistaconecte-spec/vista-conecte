/**
 * Cloudflare Pages Function: /api/shopify-pendentes (somente leitura)
 * Lista os pedidos PAGOS e NÃO ENVIADOS, com cada item, cor e tamanho.
 * Serve para cruzar com o estoque/produção e descobrir o que está travando cada pedido.
 *
 * ?dias=90  (padrão 120) — janela de criação do pedido
 */
const API_VERSION = '2024-10';

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const store = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_ADMIN_TOKEN || env.SHOPIFY_PRODUCTS_TOKEN;
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  const url = new URL(request.url);
  const dias = Math.max(1, Math.min(365, parseInt(url.searchParams.get('dias') || '120', 10)));
  const desde = new Date(Date.now() - dias * 86400000).toISOString();

  try {
    const pedidos = [];
    let api = `https://${store}/admin/api/${API_VERSION}/orders.json`
      + `?status=open&financial_status=paid&fulfillment_status=unfulfilled`
      + `&created_at_min=${encodeURIComponent(desde)}&limit=250`
      + `&fields=id,name,created_at,total_price,line_items,note,tags`;
    let guard = 0;
    while (api && guard < 10) {
      guard++;
      const res = await fetch(api, { headers: { 'X-Shopify-Access-Token': token } });
      const data = await res.json();
      if (!res.ok) return new Response(JSON.stringify({ erro: 'Shopify', detalhe: data }, null, 2), { status: res.status, headers });
      for (const o of (data.orders || [])) {
        const dias_parado = Math.floor((Date.now() - new Date(o.created_at).getTime()) / 86400000);
        pedidos.push({
          pedido: o.name,
          criado_em: o.created_at,
          dias_parado,
          total: parseFloat(o.total_price),
          itens: (o.line_items || [])
            .filter(i => i.fulfillable_quantity > 0 || i.fulfillment_status !== 'fulfilled')
            .map(i => ({ titulo: i.title, variante: i.variant_title, qtd: i.quantity, sku: i.sku || null })),
        });
      }
      const link = res.headers.get('Link') || '';
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      api = m ? m[1] : null;
    }
    pedidos.sort((a, b) => b.dias_parado - a.dias_parado);

    return new Response(JSON.stringify({
      janela_dias: dias,
      total_pedidos: pedidos.length,
      total_pecas: pedidos.reduce((a, p) => a + p.itens.reduce((x, i) => x + i.qtd, 0), 0),
      valor_parado: +pedidos.reduce((a, p) => a + p.total, 0).toFixed(2),
      pedidos,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e) }), { status: 500, headers });
  }
}
