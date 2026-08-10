/**
 * Cloudflare Pages Function: /api/shopify-status-pedidos (somente leitura)
 *
 * Diz o que aconteceu com pedidos que sumiram da lista de "não enviados".
 *   ?ids=123,456,789   (máx. 50 por chamada)
 *
 * POR QUE ISTO EXISTE: a baixa automática de estoque é disparada quando um pedido
 * some do filtro `fulfillment_status=unfulfilled`. Só que ele some por DOIS motivos:
 * foi enviado (aí a peça saiu de verdade e o estoque tem que cair) ou foi cancelado
 * (a peça continua na arara — dar baixa aqui subtrai estoque que existe). Sem esta
 * checagem a baixa automática erraria em todo pedido cancelado.
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });

  const bruto = (new URL(request.url).searchParams.get('ids') || '').trim();
  if (!bruto) return new Response(JSON.stringify({ erro: 'informe ?ids=' }), { status: 400, headers: H });

  const ids = bruto.split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)).slice(0, 50);
  if (!ids.length) return new Response(JSON.stringify({ erro: 'nenhum id válido' }), { status: 400, headers: H });

  try {
    // status=any para enxergar também os cancelados (que somem das buscas normais)
    const url = `https://${store}/admin/api/${API_VERSION}/orders.json`
      + `?ids=${ids.join(',')}&status=any&limit=250`
      + `&fields=id,name,fulfillment_status,cancelled_at,financial_status`;
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (!res.ok) {
      return new Response(JSON.stringify({ erro: `Shopify ${res.status}` }), { status: 502, headers: H });
    }
    const data = await res.json();

    const pedidos = (data.orders || []).map(o => ({
      id:       String(o.id),
      numero:   o.name,
      enviado:  !o.cancelled_at && (o.fulfillment_status === 'fulfilled' || o.fulfillment_status === 'partial'),
      cancelado: !!o.cancelled_at,
      fulfillment_status: o.fulfillment_status || null,
      financial_status:   o.financial_status || null,
    }));

    // Pedido que a Shopify não devolveu (apagado, fora do escopo do token): fica de fora
    // da baixa de propósito — na dúvida, NÃO mexer no estoque.
    const achados = new Set(pedidos.map(p => p.id));
    const nao_encontrados = ids.filter(i => !achados.has(i));

    return new Response(JSON.stringify({ pedidos, nao_encontrados }), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e && e.message || e) }), { status: 500, headers: H });
  }
}
