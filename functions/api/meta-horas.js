/**
 * Cloudflare Pages Function: /api/meta-horas (somente leitura)
 * Insights por HORA do dia (fuso do anunciante) — pra ver quando converte melhor.
 *   ?dias=30
 */
const API_VERSION = 'v23.0';
const CONTA_PADRAO = 'act_968164338120112';

export async function onRequest(context) {
  const { request, env } = context;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const token = env.META_ACCESS_TOKEN;
  const conta = env.META_AD_ACCOUNT_ID || CONTA_PADRAO;
  if (!token) return new Response(JSON.stringify({ erro: 'META_ACCESS_TOKEN não configurado' }), { status: 500, headers: H });
  const dias = parseInt(new URL(request.url).searchParams.get('dias') || '30', 10);
  const hoje = new Date(); const ymd = d => d.toISOString().slice(0, 10);
  const ate = ymd(hoje), desde = ymd(new Date(hoje.getTime() - dias * 86400000));

  const num = v => parseFloat(v || '0') || 0;
  const compra = (arr) => { if (!Array.isArray(arr)) return 0; const a = arr.find(x => /purchase/.test(x.action_type)); return a ? num(a.value) : 0; };

  try {
    const params = new URLSearchParams({
      level: 'account', fields: 'spend,actions,action_values',
      breakdowns: 'hourly_stats_aggregated_by_advertiser_time_zone',
      time_range: JSON.stringify({ since: desde, until: ate }), limit: '500', access_token: token,
    });
    const horas = {};
    let url = `https://graph.facebook.com/${API_VERSION}/${conta}/insights?${params.toString()}`;
    let guard = 0;
    while (url && guard < 10) {
      guard++;
      const r = await fetch(url); const d = await r.json();
      if (d.error) return new Response(JSON.stringify({ erro: d.error }, null, 2), { status: 502, headers: H });
      for (const row of (d.data || [])) {
        const h = (row.hourly_stats_aggregated_by_advertiser_time_zone || '').slice(0, 5); // "HH:MM"
        horas[h] = horas[h] || { gasto: 0, compras: 0, valor: 0 };
        horas[h].gasto += num(row.spend);
        horas[h].compras += (Array.isArray(row.actions) ? (row.actions.find(x => /purchase/.test(x.action_type)) || {}).value || 0 : 0) * 1;
        horas[h].valor += compra(row.action_values);
      }
      url = d.paging && d.paging.next ? d.paging.next : null;
    }
    const lista = Object.entries(horas).map(([h, v]) => ({
      hora: h, gasto: +v.gasto.toFixed(0), compras: Math.round(v.compras), valor: +v.valor.toFixed(0),
      roas: v.gasto ? +(v.valor / v.gasto).toFixed(2) : 0,
    })).sort((a, b) => a.hora.localeCompare(b.hora));
    return new Response(JSON.stringify({ periodo: { desde, ate }, por_hora: lista }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
