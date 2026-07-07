/**
 * Cloudflare Pages Function: /api/shopify-update-preco
 * Atualiza o preço de venda de um produto na Shopify.
 *
 * Body (POST JSON):
 *   { "modelKey": "calca-pantalona", "preco": 209, "confirmar": false }
 *   ou
 *   { "titulo": "Calça Pantalona Moletom", "preco": 209, "confirmar": false }
 *
 * SEGURANÇA: por padrão roda em DRY-RUN (confirmar !== true) — apenas LISTA
 * quais produtos/variantes seriam alterados e os preços atual → novo, SEM gravar.
 * Só grava de verdade quando o body traz "confirmar": true.
 *
 * Requer o escopo write_products no token Admin.
 */
const API_VERSION = '2024-04';

// Espelha o mapeamento de shopify-precos.js (título Shopify → chave do modelo)
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
  const { request, env } = context;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ erro: 'Método não permitido' }), { status: 405, headers });

  // Token dedicado de produtos (app custom da Shopify com write_products).
  // Cai de volta no token geral se o dedicado não estiver configurado.
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  let body;
  try { body = await request.json(); } catch (_) { return new Response(JSON.stringify({ erro: 'Body JSON inválido' }), { status: 400, headers }); }
  const { modelKey, titulo, confirmar } = body;
  const id = body.id;
  const preco = parseFloat(body.preco);
  if (!modelKey && !titulo && !id) return new Response(JSON.stringify({ erro: 'Informe modelKey, titulo ou id' }), { status: 400, headers });
  if (!(preco > 0)) return new Response(JSON.stringify({ erro: 'preco inválido (deve ser > 0)' }), { status: 400, headers });
  const precoStr = preco.toFixed(2);

  const shopHeaders = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  try {
    // 1. Localiza os produtos que batem com o alvo
    const alvos = [];
    if (id) {
      // busca direta por id (funciona pra rascunho/ativo/arquivado)
      const res = await fetch(`https://${store}/admin/api/${API_VERSION}/products/${id}.json?fields=id,title,variants`, { headers: { 'X-Shopify-Access-Token': token } });
      if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}`, detalhe: (await res.text()).slice(0, 200) }), { status: 502, headers });
      const data = await res.json();
      if (data.product) alvos.push(data.product);
    } else {
      // varre produtos ativos que batem com modelKey/titulo
      let url = `https://${store}/admin/api/${API_VERSION}/products.json?status=active&limit=250&fields=id,title,variants`;
      while (url) {
        const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
        if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}`, detalhe: (await res.text()).slice(0, 200) }), { status: 502, headers });
        const data = await res.json();
        for (const p of (data.products || [])) {
          const key = findModelKey(cleanTitle(p.title));
          const bate = modelKey ? key === modelKey : cleanTitle(p.title).toLowerCase() === titulo.toLowerCase();
          if (bate) alvos.push(p);
        }
        const link = res.headers.get('Link') || '';
        const next = link.match(/<([^>]+)>;\s*rel="next"/);
        url = next ? next[1] : null;
      }
    }

    if (alvos.length === 0) return new Response(JSON.stringify({ erro: 'Nenhum produto encontrado para o alvo informado', alvo: modelKey || titulo || id }), { status: 404, headers });

    // 2. Monta o plano de alteração (variante a variante)
    const plano = [];
    for (const p of alvos) for (const v of (p.variants || [])) {
      plano.push({ productId: p.id, produto: p.title, variantId: v.id, variante: v.title, de: v.price, para: precoStr, mudou: v.price !== precoStr });
    }

    // 3. DRY-RUN: não grava, só devolve o plano
    if (confirmar !== true) {
      return new Response(JSON.stringify({
        dry_run: true,
        aviso: 'Nenhuma alteração foi gravada. Reenvie com "confirmar": true para aplicar.',
        novo_preco: precoStr,
        produtos: alvos.length,
        variantes: plano.length,
        plano,
      }, null, 2), { headers });
    }

    // 4. APLICA: PUT em cada variante que mudou
    const resultados = [];
    for (const item of plano) {
      if (!item.mudou) { resultados.push({ ...item, status: 'inalterado' }); continue; }
      const vRes = await fetch(`https://${store}/admin/api/${API_VERSION}/variants/${item.variantId}.json`,
        { method: 'PUT', headers: shopHeaders, body: JSON.stringify({ variant: { id: item.variantId, price: precoStr } }) });
      const vText = await vRes.text();
      resultados.push({ ...item, status: vRes.ok ? 'atualizado' : `erro ${vRes.status}`, detalhe: vRes.ok ? undefined : vText.slice(0, 200) });
    }
    const ok = resultados.every(r => r.status === 'atualizado' || r.status === 'inalterado');
    return new Response(JSON.stringify({ ok, novo_preco: precoStr, atualizados: resultados.filter(r => r.status === 'atualizado').length, resultados }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
