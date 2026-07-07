/**
 * Cloudflare Pages Function: /api/shopify-precos
 * Puxa o preço de venda (catálogo) de cada produto da Shopify e mapeia para a chave do modelo.
 * Retorna { precos: { modelKey: preco }, nao_mapeados: [titulos] }.
 */
const API_VERSION = '2024-04';

// Mapa: prefixo do título Shopify → chave do modelo (espelha shopify-orders.js)
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
  'Casaco Bear': 'sherpa-ziper-bolsos',
  'Carneirinho Cropped': 'carneirinho-cropped', 'Casaco Carneirinho Cropped Feminino': 'carneirinho-cropped',
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
const EXACT_TITLE_MAP = {
  'Macacão Manga Longa': 'macacao-manga-longa', 'Calça Peace': 'calca-peace', 'Casaco Carneirinho Cropped Feminino': 'carneirinho-cropped',
  'Casaco Sherpa Vermelho': 'casaco-sherpa-capuz', 'Conjunto Peace': 'conjunto-peace',
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
  if (best) return best.key;
  const words = title.split(' ');
  for (let len = 1; len <= 2; len++) for (let i = 0; i <= words.length - len; i++) {
    const remaining = [...words.slice(0, i), ...words.slice(i + len)].join(' ').toLowerCase();
    for (const [name, key] of Object.entries(PRODUCT_MAP)) if (remaining === name.toLowerCase()) return key;
  }
  return null;
}

export async function onRequest(context) {
  const { env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  try {
    const num = v => parseFloat(v || '0') || 0;
    const precos = {}; const naoMapeados = [];
    let url = `https://${store}/admin/api/${API_VERSION}/products.json?status=active&limit=250&fields=id,title,variants`;
    while (url) {
      const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}`, detalhe: (await res.text()).slice(0, 200) }), { status: 502, headers });
      const data = await res.json();
      for (const p of (data.products || [])) {
        const key = findModelKey(cleanTitle(p.title));
        const preco = Math.max(0, ...(p.variants || []).map(v => num(v.price)));
        if (!key) { if (preco > 0) naoMapeados.push(p.title + ' (R$ ' + preco.toFixed(2) + ')'); continue; }
        if (!precos[key] || preco > precos[key]) precos[key] = +preco.toFixed(2);
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
    return new Response(JSON.stringify({ precos, nao_mapeados: naoMapeados }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
