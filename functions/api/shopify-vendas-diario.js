/**
 * Cloudflare Pages Function: /api/shopify-vendas-diario?mes=YYYY-MM (somente leitura)
 * Quebra os pedidos PAGOS por DIA (horário de Brasília) — pra ver tendência/queda recente.
 * Retorna por dia: nº de pedidos, peças e R$ (current_total_price, já líquido de reembolso).
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { env, request } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  const mes = (request && new URL(request.url).searchParams.get('mes')) || '2026-06';
  const [ano, m] = mes.split('-').map(Number);
  const pad = x => String(x).padStart(2, '0');
  const mkBRT = (y, mo) => { while (mo < 1) { mo += 12; y--; } while (mo > 12) { mo -= 12; y++; } return new Date(`${y}-${pad(mo)}-01T00:00:00-03:00`); };
  const iniMes = mkBRT(ano, m), fimMes = mkBRT(ano, m + 1);
  const iso = d => d.toISOString();
  const num = v => parseFloat(v || '0') || 0;
  // Dia no fuso de Brasília
  const diaBRT = s => new Date(new Date(s).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const PAGOS = new Set(['paid', 'partially_refunded']);

  const base = `https://${store}/admin/api/${API_VERSION}/orders.json`;
  const fetchAll = async (query) => {
    const acc = []; let url = `${base}?${query}`;
    while (url) {
      const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (!res.ok) throw new Error(`Shopify ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      acc.push(...(data.orders || []));
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
    return acc;
  };

  try {
    const fields = 'id,created_at,financial_status,current_total_price,line_items,payment_gateway_names,discount_codes,total_discounts,total_shipping_price_set,subtotal_price';
    const orders = await fetchAll(`status=any&created_at_min=${encodeURIComponent(iso(iniMes))}&created_at_max=${encodeURIComponent(iso(fimMes))}&limit=250&fields=${fields}`);
    // Normaliza nome do gateway pra um rótulo curto
    const rotuloGw = (names) => {
      const g = (names && names.length ? names.join('+') : 'sem_gateway').toLowerCase();
      if (g.includes('pagar')) return 'cartao_pagarme';
      if (g.includes('mercado') || g.includes('pix')) return 'pix_mercadopago';
      if (g.includes('manual')) return 'manual';
      return g;
    };
    const dias = {};
    for (const o of orders) {
      const dAll = diaBRT(o.created_at);
      if (!dias[dAll]) dias[dAll] = { dia: dAll, pedidos: 0, pecas: 0, reais: 0, gateways: {}, cupons: {}, com_cupom: 0, desconto: 0, todos_status: {}, criados_total: 0 };
      dias[dAll].criados_total++;
      const st = o.financial_status || 'null';
      dias[dAll].todos_status[st] = (dias[dAll].todos_status[st] || 0) + 1;
      if (!PAGOS.has(o.financial_status)) continue;
      const d = diaBRT(o.created_at);
      dias[d].pedidos++;
      dias[d].pecas += (o.line_items || []).reduce((s, li) => s + (li.quantity || 0), 0);
      dias[d].reais += num(o.current_total_price);
      const gw = rotuloGw(o.payment_gateway_names);
      dias[d].gateways[gw] = (dias[d].gateways[gw] || 0) + 1;
      dias[d].desconto += num(o.total_discounts);
      const f = (o.total_shipping_price_set && o.total_shipping_price_set.shop_money) ? num(o.total_shipping_price_set.shop_money.amount) : 0;
      dias[d].frete = (dias[d].frete || 0) + f;
      dias[d].subtotal = (dias[d].subtotal || 0) + num(o.subtotal_price);
      const codes = (o.discount_codes || []).map(c => (c.code || '').toUpperCase()).filter(Boolean);
      if (codes.length) dias[d].com_cupom++;
      for (const c of codes) dias[d].cupons[c] = (dias[d].cupons[c] || 0) + 1;
    }
    const lista = Object.values(dias).sort((a, b) => a.dia.localeCompare(b.dia))
      .map(x => ({ ...x, reais: +x.reais.toFixed(2) }));
    return new Response(JSON.stringify({ mes, dias: lista }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
