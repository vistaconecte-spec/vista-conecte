/**
 * Cloudflare Pages Function: /api/meta-anuncio-link (LEITURA + ESCRITA)
 * Troca a URL de destino de anúncios que já estão rodando.
 * Token: env.META_ACCESS_TOKEN (System User, precisa de ads_management).
 *
 * POST { trocas: [{ id: "120...", link: "https://vistaconecte.com.br/products/..." }],
 *        url_tags?: "utm_source=...", aplicar?: false }
 *
 * Por padrão NÃO grava: devolve o plano (link de agora, link novo). Só com aplicar:true
 * a mudança sai. Criado em 08/10/2026: os 7 anúncios mais novos da conta mostravam
 * moletom, macaquinho e vestido amplo e mandavam todos pro Vestido Frente Única Curto.
 *
 * Link fica dentro do criativo, então não dá pra editar no lugar: monta um criativo novo
 * com o mesmo vídeo, texto e variações do Advantage+ e troca o criativo do anúncio.
 * O anúncio volta pra análise da Meta e perde curtidas e comentários do post antigo.
 * url_tags (UTM) é copiado do criativo antigo; se vier no corpo, substitui.
 */
const API_VERSION = 'v23.0';
const CONTA_PADRAO = 'act_968164338120112';
const G = `https://graph.facebook.com/${API_VERSION}`;
const DOMINIO = 'https://vistaconecte.com.br/';

const CRIATIVO_FIELDS = [
  'id', 'name', 'object_type', 'object_story_id', 'effective_object_story_id',
  'object_story_spec', 'asset_feed_spec', 'url_tags', 'template_url',
  'degrees_of_freedom_spec',
].join(',');

const RAMOS = ['link_data', 'video_data', 'photo_data', 'template_data'];

async function api(url, init) {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok && !d.error, status: r.status, dado: d, erro: d.error || (r.ok ? null : `HTTP ${r.status}`) };
}

// Troca todo link do criativo pelo novo e devolve os que existiam antes.
function trocarLinks(oss, afs, novo) {
  const antes = new Set();
  const ld = oss.link_data;
  if (ld) {
    if (ld.link) { antes.add(ld.link); ld.link = novo; }
    for (const filho of (ld.child_attachments || [])) if (filho.link) { antes.add(filho.link); filho.link = novo; }
    const cta = ld.call_to_action && ld.call_to_action.value;
    if (cta && cta.link) { antes.add(cta.link); cta.link = novo; }
  }
  const vd = oss.video_data;
  if (vd) {
    const cta = vd.call_to_action && vd.call_to_action.value;
    if (cta && cta.link) { antes.add(cta.link); cta.link = novo; }
  }
  const td = oss.template_data;
  if (td && td.link) { antes.add(td.link); td.link = novo; }
  if (afs) {
    for (const lu of (afs.link_urls || [])) {
      if (lu.website_url) { antes.add(lu.website_url); lu.website_url = novo; }
      if (lu.display_url) delete lu.display_url;
    }
  }
  return [...antes];
}

export async function onRequest(context) {
  const { request, env } = context;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (request.method !== 'POST') return new Response(JSON.stringify({ erro: 'Use POST' }), { status: 405, headers: H });

  const token = env.META_ACCESS_TOKEN;
  const conta = env.META_AD_ACCOUNT_ID || CONTA_PADRAO;
  if (!token) return new Response(JSON.stringify({ erro: 'META_ACCESS_TOKEN não configurado' }), { status: 500, headers: H });

  const body = await request.json().catch(() => null);
  if (!body) return new Response(JSON.stringify({ erro: 'Corpo inválido' }), { status: 400, headers: H });
  const trocas = Array.isArray(body.trocas) ? body.trocas.filter(t => t && t.id && t.link) : [];
  const aplicar = body.aplicar === true;
  const urlTags = typeof body.url_tags === 'string' && body.url_tags ? body.url_tags : null;
  if (!trocas.length) return new Response(JSON.stringify({ erro: 'Informe trocas: [{ id, link }]' }), { status: 400, headers: H });
  // Só link da própria loja: um link errado aqui manda verba paga pra fora.
  const fora = trocas.filter(t => !String(t.link).startsWith(DOMINIO));
  if (fora.length) return new Response(JSON.stringify({ erro: `Link precisa começar com ${DOMINIO}`, ids: fora.map(t => t.id) }), { status: 400, headers: H });

  const resultados = [];
  for (const { id, link } of trocas) {
    const passo = { id, aplicado: false, link_novo: link };
    const lida = await api(`${G}/${id}?fields=name,effective_status,creative{${CRIATIVO_FIELDS}}&access_token=${encodeURIComponent(token)}`);
    if (!lida.ok) { passo.erro = lida.erro; resultados.push(passo); continue; }

    const ad = lida.dado;
    const creative = ad.creative || {};
    passo.anuncio = ad.name;
    passo.status = ad.effective_status;
    passo.criativo_atual = creative.id || null;

    const oss = JSON.parse(JSON.stringify(creative.object_story_spec || {}));
    const afs = creative.asset_feed_spec ? JSON.parse(JSON.stringify(creative.asset_feed_spec)) : null;
    passo.links_atuais = trocarLinks(oss, afs, link);
    if (creative.template_url) passo.links_atuais.push(creative.template_url);
    passo.url_tags = urlTags || creative.url_tags || null;

    if (!passo.links_atuais.length || !oss.page_id) {
      passo.erro = 'Não achei o link dentro do criativo. Este precisa ser trocado no Gerenciador.';
      resultados.push(passo); continue;
    }
    if (passo.links_atuais.every(l => l === link)) { passo.aviso = 'Já aponta pra esse link.'; resultados.push(passo); continue; }
    if (!aplicar) { resultados.push(passo); continue; }

    // A Meta devolve image_url e image_hash juntos, mas recusa os dois na volta
    // (ObjectStorySpecRedundant). Fica o hash.
    for (const ramo of RAMOS) {
      const d = oss[ramo];
      if (d && d.image_hash && d.image_url) delete d.image_url;
    }

    const nome = `${creative.name || ad.name} — link ${new Date().toISOString().slice(0, 10)}`;
    const criar = (extra) => api(`${G}/${conta}/adcreatives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: nome,
        object_story_spec: oss,
        ...(passo.url_tags ? { url_tags: passo.url_tags } : {}),
        ...extra,
        access_token: token,
      }),
    });

    let novo = await criar({
      ...(afs ? { asset_feed_spec: afs } : {}),
      ...(creative.degrees_of_freedom_spec ? { degrees_of_freedom_spec: creative.degrees_of_freedom_spec } : {}),
    });
    // Se a Meta recusar as melhorias automáticas do Advantage+ copiadas do criativo antigo,
    // tenta de novo sem elas, mantendo vídeo, textos e link.
    if (!novo.ok && afs && creative.degrees_of_freedom_spec) {
      passo.aviso_advantage = novo.erro;
      novo = await criar({ asset_feed_spec: afs });
    }
    if (!novo.ok) { passo.erro = novo.erro; resultados.push(passo); continue; }
    passo.criativo_novo = novo.dado.id;

    const troca = await api(`${G}/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creative: { creative_id: novo.dado.id }, access_token: token }),
    });
    if (!troca.ok) { passo.erro = troca.erro; resultados.push(passo); continue; }
    passo.aplicado = true;
    resultados.push(passo);
  }

  const aplicados = resultados.filter(r => r.aplicado).length;
  return new Response(JSON.stringify({
    modo: aplicar ? 'aplicado' : 'simulação (nada foi gravado)',
    total: resultados.length, aplicados, resultados,
  }, null, 2), { headers: H });
}
