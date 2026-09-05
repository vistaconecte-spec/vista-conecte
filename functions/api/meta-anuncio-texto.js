/**
 * Cloudflare Pages Function: /api/meta-anuncio-texto (LEITURA + ESCRITA)
 * Troca o texto principal de anúncios que já estão rodando.
 * Token: env.META_ACCESS_TOKEN (System User, precisa de ads_management).
 *
 * POST { ids: ["120..."], texto: "novo texto", titulo?, descricao?, aplicar?: false }
 *
 * Por padrão NÃO grava: devolve o plano (texto de agora, texto novo, caminho que seria
 * usado). Só com aplicar:true a mudança sai. É de propósito — anúncio em veiculação é
 * conteúdo público, e um texto errado publicado custa dinheiro e revisão da Meta.
 *
 * Dois caminhos, nesta ordem:
 *  A) o criativo aponta pra uma publicação da página (object_story_id): edita o texto DO POST.
 *     Mantém curtidas e comentários, e o anúncio não é recriado.
 *  B) senão: monta um criativo novo com o mesmo vídeo/imagem e troca o criativo do anúncio.
 *     O anúncio volta pra análise da Meta.
 */
const API_VERSION = 'v23.0';
const CONTA_PADRAO = 'act_968164338120112';
const G = `https://graph.facebook.com/${API_VERSION}`;

const CRIATIVO_FIELDS = [
  'id', 'name', 'object_type', 'object_story_id', 'effective_object_story_id',
  'object_story_spec', 'asset_feed_spec', 'url_tags', 'body', 'title',
  'degrees_of_freedom_spec',
].join(',');

// Onde o texto principal mora dentro da object_story_spec, conforme o tipo de criativo.
const RAMOS = ['link_data', 'video_data', 'photo_data', 'template_data'];

async function api(url, init) {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok && !d.error, status: r.status, dado: d, erro: d.error || (r.ok ? null : `HTTP ${r.status}`) };
}

function textoAtual(creative) {
  const oss = (creative || {}).object_story_spec || {};
  for (const ramo of RAMOS) {
    const d = oss[ramo];
    if (d && (d.message || d.caption)) return d.message || d.caption;
  }
  return (creative || {}).body || null;
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
  const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];
  const texto = typeof body.texto === 'string' ? body.texto : '';
  const aplicar = body.aplicar === true;
  if (!ids.length) return new Response(JSON.stringify({ erro: 'Informe ids: ["<id do anúncio>"]' }), { status: 400, headers: H });
  if (!texto.trim()) return new Response(JSON.stringify({ erro: 'Informe texto' }), { status: 400, headers: H });
  // Limite do texto principal da Meta com folga: o corte acontece bem antes na tela.
  if (texto.length > 2000) return new Response(JSON.stringify({ erro: 'Texto longo demais (máx 2000)' }), { status: 400, headers: H });

  const resultados = [];
  for (const id of ids) {
    const passo = { id, aplicado: false };
    const lida = await api(`${G}/${id}?fields=name,effective_status,creative{${CRIATIVO_FIELDS}}&access_token=${encodeURIComponent(token)}`);
    if (!lida.ok) { passo.erro = lida.erro; resultados.push(passo); continue; }

    const ad = lida.dado;
    const creative = ad.creative || {};
    passo.anuncio = ad.name;
    passo.status = ad.effective_status;
    passo.texto_atual = textoAtual(creative);
    passo.texto_novo = texto;
    passo.criativo_atual = creative.id || null;

    const post = creative.object_story_id || null;
    passo.caminho = post ? 'editar publicação' : 'criativo novo';
    passo.publicacao = post || creative.effective_object_story_id || null;

    // Variações do Advantage+ ficam fora da object_story_spec.
    const afs = creative.asset_feed_spec || null;
    if (afs && (afs.bodies || []).length) {
      passo.textos_advantage = (afs.bodies || []).map(b => b.text);
      passo.titulos_advantage = (afs.titles || []).map(t => t.text);
      passo.caminho = 'criativo novo (Advantage+)';
    }
    if (body.detalhe === true) passo.criativo_cru = creative;

    if (!aplicar) { resultados.push(passo); continue; }

    if (post) {
      const r = await api(`${G}/${post}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: texto, access_token: token }),
      });
      if (r.ok) { passo.aplicado = true; resultados.push(passo); continue; }
      // Publicação de anúncio (dark post) não aceita edição: cai pro criativo novo.
      passo.aviso_publicacao = r.erro;
      passo.caminho = 'criativo novo';
    }

    const oss = JSON.parse(JSON.stringify(creative.object_story_spec || {}));
    // A Meta DEVOLVE image_url e image_hash juntos na thumbnail, mas recusa receber os dois
    // de volta (ObjectStorySpecRedundant). Fica o hash, que é o que ela resolve internamente.
    for (const ramo of RAMOS) {
      const d = oss[ramo];
      if (d && d.image_hash && d.image_url) delete d.image_url;
    }
    let trocou = false;
    for (const ramo of RAMOS) {
      if (oss[ramo]) {
        if ('caption' in oss[ramo] && !('message' in oss[ramo])) oss[ramo].caption = texto;
        else oss[ramo].message = texto;
        if (typeof body.titulo === 'string' && body.titulo && 'name' in oss[ramo]) oss[ramo].name = body.titulo;
        if (typeof body.descricao === 'string' && body.descricao && 'description' in oss[ramo]) oss[ramo].description = body.descricao;
        trocou = true;
      }
    }
    // Com asset_feed_spec, é ELE que manda no que aparece — trocar só a object_story_spec
    // deixaria as variações antigas rodando. Um texto só substitui as seis variações.
    let afsNovo = null;
    if (afs && (afs.bodies || []).length) {
      afsNovo = JSON.parse(JSON.stringify(afs));
      afsNovo.bodies = [{ text: texto }];
      if (typeof body.titulo === 'string' && body.titulo && (afsNovo.titles || []).length) {
        afsNovo.titles = [{ text: body.titulo }];
      }
      if (typeof body.descricao === 'string' && body.descricao && (afsNovo.descriptions || []).length) {
        afsNovo.descriptions = [{ text: body.descricao }];
      }
      trocou = true;
    }

    if (!trocou || !oss.page_id) {
      passo.erro = 'Criativo sem object_story_spec utilizável — este precisa ser editado no Gerenciador.';
      resultados.push(passo); continue;
    }

    const novo = await api(`${G}/${conta}/adcreatives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${creative.name || ad.name} — texto ${new Date().toISOString().slice(0, 10)}`,
        object_story_spec: oss,
        ...(afsNovo ? { asset_feed_spec: afsNovo } : {}),
        ...(creative.degrees_of_freedom_spec ? { degrees_of_freedom_spec: creative.degrees_of_freedom_spec } : {}),
        ...(creative.url_tags ? { url_tags: creative.url_tags } : {}),
        access_token: token,
      }),
    });
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
