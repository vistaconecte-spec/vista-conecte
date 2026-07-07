/**
 * Cloudflare Pages Function: /api/meta-config (somente leitura)
 * Lê STATUS, orçamento e otimização das campanhas e conjuntos (adsets) da conta Meta.
 * Pra diagnosticar por que a entrega/gasto caiu (pausas, budget, entrega limitada, otimização errada).
 */
const API_VERSION = 'v23.0';
const CONTA_PADRAO = 'act_968164338120112';

export async function onRequest(context) {
  const { env } = context;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const token = env.META_ACCESS_TOKEN;
  const conta = env.META_AD_ACCOUNT_ID || CONTA_PADRAO;
  if (!token) return new Response(JSON.stringify({ erro: 'META_ACCESS_TOKEN não configurado' }), { status: 500, headers: H });

  const getAll = async (edge, fields) => {
    const out = [];
    let url = `https://graph.facebook.com/${API_VERSION}/${conta}/${edge}?fields=${fields}&limit=200&access_token=${token}`;
    let guard = 0;
    while (url && guard < 10) {
      guard++;
      const r = await fetch(url);
      const d = await r.json();
      if (d.error) return { erro: d.error };
      for (const x of (d.data || [])) out.push(x);
      url = d.paging && d.paging.next ? d.paging.next : null;
    }
    return out;
  };

  try {
    const campaigns = await getAll('campaigns', 'name,status,effective_status,objective,daily_budget,lifetime_budget,bid_strategy');
    if (campaigns.erro) return new Response(JSON.stringify({ erro: 'Meta', detalhe: campaigns.erro }, null, 2), { status: 502, headers: H });
    const adsets = await getAll('adsets', 'name,status,effective_status,daily_budget,lifetime_budget,optimization_goal,bid_strategy,billing_event,campaign{name},targeting{age_min,age_max,genders,geo_locations,custom_audiences,flexible_spec}');
    if (adsets.erro) return new Response(JSON.stringify({ erro: 'Meta adsets', detalhe: adsets.erro }, null, 2), { status: 502, headers: H });

    const money = (v) => v ? '$' + (v / 100).toFixed(0) : '';
    const camps = campaigns.map(c => ({
      nome: c.name, status: c.status, entrega: c.effective_status, objetivo: c.objective,
      orc_diario: money(c.daily_budget), orc_total: money(c.lifetime_budget), lance: c.bid_strategy,
    }));
    const sets = adsets.map(a => {
      const t = a.targeting || {};
      const publicos = (t.custom_audiences || []).map(x => x.name || x.id).join(', ');
      return {
        nome: a.name, campanha: a.campaign && a.campaign.name, status: a.status, entrega: a.effective_status,
        orc_diario: money(a.daily_budget), otimizacao: a.optimization_goal, evento_cobranca: a.billing_event, lance: a.bid_strategy,
        idade: (t.age_min || '') + '-' + (t.age_max || ''), generos: (t.genders || []).join(','),
        publicos_custom: publicos,
      };
    });
    return new Response(JSON.stringify({ campanhas: camps, adsets: sets }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
