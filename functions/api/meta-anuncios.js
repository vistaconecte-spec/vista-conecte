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
  const busca = (u.searchParams.get('busca') || '').toLowerCase();
  const campanhaId = u.searchParams.get('campanha');

  const fmt = x => ({
    id: x.id, nome: x.name, status: x.effective_status || x.status,
    criado: (x.created_time || '').slice(0, 16), alterado: (x.updated_time || '').slice(0, 16),
    campanha: x.campaign && x.campaign.name, conjunto: x.adset && x.adset.name,
    criativo: x.creative && x.creative.name, orcamento_diario: x.daily_budget ? Number(x.daily_budget) / 100 : undefined
  });

  async function lista(tipo, fields, base) {
    const out = [];
    let api = `https://graph.facebook.com/${API_VERSION}/${base}/${tipo}?fields=${fields}&limit=200&access_token=${token}`;
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

  // ?campanha=ID é a consulta BARATA: só os filhos de UMA campanha (2 chamadas), sem
  // paginar os ~2000 anúncios da conta inteira — evita o rate limit "too many calls to
  // this ad-account" da conta cheia. Criado 13/10/2026 (achar/ativar campanha de vaga).
  if (campanhaId) {
    const [filhosAdsets, filhosAds] = await Promise.all([
      lista('adsets', 'id,name,status,effective_status,created_time,updated_time,daily_budget', campanhaId),
      lista('ads', 'id,name,status,effective_status,created_time,updated_time,adset{name},creative{name,thumbnail_url,body,title}', campanhaId)
    ]);
    if (filhosAdsets.erro || filhosAds.erro) return J({ erro: filhosAdsets.erro || filhosAds.erro }, 502);
    return J({ campanha: campanhaId, conjuntos: filhosAdsets.map(fmt), anuncios: filhosAds.map(fmt) });
  }

  const [ads, adsets, campanhas] = await Promise.all([
    lista('ads', 'id,name,status,effective_status,created_time,updated_time,adset{name},campaign{name},creative{name,thumbnail_url}', CONTA),
    lista('adsets', 'id,name,status,effective_status,created_time,updated_time,daily_budget,campaign{name}', CONTA),
    lista('campaigns', 'id,name,status,effective_status,created_time,updated_time,daily_budget', CONTA)
  ]);
  if (ads.erro || adsets.erro || campanhas.erro) return J({ erro: ads.erro || adsets.erro || campanhas.erro }, 502);

  const recente = x => (x.created_time || '').slice(0, 10) >= corte || (x.updated_time || '').slice(0, 10) >= corte;
  const resp = {
    corte, totais: { anuncios: ads.length, conjuntos: adsets.length, campanhas: campanhas.length },
    anuncios_recentes: ads.filter(recente).map(fmt).sort((a, b) => b.alterado.localeCompare(a.alterado)),
    conjuntos_recentes: adsets.filter(recente).map(fmt).sort((a, b) => b.alterado.localeCompare(a.alterado)),
    campanhas_recentes: campanhas.filter(recente).map(fmt).sort((a, b) => b.alterado.localeCompare(a.alterado)),
    ativos: ads.filter(a => a.effective_status === 'ACTIVE').map(fmt)
  };
  // ?busca=termo acha em TODAS as campanhas/conjuntos/anúncios (não só os recentes) por nome
  // próprio ou da campanha-mãe — pra achar campanha antiga e parada sem abrir o Gerenciador.
  // Criado 13/10/2026 (campanha de vaga).
  if (busca) {
    resp.campanhas_busca = campanhas.filter(c => (c.name || '').toLowerCase().includes(busca)).map(fmt);
    resp.conjuntos_busca = adsets.filter(x => (x.name || '').toLowerCase().includes(busca)
      || (x.campaign && (x.campaign.name || '').toLowerCase().includes(busca))).map(fmt);
    resp.anuncios_busca = ads.filter(x => (x.name || '').toLowerCase().includes(busca)
      || (x.campaign && (x.campaign.name || '').toLowerCase().includes(busca))).map(fmt);
  }
  return J(resp);
}
