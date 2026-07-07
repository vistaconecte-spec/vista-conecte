/**
 * Cloudflare Pages Function: /api/painel-diario?dias=14 (somente leitura)
 * Cruza, por dia, os anúncios da Meta com as vendas reais da Shopify.
 * Saída por dia: gasto_meta, cliques, ctr, compras_meta, roas_meta,
 *                pedidos (Shopify pagos), receita (Shopify), roas_real, ticket.
 * roas_real = receita real da Shopify / gasto na Meta  (a verdade, não a do pixel).
 */
const API_VERSION_SHOP = '2024-04';
const API_VERSION_META = 'v23.0';
const CONTA_PADRAO = 'act_968164338120112';

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const store = env.SHOPIFY_STORE_DOMAIN, stoken = env.SHOPIFY_ADMIN_TOKEN;
  const mtoken = env.META_ACCESS_TOKEN, conta = env.META_AD_ACCOUNT_ID || CONTA_PADRAO;
  if (!store || !stoken) return new Response(JSON.stringify({ erro: 'Shopify env não configurado' }), { status: 500, headers });

  const url = new URL(request.url);
  const dias = Math.min(60, Math.max(2, parseInt(url.searchParams.get('dias') || '14', 10)));
  const hoje = new Date();
  const ymd = d => d.toISOString().slice(0, 10);
  const ate = ymd(hoje);
  const desde = ymd(new Date(hoje.getTime() - (dias - 1) * 86400000));
  const num = v => parseFloat(v || '0') || 0;
  // dia no fuso de Brasília (-03:00)
  const diaBRT = s => new Date(new Date(s).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);

  const map = {}; // dia -> métricas
  const D = (d) => (map[d] = map[d] || { dia: d, gasto_meta: 0, cliques: 0, impressoes: 0, compras_meta: 0, valor_meta: 0, pedidos: 0, receita: 0, pecas: 0 });

  try {
    // ---------- 1) SHOPIFY (vendas reais) ----------
    const iniBRT = new Date(`${desde}T00:00:00-03:00`);
    const fimBRT = new Date(new Date(`${ate}T00:00:00-03:00`).getTime() + 86400000);
    const PAGOS = new Set(['paid', 'partially_refunded']);
    const fields = 'id,created_at,financial_status,current_total_price,subtotal_price,line_items';
    let api = `https://${store}/admin/api/${API_VERSION_SHOP}/orders.json?status=any&created_at_min=${encodeURIComponent(iniBRT.toISOString())}&created_at_max=${encodeURIComponent(fimBRT.toISOString())}&limit=250&fields=${fields}`;
    while (api) {
      const res = await fetch(api, { headers: { 'X-Shopify-Access-Token': stoken } });
      if (!res.ok) throw new Error(`Shopify ${res.status}`);
      const data = await res.json();
      for (const o of (data.orders || [])) {
        if (!PAGOS.has(o.financial_status)) continue;
        const d = D(diaBRT(o.created_at));
        d.pedidos++;
        d.receita += num(o.current_total_price);
        d.pecas += (o.line_items || []).reduce((s, li) => s + (li.quantity || 0), 0);
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      api = next ? next[1] : null;
    }

    // ---------- 2) META (anúncios) ----------
    let metaOk = false, metaErro = null;
    if (mtoken) {
      const params = new URLSearchParams({
        level: 'account',
        fields: 'spend,impressions,clicks,actions,action_values',
        time_range: JSON.stringify({ since: desde, until: ate }),
        time_increment: '1', limit: '500', access_token: mtoken,
      });
      const compra = (arr) => {
        if (!Array.isArray(arr)) return 0;
        const a = arr.find(x => ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'].includes(x.action_type));
        return a ? num(a.value) : 0;
      };
      let mapi = `https://graph.facebook.com/${API_VERSION_META}/${conta}/insights?${params}`;
      let guard = 0;
      while (mapi && guard < 20) {
        guard++;
        const res = await fetch(mapi);
        const j = await res.json();
        if (j.error) { metaErro = j.error.message || 'erro Meta'; break; }
        for (const r of (j.data || [])) {
          const d = D(r.date_start);
          d.gasto_meta += num(r.spend);
          d.cliques += parseInt(r.clicks || '0', 10);
          d.impressoes += parseInt(r.impressions || '0', 10);
          d.compras_meta += compra(r.actions);
          d.valor_meta += compra(r.action_values);
        }
        mapi = (j.paging && j.paging.next) ? j.paging.next : null;
        metaOk = true;
      }
    } else { metaErro = 'META_ACCESS_TOKEN não configurado'; }

    // ---------- 3) Monta saída ----------
    const linhas = Object.values(map).sort((a, b) => a.dia.localeCompare(b.dia)).map(d => ({
      dia: d.dia,
      gasto_meta: +d.gasto_meta.toFixed(2),
      cliques: d.cliques,
      ctr: d.impressoes ? +(100 * d.cliques / d.impressoes).toFixed(2) : 0,
      compras_meta: d.compras_meta,
      roas_meta: d.gasto_meta ? +(d.valor_meta / d.gasto_meta).toFixed(2) : 0,
      pedidos: d.pedidos,
      receita: +d.receita.toFixed(2),
      ticket: d.pedidos ? +(d.receita / d.pedidos).toFixed(0) : 0,
      roas_real: d.gasto_meta ? +(d.receita / d.gasto_meta).toFixed(2) : 0,
    }));

    const tot = linhas.reduce((a, l) => ({
      gasto: a.gasto + l.gasto_meta, cliques: a.cliques + l.cliques,
      pedidos: a.pedidos + l.pedidos, receita: a.receita + l.receita,
    }), { gasto: 0, cliques: 0, pedidos: 0, receita: 0 });

    return new Response(JSON.stringify({
      periodo: { desde, ate, dias },
      meta_ok: metaOk, meta_erro: metaErro,
      total: {
        gasto_meta: +tot.gasto.toFixed(2),
        pedidos: tot.pedidos,
        receita: +tot.receita.toFixed(2),
        roas_real: tot.gasto ? +(tot.receita / tot.gasto).toFixed(2) : 0,
      },
      linhas,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
