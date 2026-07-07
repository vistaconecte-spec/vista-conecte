/**
 * Cloudflare Pages Function: /api/shopify-vendas-item
 * Análise de vendas de um item específico (somente leitura).
 *
 * Query: ?busca=Casaco Bear&dias=90
 *   busca = trecho do título do produto (case-insensitive)
 *   dias  = janela de dias para trás (default 90)
 *
 * Retorna os pedidos que contêm o item, com preço, descontos (linha e pedido),
 * código de desconto/combo, e o total de itens do pedido (p/ identificar combos).
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  const url = new URL(request.url);
  const busca = (url.searchParams.get('busca') || '').toLowerCase().trim();
  const dias = parseInt(url.searchParams.get('dias') || '90', 10);

  const minDate = new Date(Date.now() - dias * 86400000).toISOString();
  const fields = 'id,name,created_at,financial_status,cancelled_at,line_items,total_discounts,discount_codes,subtotal_price,total_price';

  try {
    const matches = [];
    let totQtd = 0, totBruto = 0, totDescontoItem = 0;
    let api = `https://${store}/admin/api/${API_VERSION}/orders.json?status=any&created_at_min=${encodeURIComponent(minDate)}&limit=250&fields=${fields}`;
    while (api) {
      const res = await fetch(api, { headers: { 'X-Shopify-Access-Token': token } });
      if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}`, detalhe: (await res.text()).slice(0, 200) }), { status: 502, headers });
      const data = await res.json();
      for (const o of (data.orders || [])) {
        if (o.cancelled_at) continue;
        const itens = (o.line_items || []);
        const hit = itens.filter(li => (li.title || '').toLowerCase().includes(busca));
        if (hit.length === 0) continue;
        const linhas = hit.map(li => {
          const qtd = li.quantity || 0;
          const preco = parseFloat(li.price || '0') || 0;
          const descItem = (li.discount_allocations || []).reduce((a, d) => a + (parseFloat(d.amount || '0') || 0), 0);
          totQtd += qtd; totBruto += preco * qtd; totDescontoItem += descItem;
          return { titulo: li.title, variante: li.variant_title, qtd, preco_unit: preco, desconto_linha: +descItem.toFixed(2), pago_aprox: +(preco * qtd - descItem).toFixed(2) };
        });
        matches.push({
          pedido: o.name,
          data: o.created_at,
          status: o.financial_status,
          itens_no_pedido: itens.reduce((a, li) => a + (li.quantity || 0), 0),
          total_pedido: parseFloat(o.total_price || '0') || 0,
          desconto_pedido: parseFloat(o.total_discounts || '0') || 0,
          cupons: (o.discount_codes || []).map(d => d.code),
          bear: linhas,
        });
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      api = next ? next[1] : null;
    }
    matches.sort((a, b) => new Date(b.data) - new Date(a.data));
    return new Response(JSON.stringify({
      busca, dias, pedidos_encontrados: matches.length,
      resumo: { unidades: totQtd, bruto: +totBruto.toFixed(2), desconto_item: +totDescontoItem.toFixed(2), liquido_aprox: +(totBruto - totDescontoItem).toFixed(2) },
      pedidos: matches,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
