/**
 * Cloudflare Pages Function: /api/shopify-faturamento?mes=YYYY-MM
 * Soma o faturamento de um mês (todas as vendas, inclusive já enviadas) e quebra por
 * meio de pagamento (payment_gateway_names). Usado para a aba Financeira.
 *
 * Observação: a Shopify só devolve pedidos dos últimos ~60 dias sem o escopo read_all_orders.
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { env, request } = context;
  const store = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_ADMIN_TOKEN;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) {
    return new Response(JSON.stringify({ erro: 'Variáveis de ambiente não configuradas' }), { status: 500, headers });
  }

  const mes = (request && new URL(request.url).searchParams.get('mes')) || '2026-05';
  const [ano, m] = mes.split('-').map(Number);
  // Limites do mês no horário de Brasília (-03:00), para casar com o calendário da loja
  const pad = x => String(x).padStart(2, '0');
  const mkBRT = (y, mo) => { while (mo < 1) { mo += 12; y--; } while (mo > 12) { mo -= 12; y++; } return new Date(`${y}-${pad(mo)}-01T00:00:00-03:00`); };
  const iniMes = mkBRT(ano, m);
  const fimMes = mkBRT(ano, m + 1); // primeiro dia do mês seguinte
  // Janela de BUSCA ampliada 1 mês para trás — captura reembolsos feitos no mês-alvo
  // sobre pedidos criados no mês anterior.
  const buscaIni = mkBRT(ano, m - 1);
  const iso = d => d.toISOString();
  const noMes = s => { const t = new Date(s); return t >= iniMes && t < fimMes; };

  const base = `https://${store}/admin/api/${API_VERSION}/orders.json`;
  const fetchAll = async (query) => {
    const acc = [];
    let url = `${base}?${query}`;
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
    const num = v => parseFloat(v || '0') || 0;
    const PAGOS = new Set(['paid', 'partially_refunded']);

    // 1) FATURAMENTO — pedidos CRIADOS no mês
    const fields = 'id,name,created_at,financial_status,payment_gateway_names,total_price,current_total_price,subtotal_price,total_shipping_price_set,total_discounts,total_tax,refunds,line_items';
    const orders = await fetchAll(`status=any&created_at_min=${encodeURIComponent(iso(iniMes))}&created_at_max=${encodeURIComponent(iso(fimMes))}&limit=250&fields=${fields}`);

    // 2) REEMBOLSOS — pedidos MODIFICADOS no mês (pega reembolsos de qualquer pedido, inclusive antigos)
    const ordersRef = await fetchAll(`status=any&updated_at_min=${encodeURIComponent(iso(iniMes))}&updated_at_max=${encodeURIComponent(iso(fimMes))}&limit=250&fields=id,name,created_at,refunds`);
    let reembolsos = 0, nReembolsos = 0, reembProdTodos = 0;
    const refLista = [];
    for (const o of ordersRef) {
      for (const r of (o.refunds || [])) {
        if (!noMes(r.processed_at || r.created_at)) continue;
        let rv = 0;
        for (const t of (r.transactions || [])) {
          if (t.kind === 'refund') { reembolsos += num(t.amount); rv += num(t.amount); nReembolsos++; }
        }
        refLista.push({ pedido: o.name || o.id, data: (r.processed_at || r.created_at || '').slice(0, 10), valor: +rv.toFixed(2) });
        for (const rli of (r.refund_line_items || [])) {
          reembProdTodos += (rli.subtotal_set && rli.subtotal_set.shop_money) ? num(rli.subtotal_set.shop_money.amount) : num(rli.subtotal);
        }
      }
    }

    let brutoTodos = 0, brutoPagos = 0, atualPagos = 0, reembProdutoMes = 0, reembProdNoMes = 0, reembFullNoMes = 0, frete = 0, descontos = 0, taxaImposto = 0, subtotal = 0;
    let nPedidosMes = 0, nPagos = 0, pecasPagas = 0;
    const porGateway = {};
    const porStatus = {};

    for (const o of orders) {
      nPedidosMes++;
      const tp = num(o.total_price);
      brutoTodos += tp;
      porStatus[o.financial_status || 'null'] = (porStatus[o.financial_status || 'null'] || 0) + tp;
      if (PAGOS.has(o.financial_status)) {
        nPagos++;
        brutoPagos += tp;
        pecasPagas += (o.line_items || []).reduce((s, li) => s + (li.quantity || 0), 0);
        atualPagos += num(o.current_total_price);
        for (const r of (o.refunds || [])) {
          const rNoMes = noMes(r.created_at);
          let prod = 0;
          for (const rli of (r.refund_line_items || [])) {
            prod += (rli.subtotal_set && rli.subtotal_set.shop_money) ? num(rli.subtotal_set.shop_money.amount) : num(rli.subtotal);
          }
          let full = 0;
          for (const t of (r.transactions || [])) { if (t.kind === 'refund') full += num(t.amount); }
          reembProdutoMes += prod;                    // produto, qualquer data
          if (rNoMes) { reembProdNoMes += prod; reembFullNoMes += full; }
        }
        subtotal += num(o.subtotal_price);
        descontos += num(o.total_discounts);
        taxaImposto += num(o.total_tax);
        const f = o.total_shipping_price_set && o.total_shipping_price_set.shop_money ? num(o.total_shipping_price_set.shop_money.amount) : 0;
        frete += f;
        const gw = (o.payment_gateway_names && o.payment_gateway_names.length ? o.payment_gateway_names.join('+') : 'sem_gateway');
        porGateway[gw] = porGateway[gw] || { total: 0, n: 0 };
        porGateway[gw].total += tp;
        porGateway[gw].n += 1;
      }
    }

    return new Response(JSON.stringify({
      mes, periodo: { ini: iso(iniMes), fim: iso(fimMes) },
      pedidos_pagos: nPagos,
      pecas_pagas: pecasPagas,
      // Métrica oficial = "Vendas totais" da Shopify (Análises → Vendas totais):
      // soma dos pedidos pagos do mês − reembolsos (valor total) processados no mês sobre esses pedidos.
      vendas_totais: +(brutoPagos - reembFullNoMes).toFixed(2),
      faturamento_bruto_pagos: +brutoPagos.toFixed(2),
      reembolsos_vendas_totais: +reembFullNoMes.toFixed(2),
      subtotal_produtos: +subtotal.toFixed(2),
      frete_cobrado: +frete.toFixed(2),
      descontos: +descontos.toFixed(2),
      imposto: +taxaImposto.toFixed(2),
      reembolsos_no_mes: +reembolsos.toFixed(2), // todos os reembolsos (valor total: produto+frete) processados no mês
      reembolsos_produto_mes: +reembProdTodos.toFixed(2), // só a parte de PRODUTO (devolução) — métrica da Shopify
      qtd_reembolsos: nReembolsos,
      refunds_lista: refLista.sort((a, b) => b.valor - a.valor),
      por_gateway: porGateway,
      por_status: Object.fromEntries(Object.entries(porStatus).map(([k, v]) => [k, +v.toFixed(2)])),
    }, null, 2), { headers });
  } catch (err) {
    return new Response(JSON.stringify({ erro: err.message }), { status: 500, headers });
  }
}
