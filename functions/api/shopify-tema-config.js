/**
 * Cloudflare Pages Function: /api/shopify-tema-config (somente leitura)
 * Lê config/settings_data.json do tema ativo e devolve as chaves de settings
 * que casam com a busca (pra achar, ex., o formato do desconto % vs R$).
 * Query: ?busca=save|percent|discount|badge|sale   (regex nas chaves)
 */
const API_VERSION = '2024-04';

export async function onRequest({ request, env }) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const token = env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN;
  const shop = env.SHOPIFY_STORE_DOMAIN;
  if (!token || !shop) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  const sh = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  const busca = new URL(request.url).searchParams.get('busca') || 'save|saving|percent|discount|badge|sale|economi|desconto';
  const re = new RegExp(busca, 'i');

  try {
    const tRes = await fetch(`https://${shop}/admin/api/${API_VERSION}/themes.json`, { headers: sh });
    const { themes } = await tRes.json();
    const theme = themes.find(t => t.role === 'main');
    if (!theme) return new Response(JSON.stringify({ erro: 'sem tema ativo' }), { status: 404, headers });

    const aRes = await fetch(`https://${shop}/admin/api/${API_VERSION}/themes/${theme.id}/assets.json?asset[key]=config/settings_data.json`, { headers: sh });
    if (!aRes.ok) return new Response(JSON.stringify({ erro: `asset ${aRes.status}` }), { status: 502, headers });
    const data = await aRes.json();
    const raw = data.asset?.value || '';
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch (e) {}
    const cur = parsed.current;
    const settings = (cur && typeof cur === 'object' && cur.settings) ? cur.settings : (typeof cur === 'object' ? cur : {});

    const casam = {};
    for (const [k, v] of Object.entries(settings)) {
      if (typeof v === 'object') continue;
      if (re.test(k) || (typeof v === 'string' && re.test(v))) casam[k] = v;
    }
    // Procura também dentro das SEÇÕES (sections), onde o badge pode estar
    const casamSecoes = {};
    const sections = (cur && cur.sections) || parsed.sections || {};
    for (const [secKey, sec] of Object.entries(sections)) {
      const st = (sec && sec.settings) || {};
      for (const [k, v] of Object.entries(st)) {
        if (typeof v === 'object') continue;
        if (re.test(k) || (typeof v === 'string' && re.test(v))) casamSecoes[`${secKey}.${k}`] = v;
      }
    }
    return new Response(JSON.stringify({
      tema: { id: theme.id, name: theme.name },
      raw_len: raw.length,
      current_tipo: typeof cur,
      current_chaves: cur && typeof cur === 'object' ? Object.keys(cur) : null,
      total_settings: Object.keys(settings).length,
      casam_globais: casam,
      casam_secoes: casamSecoes,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
