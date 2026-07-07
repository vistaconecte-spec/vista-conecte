/**
 * Cloudflare Pages Function: /api/meta-insights (somente leitura)
 * Lê insights de anúncios da Meta (Marketing API) e cruza com vendas reais.
 * Token: env.META_ACCESS_TOKEN (System User, permissão ads_read).
 * Conta:  env.META_AD_ACCOUNT_ID (fallback p/ a conta da Vista Conecte).
 *
 * Query:
 *   ?desde=YYYY-MM-DD&ate=YYYY-MM-DD  (padrão: últimos 14 dias)
 *   ?nivel=account|campaign           (padrão: campaign)
 *   ?diario=1                         (quebra por dia; padrão: agregado no período)
 */
const API_VERSION = 'v23.0';
const CONTA_PADRAO = 'act_968164338120112';

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const token = env.META_ACCESS_TOKEN;
  const conta = env.META_AD_ACCOUNT_ID || CONTA_PADRAO;
  if (!token) return new Response(JSON.stringify({ erro: 'META_ACCESS_TOKEN não configurado no ambiente (Cloudflare).' }), { status: 500, headers });

  const url = new URL(request.url);
  const hoje = new Date();
  const ymd = d => d.toISOString().slice(0, 10);
  const ate = url.searchParams.get('ate') || ymd(hoje);
  const desde = url.searchParams.get('desde') || ymd(new Date(hoje.getTime() - 14 * 86400000));
  const nivel = url.searchParams.get('nivel') === 'account' ? 'account' : 'campaign';
  const diario = url.searchParams.get('diario') === '1';

  const fields = ['campaign_name', 'spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm', 'reach', 'actions', 'action_values', 'purchase_roas'].join(',');
  const params = new URLSearchParams({
    level: nivel,
    fields,
    time_range: JSON.stringify({ since: desde, until: ate }),
    limit: '200',
    access_token: token,
  });
  if (diario) params.set('time_increment', '1');

  const num = v => parseFloat(v || '0') || 0;
  const acaoCompra = (arr) => {
    if (!Array.isArray(arr)) return 0;
    const a = arr.find(x => x.action_type === 'purchase' || x.action_type === 'omni_purchase' || x.action_type === 'offsite_conversion.fb_pixel_purchase');
    return a ? num(a.value) : 0;
  };

  try {
    const linhas = [];
    let api = `https://graph.facebook.com/${API_VERSION}/${conta}/insights?${params.toString()}`;
    let guard = 0;
    while (api && guard < 15) {
      guard++;
      const res = await fetch(api);
      const data = await res.json();
      if (!res.ok || data.error) {
        return new Response(JSON.stringify({ erro: 'Meta API', detalhe: data.error || (await res.text?.()) || `HTTP ${res.status}` }, null, 2), { status: 502, headers });
      }
      for (const r of (data.data || [])) {
        const compras = acaoCompra(r.actions);
        const valor = acaoCompra(r.action_values);
        const gasto = num(r.spend);
        linhas.push({
          dia: r.date_start || `${desde}..${ate}`,
          campanha: r.campaign_name || '(conta toda)',
          gasto: +gasto.toFixed(2),
          impressoes: parseInt(r.impressions || '0', 10),
          cliques: parseInt(r.clicks || '0', 10),
          ctr: +num(r.ctr).toFixed(2),
          cpc: +num(r.cpc).toFixed(2),
          cpm: +num(r.cpm).toFixed(2),
          compras_meta: compras,
          valor_compras_meta: +valor.toFixed(2),
          roas_meta: gasto > 0 ? +(valor / gasto).toFixed(2) : 0,
        });
      }
      api = (data.paging && data.paging.next) ? data.paging.next : null;
    }

    const tot = linhas.reduce((a, l) => ({
      gasto: a.gasto + l.gasto, impressoes: a.impressoes + l.impressoes, cliques: a.cliques + l.cliques,
      compras: a.compras + l.compras_meta, valor: a.valor + l.valor_compras_meta,
    }), { gasto: 0, impressoes: 0, cliques: 0, compras: 0, valor: 0 });

    return new Response(JSON.stringify({
      conta, periodo: { desde, ate }, nivel, diario,
      total: {
        gasto: +tot.gasto.toFixed(2),
        impressoes: tot.impressoes,
        cliques: tot.cliques,
        ctr_medio: tot.impressoes ? +(100 * tot.cliques / tot.impressoes).toFixed(2) : 0,
        compras_meta: tot.compras,
        valor_compras_meta: +tot.valor.toFixed(2),
        roas_meta: tot.gasto ? +(tot.valor / tot.gasto).toFixed(2) : 0,
      },
      linhas,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
