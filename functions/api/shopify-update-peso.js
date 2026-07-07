/**
 * Cloudflare Pages Function: /api/shopify-update-peso
 * Atualiza o peso (gramas) das variantes dos produtos, por categoria → peso 80% do cubado.
 * Body (POST JSON): { "confirmar": false }  (dry-run por padrão)
 * Requer write_products.
 */
const API_VERSION = '2024-04';

const PRODUCT_MAP = {
  'Macacão Amplo': 'macacao-amplo', 'Macacão Manga Longa': 'macacao-manga-longa',
  'Macaquinho Amplo': 'macaquinho-amplo', 'Macaquinho Ruel': 'macaquinho-ruel',
  'Vestido Frente Única Longo': 'vestido-frente-unica-longo', 'Vestido Frente Única Curto': 'vestido-frente-unica-curto', 'Vestido Amplo': 'vestido-amplo',
  'Conjunto Peace': 'conjunto-peace', 'Conjunto Wide': 'conjunto-wide', 'Conjunto Boho': 'conjunto-boho', 'Conjunto Canelado': 'conjunto-canelado',
  'Conjunto Calça flare com Moletom gola alta': 'conjunto-calca-flare-moletom', 'Conjunto calça flare com moletom gola alta': 'conjunto-calca-flare-moletom', 'Conjunto calça flare com Moletom gola alta': 'conjunto-calca-flare-moletom',
  'Conjunto Calça Pantalona com Moletom Gola Alta': 'conjunto-calca-pantalona-moletom', 'Conjunto Calça Pantalona com Cropped moletom': 'conjunto-calca-pantalona-cropped', 'Conjunto Cropped Moletom': 'conjunto-calca-pantalona-cropped', 'Conjunto Cropped': 'conjunto-calca-pantalona-cropped',
  'Conjunto Moletom gola alta com Saia midi fenda frontal': 'conjunto-moletom-saia-midi', 'Conjunto Pantalona com Blusa Canelada': 'conjunto-pantalona-blusa',
  'Conjunto Regata oversized com Mini saia canelada': 'conjunto-regata-mini-saia', 'Conjunto Camiseta oversized com Mini saia canelada': 'conjunto-camiseta-mini-saia',
  'Conjunto Camiseta Oversized Verde Militar + Mini Saia Canelada Preta': 'conjunto-camiseta-mini-saia', 'Conjunto Oversized Verde Militar + Mini Saia Canelada': 'conjunto-camiseta-mini-saia',
  'Conjunto Canguru Longo': 'conjunto-canguru-longo', 'Canguru Longo': 'conjunto-canguru-longo',
  'Conjunto Saia Midi Fenda Frontal + Oversized': 'conjunto-saia-midi-oversized', 'Conjunto Calça Bolso Frontal Offwhite com Camiseta Oversized': 'conjunto-calca-bolso-camiseta',
  'Conjunto Cozy': 'conjunto-cozy', 'Conjunto Mood': 'conjunto-mood',
  'Calça Moletom Pantalona': 'calca-pantalona', 'Calça Pantalona Moletom': 'calca-pantalona', 'Calça Pantalona': 'calca-pantalona-viscolycra',
  'Calça Flare Canelada': 'calca-flare', 'Calça Peace': 'calca-peace', 'Calça Bolso Frontal': 'calca-bolso-frontal',
  'Casaco Sherpa com Capuz': 'casaco-sherpa-capuz', 'Casaco Sherpa': 'casaco-sherpa', 'Casaco Pele Persa Xadrez': 'casaco-pele-persa',
  'Carneirinho Cropped': 'carneirinho-cropped', 'Casaco Carneirinho Cropped Feminino': 'carneirinho-cropped',
  'Casaco Bear': 'sherpa-ziper-bolsos',
  'Cropped Peace': 'cropped-peace', 'Camiseta Oversized': 'camiseta-oversized',
  'Blusa Canelada punho dedindo': 'blusa-canelada', 'Blusa Canelada punho dedinho': 'blusa-canelada',
  'Regata Oversized': 'regata-oversized', 'Regata Canelada': 'regata-canelada',
  'Cropped com Mini saia Canelada': 'cropped-mini-saia', 'Cropped Moletom': 'cropped-moletom',
  'Flat': 'flat', 'Sandália Gladiadora': 'sandalia-gladiadora', 'Sandalia Gladiadora': 'sandalia-gladiadora', 'Saia Midi': 'saia-midi', 'Mini Saia Canelada': 'mini-saia-canelada',
  'Moletom Gola Alta': 'moletom-gola-alta', 'Moletom Zíper com Bolsos': 'moletom-ziper-bolsos', 'Moletom Ziper com Bolsos': 'moletom-ziper-bolsos', 'Moletom Cozy': 'moletom-ziper-bolsos', 'Moletom Mood': 'moletom-ziper-bolsos',
  'Sherpa Zíper com Bolsos': 'sherpa-ziper-bolsos', 'Sherpa Ziper com Bolsos': 'sherpa-ziper-bolsos',
  'Calça Básica Moletom': 'calca-basica-moletom', 'Calca Basica Moletom': 'calca-basica-moletom',
  'Cropped Canelado': 'cropped-canelado', 'Blusa Canelada': 'blusa-canelada-simples',
};

// Peso em gramas = 80% do cubado estimado, por modelo
const PESO_G = {
  'casaco-sherpa': 900, 'casaco-sherpa-capuz': 900, 'casaco-pele-persa': 900, 'sherpa-ziper-bolsos': 900, 'carneirinho-cropped': 600,
  'conjunto-cozy': 900, 'conjunto-mood': 900, 'conjunto-wide': 900, 'conjunto-calca-pantalona-moletom': 900, 'conjunto-calca-pantalona-cropped': 800, 'conjunto-calca-flare-moletom': 800, 'conjunto-canguru-longo': 900, 'conjunto-canelado': 700, 'conjunto-pantalona-blusa': 700, 'conjunto-moletom-saia-midi': 700, 'conjunto-peace': 600, 'conjunto-boho': 600,
  'conjunto-regata-mini-saia': 450, 'conjunto-camiseta-mini-saia': 450, 'cropped-mini-saia': 400, 'conjunto-saia-midi-oversized': 450, 'conjunto-calca-bolso-camiseta': 600,
  'moletom-gola-alta': 500, 'moletom-ziper-bolsos': 500, 'canguru-amplo': 500,
  'calca-pantalona': 400, 'calca-basica-moletom': 400, 'calca-peace': 400, 'calca-bolso-frontal': 400, 'calca-flare': 350, 'calca-pantalona-viscolycra': 350,
  'cropped-moletom': 200, 'cropped-canelado': 200, 'cropped-peace': 200, 'blusa-canelada': 200, 'blusa-canelada-simples': 200, 'blusa-peace': 200, 'camiseta-oversized': 200, 'regata-oversized': 180, 'regata-canelada': 180, 'saia-midi': 250, 'mini-saia-canelada': 200,
  'vestido-frente-unica-longo': 400, 'vestido-frente-unica-curto': 350, 'vestido-amplo': 400, 'macacao-amplo': 450, 'macacao-manga-longa': 450, 'macaquinho-amplo': 350, 'macaquinho-ruel': 300,
  'flat': 700, 'sandalia-gladiadora': 600,
};

function cleanTitle(t) { return (t || '').replace(/\s+preço unitário\s*/i, '').replace(/\s+unit price\s*/i, '').trim(); }
function findModelKey(title) {
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
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ erro: 'Método não permitido' }), { status: 405, headers });
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  let body = {}; try { body = await request.json(); } catch (_) {}
  const confirmar = body.confirmar === true;
  const shopHeaders = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  try {
    const plano = []; const naoMapeados = [];
    let url = `https://${store}/admin/api/${API_VERSION}/products.json?status=active&limit=250&fields=id,title,variants`;
    while (url) {
      const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}` }), { status: 502, headers });
      const data = await res.json();
      for (const p of (data.products || [])) {
        const key = findModelKey(cleanTitle(p.title));
        const peso = key ? PESO_G[key] : null;
        if (!peso) { naoMapeados.push(p.title); continue; }
        for (const v of (p.variants || [])) {
          plano.push({ produto: p.title, variantId: v.id, de: v.grams || 0, para: peso, mudou: (v.grams || 0) !== peso });
        }
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    if (!confirmar) {
      const resumo = {};
      for (const it of plano) resumo[it.produto] = it.para;
      return new Response(JSON.stringify({ dry_run: true, produtos: Object.keys(resumo).length, variantes: plano.length, nao_mapeados: naoMapeados.length, nao_mapeados_lista: naoMapeados, pesos_por_produto: resumo }, null, 2), { headers });
    }

    const max = body.max || 40;
    let ok = 0, erro = 0, feitos = 0, restantes = 0;
    for (const it of plano) {
      if (!it.mudou) continue;
      if (feitos >= max) { restantes++; continue; }
      feitos++;
      const r = await fetch(`https://${store}/admin/api/${API_VERSION}/variants/${it.variantId}.json`,
        { method: 'PUT', headers: shopHeaders, body: JSON.stringify({ variant: { id: it.variantId, weight: it.para, weight_unit: 'g' } }) });
      if (r.ok) ok++; else erro++;
    }
    return new Response(JSON.stringify({ ok: erro === 0, variantes_atualizadas: ok, erros: erro, restantes }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
