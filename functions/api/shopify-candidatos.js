/**
 * Cloudflare Pages Function: /api/shopify-candidatos (somente leitura)
 * Lista produtos ATIVOS agrupados por modelo. Modelos com >=2 produtos ativos
 * estão separados por cor → candidatos a unificar. Usa o mesmo mapa do sistema.
 */
const API_VERSION = '2024-04';

const PRODUCT_MAP = {
  'Macacão Amplo': 'macacao-amplo', 'Macacão Manga Longa': 'macacao-manga-longa',
  'Macaquinho Amplo': 'macaquinho-amplo', 'Macaquinho Ruel': 'macaquinho-ruel',
  'Vestido Frente Única Longo': 'vestido-frente-unica-longo', 'Vestido Frente Única Curto': 'vestido-frente-unica-curto', 'Vestido Amplo': 'vestido-amplo',
  'Conjunto Peace': 'conjunto-peace', 'Conjunto Wide': 'conjunto-wide', 'Conjunto Boho': 'conjunto-boho', 'Conjunto Canelado': 'conjunto-canelado',
  'Conjunto Calça flare com Moletom gola alta': 'conjunto-calca-flare-moletom',
  'Conjunto Calça Pantalona com Moletom Gola Alta': 'conjunto-calca-pantalona-moletom', 'Conjunto Calça Pantalona com Cropped moletom': 'conjunto-calca-pantalona-cropped',
  'Conjunto Moletom gola alta com Saia midi fenda frontal': 'conjunto-moletom-saia-midi', 'Conjunto Pantalona com Blusa Canelada': 'conjunto-pantalona-blusa',
  'Conjunto Regata oversized com Mini saia canelada': 'conjunto-regata-mini-saia', 'Conjunto Camiseta oversized com Mini saia canelada': 'conjunto-camiseta-mini-saia',
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
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });
  try {
    const grupos = {}; const naoMapeados = [];
    let url = `https://${store}/admin/api/${API_VERSION}/products.json?status=active&limit=250&fields=id,title,variants,options`;
    while (url) {
      const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}` }), { status: 502, headers: H });
      const data = await res.json();
      for (const p of (data.products || [])) {
        const key = findModelKey(cleanTitle(p.title));
        const temCorOption = (p.options || []).some(o => /cor|color/i.test(o.name));
        const info = { title: p.title, id: p.id, unificado: temCorOption };
        if (!key) { naoMapeados.push(p.title); continue; }
        (grupos[key] = grupos[key] || []).push(info);
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
    // candidatos = modelos com >=2 produtos ativos e nenhum já unificado
    const candidatos = [], jaUnificados = [], unicos = [];
    for (const [key, arr] of Object.entries(grupos)) {
      const algumUnificado = arr.some(p => p.unificado);
      if (algumUnificado) jaUnificados.push({ modelo: key, produtos: arr.map(p => p.title) });
      else if (arr.length >= 2) candidatos.push({ modelo: key, qtd: arr.length, produtos: arr.map(p => p.title) });
      else unicos.push({ modelo: key, produto: arr[0].title });
    }
    candidatos.sort((a, b) => b.qtd - a.qtd);
    return new Response(JSON.stringify({
      resumo: { candidatos: candidatos.length, ja_unificados: jaUnificados.length, modelos_1_produto: unicos.length, nao_mapeados: naoMapeados.length },
      candidatos, ja_unificados: jaUnificados, nao_mapeados: naoMapeados,
    }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
