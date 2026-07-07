/**
 * Cloudflare Pages Function: /api/shopify-oversized
 * Acrescenta uma nota de "modelagem oversized + dica de tamanho" na descrição (body_html)
 * dos produtos casacos na Shopify. Idempotente (não duplica) via marcador HTML.
 *
 * Query:
 *   (padrão)   dry-run: lista o que MUDARIA, sem escrever nada.
 *   ?apply=1   aplica de verdade (PUT em cada produto).
 *
 * Só atua nos modelos do grupo CASACOS. Usa o mesmo mapa título→chave do app.
 */
const API_VERSION = '2024-04';
const MARCADOR = 'nota-oversized-vc'; // marcador de idempotência

// Modelos-alvo (grupo CASACOS do catálogo)
const CASACOS = new Set([
  'casaco-sherpa', 'casaco-sherpa-capuz', 'casaco-pele-persa',
  'carneirinho-cropped', 'sherpa-ziper-bolsos',
]);

// Nota colocada no TOPO da descrição (sem emoji)
const NOTA = `<!-- ${MARCADOR} -->\n<p><strong>Modelagem oversized:</strong> esta peça tem caimento amplo e soltinho.<br>\n<strong>Dica de tamanho:</strong> se você prefere um caimento bem justo ao corpo, escolha um tamanho menor que o seu usual.</p>`;
// Remove qualquer versão anterior da nota (comentário marcador + o parágrafo seguinte)
const RE_NOTA = new RegExp('\\s*<!--\\s*' + MARCADOR + '\\s*-->[\\s\\S]*?<\\/p>', 'g');

// ── Mapa título Shopify → chave do modelo (espelha shopify-precos.js) ──
const PRODUCT_MAP = {
  'Casaco Sherpa com Capuz': 'casaco-sherpa-capuz', 'Casaco Sherpa': 'casaco-sherpa',
  'Casaco Pele Persa Xadrez': 'casaco-pele-persa', 'Casaco Bear': 'sherpa-ziper-bolsos',
  'Carneirinho Cropped': 'carneirinho-cropped', 'Casaco Carneirinho Cropped Feminino': 'carneirinho-cropped',
  'Sherpa Zíper com Bolsos': 'sherpa-ziper-bolsos', 'Sherpa Ziper com Bolsos': 'sherpa-ziper-bolsos',
};
const EXACT_TITLE_MAP = {
  'Casaco Carneirinho Cropped Feminino': 'carneirinho-cropped',
  'Casaco Sherpa Vermelho': 'casaco-sherpa-capuz',
};
function cleanTitle(t) { return (t || '').replace(/\s+preço unitário\s*/i, '').replace(/\s+unit price\s*/i, '').trim(); }
function findModelKey(title) {
  if (EXACT_TITLE_MAP[title]) return EXACT_TITLE_MAP[title];
  const titleL = title.toLowerCase();
  let best = null;
  for (const [name, key] of Object.entries(PRODUCT_MAP)) {
    const nl = name.toLowerCase();
    if (titleL === nl || titleL.startsWith(nl + ' ')) { if (!best || name.length > best.len) best = { key, len: name.length }; }
  }
  return best ? best.key : null;
}

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  const qs = new URL(request.url).searchParams;
  const apply = qs.get('apply') === '1';
  // ?keys=a,b — limita aos modelos informados (interseção com CASACOS). Sem o param = todos os casacos.
  const filtro = (qs.get('keys') || '').split(',').map(s => s.trim()).filter(Boolean);
  const alvoKeys = filtro.length ? new Set(filtro.filter(k => CASACOS.has(k))) : CASACOS;

  try {
    const alvos = [];   // produtos casacos encontrados
    let url = `https://${store}/admin/api/${API_VERSION}/products.json?status=active&limit=250&fields=id,title,body_html`;
    while (url) {
      const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}`, detalhe: (await res.text()).slice(0, 200) }), { status: 502, headers });
      const data = await res.json();
      for (const p of (data.products || [])) {
        const key = findModelKey(cleanTitle(p.title));
        if (key && alvoKeys.has(key)) alvos.push({ id: p.id, title: p.title, key, body_html: p.body_html || '' });
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    const plano = [];
    for (const a of alvos) {
      const limpo = a.body_html.replace(RE_NOTA, '').replace(/^\s+/, '');
      const desejado = NOTA + (limpo ? '\n' + limpo : '');
      const jaOk = a.body_html === desejado;
      let acao = jaOk ? 'já ok (pula)' : (apply ? 'atualizado' : 'atualizaria');
      let status = 'ok';
      if (!jaOk && apply) {
        const put = await fetch(`https://${store}/admin/api/${API_VERSION}/products/${a.id}.json`, {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ product: { id: a.id, body_html: desejado } }),
        });
        status = put.ok ? 'ok' : `falha ${put.status}`;
      }
      plano.push({ produto: a.title, chave: a.key, acao, status });
    }

    return new Response(JSON.stringify({
      modo: apply ? 'APLICAR' : 'dry-run (nada escrito)',
      casacos_encontrados: alvos.length,
      modelos_alvo: [...alvoKeys],
      plano,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
