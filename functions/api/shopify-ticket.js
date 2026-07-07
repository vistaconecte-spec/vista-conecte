/**
 * Cloudflare Pages Function: /api/shopify-ticket (somente leitura)
 * Calcula ticket médio (AOV) e distribuição de valor dos pedidos pagos.
 * Usa subtotal_price (valor das peças, antes do frete) — base pra definir frete grátis acima de X.
 *   ?dias=90
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });
  const dias = parseInt(new URL(request.url).searchParams.get('dias') || '90', 10);
  const desde = new Date(Date.now() - dias * 86400000).toISOString();
  const sh = { 'X-Shopify-Access-Token': token };

  try {
    const valores = [];
    let url = `https://${store}/admin/api/${API_VERSION}/orders.json?status=any&financial_status=paid&created_at_min=${encodeURIComponent(desde)}&limit=250&fields=subtotal_price,total_price,created_at`;
    let guard = 0;
    while (url && guard < 40) {
      guard++;
      const res = await fetch(url, { headers: sh });
      if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}` }), { status: 502, headers: H });
      const data = await res.json();
      for (const o of (data.orders || [])) {
        const v = parseFloat(o.subtotal_price || o.total_price || '0') || 0;
        if (v > 0) valores.push(v);
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
    valores.sort((a, b) => a - b);
    const n = valores.length;
    const soma = valores.reduce((s, v) => s + v, 0);
    const media = n ? soma / n : 0;
    const mediana = n ? (n % 2 ? valores[(n - 1) / 2] : (valores[n / 2 - 1] + valores[n / 2]) / 2) : 0;
    // distribuição em faixas
    const faixas = [[0, 150], [150, 200], [200, 250], [250, 300], [300, 400], [400, 600], [600, 1e9]];
    const dist = faixas.map(([a, b]) => {
      const q = valores.filter(v => v >= a && v < b).length;
      return { faixa: b >= 1e9 ? `R$ ${a}+` : `R$ ${a}-${b}`, pedidos: q, pct: n ? Math.round(q / n * 100) : 0 };
    });
    // % de pedidos abaixo de alguns limiares candidatos
    const limiares = [199, 249, 299, 349].map(t => ({ limiar: t, pct_abaixo: n ? Math.round(valores.filter(v => v < t).length / n * 100) : 0 }));
    return new Response(JSON.stringify({
      janela_dias: dias, pedidos: n,
      ticket_medio: +media.toFixed(2), ticket_mediana: +mediana.toFixed(2),
      faturamento_periodo: +soma.toFixed(2),
      distribuicao: dist, pct_abaixo_de: limiares,
    }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
