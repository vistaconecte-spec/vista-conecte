/**
 * Cloudflare Pages Function: /api/shopify-abandonados (somente leitura)
 * Lista carrinhos abandonados (checkouts não finalizados) recentes.
 * Query: ?dias=2
 * Retorna valor, frete cotado, itens e etapa — pra analisar não-conversão.
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  const url = new URL(request.url);
  const dias = parseInt(url.searchParams.get('dias') || '2', 10);
  const minDate = new Date(Date.now() - dias * 86400000).toISOString();

  try {
    const lista = [];
    let api = `https://${store}/admin/api/${API_VERSION}/checkouts.json?limit=250&created_at_min=${encodeURIComponent(minDate)}`;
    let guard = 0;
    while (api && guard < 10) {
      guard++;
      const res = await fetch(api, { headers: { 'X-Shopify-Access-Token': token } });
      if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}`, detalhe: (await res.text()).slice(0, 300) }), { status: 502, headers });
      const data = await res.json();
      for (const c of (data.checkouts || [])) {
        if (c.completed_at) continue; // só os não finalizados
        const frete = (c.shipping_lines || []).map(s => ({ titulo: s.title, valor: parseFloat(s.price || '0') || 0 }));
        lista.push({
          data: c.created_at,
          email: c.email || c.customer?.email || null,
          subtotal: parseFloat(c.subtotal_price || c.total_line_items_price || '0') || 0,
          bruto: parseFloat(c.total_line_items_price || '0') || 0,
          desconto: parseFloat(c.total_discounts || '0') || 0,
          cupons: (c.discount_codes || []).map(d => d.code),
          total: parseFloat(c.total_price || '0') || 0,
          frete_cotado: frete,
          tem_email: !!(c.email || c.customer?.email),
          itens: (c.line_items || []).map(li => ({ titulo: li.title, qtd: li.quantity, preco: parseFloat(li.price || '0') || 0 })),
          itens_qtd: (c.line_items || []).reduce((a, li) => a + (li.quantity || 0), 0),
        });
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      api = next ? next[1] : null;
    }
    lista.sort((a, b) => new Date(b.data) - new Date(a.data));
    const tot = lista.reduce((a, c) => a + c.subtotal, 0);
    return new Response(JSON.stringify({ dias, abandonados: lista.length, valor_total: +tot.toFixed(2), lista }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
