/**
 * Cloudflare Pages Function: /api/meta-anuncios-links (somente leitura)
 * Lista os anúncios da conta com a URL de DESTINO de cada criativo,
 * pra conferir se algum anúncio está mandando tráfego pra página quebrada.
 * Token: env.META_ACCESS_TOKEN (System User, permissão ads_read).
 * Conta:  env.META_AD_ACCOUNT_ID (fallback p/ a conta da Vista Conecte).
 *
 * Query:
 *   ?status=ativos|todos   (padrão: ativos — só effective_status ACTIVE)
 *   ?busca=texto           (filtra pelo nome do anúncio)
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
  const soAtivos = (url.searchParams.get('status') || 'ativos') !== 'todos';
  const busca = (url.searchParams.get('busca') || '').toLowerCase();

  const creativeFields = [
    'id', 'name', 'object_type', 'url_tags', 'template_url',
    'object_story_spec', 'asset_feed_spec',
  ].join(',');
  const fields = [
    'name', 'effective_status', 'adset{name}', 'campaign{name}',
    `creative{${creativeFields}}`,
  ].join(',');

  // Junta todos os links que aparecem no criativo (imagem, vídeo, carrossel, catálogo).
  const extrairLinks = (creative) => {
    const links = new Set();
    if (!creative) return [];
    const oss = creative.object_story_spec || {};
    const ld = oss.link_data;
    if (ld) {
      if (ld.link) links.add(ld.link);
      for (const filho of (ld.child_attachments || [])) if (filho.link) links.add(filho.link);
      const cta = ld.call_to_action && ld.call_to_action.value;
      if (cta && cta.link) links.add(cta.link);
    }
    const vd = oss.video_data;
    if (vd) {
      const cta = vd.call_to_action && vd.call_to_action.value;
      if (cta && cta.link) links.add(cta.link);
    }
    const td = oss.template_data;
    if (td && td.link) links.add(td.link);
    for (const lu of ((creative.asset_feed_spec || {}).link_urls || [])) {
      if (lu.website_url) links.add(lu.website_url);
    }
    if (creative.template_url) links.add(creative.template_url);
    return [...links];
  };

  try {
    const anuncios = [];
    let api = `https://graph.facebook.com/${API_VERSION}/${conta}/ads?fields=${encodeURIComponent(fields)}&limit=100&access_token=${encodeURIComponent(token)}`;
    let guard = 0;
    while (api && guard < 20) {
      guard++;
      const res = await fetch(api);
      const data = await res.json();
      if (!res.ok || data.error) {
        return new Response(JSON.stringify({ erro: 'Meta API', detalhe: data.error || `HTTP ${res.status}` }, null, 2), { status: 502, headers });
      }
      for (const ad of (data.data || [])) {
        if (soAtivos && ad.effective_status !== 'ACTIVE') continue;
        if (busca && !(ad.name || '').toLowerCase().includes(busca)) continue;
        anuncios.push({
          id: ad.id,
          anuncio: ad.name,
          status: ad.effective_status,
          campanha: (ad.campaign || {}).name || null,
          adset: (ad.adset || {}).name || null,
          tipo_criativo: (ad.creative || {}).object_type || null,
          url_tags: (ad.creative || {}).url_tags || null,
          links: extrairLinks(ad.creative),
        });
      }
      api = (data.paging || {}).next || null;
    }

    const semLink = anuncios.filter(a => a.links.length === 0).map(a => a.anuncio);
    return new Response(JSON.stringify({
      conta,
      filtro: { status: soAtivos ? 'ativos' : 'todos', busca: busca || null },
      total: anuncios.length,
      sem_link_detectado: semLink,
      anuncios,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e) }), { status: 500, headers });
  }
}
