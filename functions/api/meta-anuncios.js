// GET /api/meta-anuncios?dias=7
// Lista anúncios, conjuntos e campanhas da conta com data de criação/alteração e status,
// pra responder "subiu criativo novo?" sem abrir o Gerenciador. Só leitura.
// Criado 2026-09-16 (investigação de zero vendas). Secret: META_ACCESS_TOKEN.
const API_VERSION = 'v23.0';
const CONTA = 'act_968164338120112';
const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

export async function onRequestGet({ request, env }) {
  const token = env.META_ACCESS_TOKEN;
  if (!token) return J({ erro: 'META_ACCESS_TOKEN ausente' }, 500);
  const u = new URL(request.url);
  const dias = Math.max(1, Math.min(60, parseInt(u.searchParams.get('dias') || '7', 10)));
  const corte = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);

  async function lista(tipo, fields) {
    const out = [];
    let api = `https://graph.facebook.com/${API_VERSION}/${CONTA}/${tipo}?fields=${fields}&limit=200&access_token=${token}`;
    let guard = 0;
    while (api && guard++ < 10) {
      const r = await fetch(api);
      const d = await r.json();
      if (d.error) return { erro: d.error.message };
      out.push(...(d.data || []));
      api = d.paging && d.paging.next;
    }
    return out;
  }

  const [ads, adsets, campanhas] = await Promise.all([
    lista('ads', 'id,name,status,effective_status,created_time,updated_time,adset{name},campaign{name},creative{name,thumbnail_url}'),
    lista('adsets', 'id,name,status,effective_status,created_time,updated_time,daily_budget,campaign{name}'),
    lista('campaigns', 'id,name,status,effective_status,created_time,updated_time,daily_budget')
  ]);
  if (ads.erro || adsets.erro || campanhas.erro) return J({ erro: ads.erro || adsets.erro || campanhas.erro }, 502);

  const recente = x => (x.created_time || '').slice(0, 10) >= corte || (x.updated_time || '').slice(0, 10) >= corte;
  const fmt = x => ({
    id: x.id, nome: x.name, status: x.effective_status || x.status,
    criado: (x.created_time || '').slice(0, 16), alterado: (x.updated_time || '').slice(0, 16),
    campanha: x.campaign && x.campaign.name, conjunto: x.adset && x.adset.name,
    criativo: x.creative && x.creative.name, orcamento_diario: x.daily_budget ? Number(x.daily_budget) / 100 : undefined
  });
  return J({
    corte, totais: { anuncios: ads.length, conjuntos: adsets.length, campanhas: campanhas.length },
    anuncios_recentes: ads.filter(recente).map(fmt).sort((a, b) => b.alterado.localeCompare(a.alterado)),
    conjuntos_recentes: adsets.filter(recente).map(fmt).sort((a, b) => b.alterado.localeCompare(a.alterado)),
    campanhas_recentes: campanhas.filter(recente).map(fmt).sort((a, b) => b.alterado.localeCompare(a.alterado)),
    ativos: ads.filter(a => a.effective_status === 'ACTIVE').map(fmt)
  });
}
