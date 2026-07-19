/**
 * Cloudflare Pages Function: /api/shopify-pedidos-recentes (somente leitura, diagnóstico)
 * Lista pedidos criados desde ?desde=ISO (ex.: 2026-07-18T00:00:00-03:00), com horário exato,
 * status financeiro e gateway — usado pra diagnosticar quedas súbitas de conversão.
 *   ?desde=2026-07-18T10:00:00-03:00
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });

  const desde = new URL(request.url).searchParams.get('desde');
  if (!desde) return new Response(JSON.stringify({ erro: 'informe ?desde=ISO' }), { status: 400, headers: H });
  const sh = { 'X-Shopify-Access-Token': token };

  try {
    const pedidos = [];
    let url = `https://${store}/admin/api/${API_VERSION}/orders.json?status=any&created_at_min=${encodeURIComponent(desde)}&limit=250&fields=name,created_at,financial_status,cancelled_at,gateway,total_price`;
    while (url) {
      const res = await fetch(url, { headers: sh });
      if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}`, detalhe: (await res.text()).slice(0, 300) }), { status: 502, headers: H });
      const data = await res.json();
      for (const o of (data.orders || [])) {
        pedidos.push({
          numero: o.name,
          criado_em: o.created_at,
          status_financeiro: o.financial_status,
          cancelado: !!o.cancelled_at,
          gateway: o.gateway,
          total: o.total_price,
        });
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
    return new Response(JSON.stringify({ desde, total: pedidos.length, pedidos }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
