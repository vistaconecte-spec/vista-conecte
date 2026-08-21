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
 *   ?desde=YYYY-MM-DD      (só anúncios criados a partir dessa data, hora local BRT)
 *   ?ate=YYYY-MM-DD        (só anúncios criados até o fim desse dia, hora local BRT)
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
  // Janela de criação (opcional). Datas são interpretadas no fuso de Brasília (-03:00).
  const desdeStr = url.searchParams.get('desde') || '';
  const ateStr = url.searchParams.get('ate') || '';
  const desdeTs = desdeStr ? Date.parse(`${desdeStr}T00:00:00-03:00`) : null;
  const ateTs = ateStr ? Date.parse(`${ateStr}T23:59:59-03:00`) : null;
  if ((desdeStr && !desdeTs) || (ateStr && !ateTs)) {
    return new Response(JSON.stringify({ erro: 'Datas devem estar no formato YYYY-MM-DD.' }), { status: 400, headers });
  }

  const creativeFields = [
    'id', 'name', 'object_type', 'url_tags', 'template_url',
    'object_story_spec', 'asset_feed_spec',
  ].join(',');
  const fields = [
    'name', 'effective_status', 'created_time', 'updated_time', 'adset{name}', 'campaign{name}',
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
    // Filtrar por data no lado da Meta evita paginar a conta inteira (~2000 anúncios),
    // o que estoura o rate limit da ad-account (código 80004).
    const filtros = [];
    if (desdeTs) filtros.push({ field: 'ad.created_time', operator: 'GREATER_THAN', value: Math.floor(desdeTs / 1000) });
    if (ateTs) filtros.push({ field: 'ad.created_time', operator: 'LESS_THAN', value: Math.floor(ateTs / 1000) });
    const filtering = filtros.length ? `&filtering=${encodeURIComponent(JSON.stringify(filtros))}` : '';
    let api = `https://graph.facebook.com/${API_VERSION}/${conta}/ads?fields=${encodeURIComponent(fields)}&limit=100${filtering}&access_token=${encodeURIComponent(token)}`;
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
        const criadoTs = ad.created_time ? Date.parse(ad.created_time) : null;
        if (desdeTs && !(criadoTs >= desdeTs)) continue;
        if (ateTs && !(criadoTs <= ateTs)) continue;
        anuncios.push({
          id: ad.id,
          anuncio: ad.name,
          status: ad.effective_status,
          criado_em: ad.created_time || null,
          atualizado_em: ad.updated_time || null,
          campanha: (ad.campaign || {}).name || null,
          adset: (ad.adset || {}).name || null,
          tipo_criativo: (ad.creative || {}).object_type || null,
          url_tags: (ad.creative || {}).url_tags || null,
          links: extrairLinks(ad.creative),
        });
      }
      api = (data.paging || {}).next || null;
    }

    // Mais recentes primeiro, pra facilitar "o que entrou nos últimos dias".
    anuncios.sort((a, b) => Date.parse(b.criado_em || 0) - Date.parse(a.criado_em || 0));

    const semLink = anuncios.filter(a => a.links.length === 0).map(a => a.anuncio);
    return new Response(JSON.stringify({
      conta,
      filtro: { status: soAtivos ? 'ativos' : 'todos', busca: busca || null, desde: desdeStr || null, ate: ateStr || null },
      total: anuncios.length,
      sem_link_detectado: semLink,
      anuncios,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e) }), { status: 500, headers });
  }
}
