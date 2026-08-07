/**
 * Cloudflare Pages Function: /api/vc-sentinela (somente leitura)
 * Confere se a campanha CONECTA continua íntegra no tema publicado.
 * Devolve { ok: true/false, falhas: [...] } — feito para ser chamado por rotina.
 *
 * Verifica:
 *   - textos da escada no selo, na barra do topo e na olhada rápida
 *   - barra de progresso do carrinho instalada nos dois carrinhos
 *   - banner CONECTA presente na home
 *   - AUSÊNCIA da comunicação antiga de combo (âncoras de preço que não existem mais)
 */
const API_VERSION = '2024-04';

const DEVE_TER = [
  ['snippets/product-item.liquid', 'Leve 2 e ganhe', 'selo da escada nos cards'],
  ['sections/header-group.json', 'LEVE 2 E GANHE 20% OFF', 'barra de avisos do topo'],
  ['snippets/product-quick-buy.liquid', 'Leve 2 e ganhe 20% OFF', 'promo na olhada rápida'],
  ['snippets/vc-escada-progresso.liquid', 'vc-escada__trilho', 'barra de progresso (snippet)'],
  ['sections/main-cart.liquid', 'vc-escada-progresso', 'barra no carrinho'],
  ['sections/mini-cart.liquid', 'vc-escada-progresso', 'barra no mini-carrinho'],
  ['templates/index.json', 'banner_conecta', 'banner CONECTA na home'],
];

const NAO_PODE_TER = [
  ['templates/index.json', '1.090', 'âncora falsa R$ 1.090 voltou na home'],
  ['templates/index.json', 'combo_duo', 'seção "PROMOÇÃO DE COMBOS" voltou na home'],
  ['templates/index.json', 'por R$ 699', 'preço de combo voltou na home'],
  ['templates/product.json', '1.090', 'âncora falsa R$ 1.090 voltou no produto'],
  ['templates/product.json', 'pecas_frio_pdp', 'grade de combo voltou no produto'],
  ['templates/product.json', 'por R$ 399', 'preço de combo voltou no produto'],
];

export async function onRequest(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const store = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_ADMIN_TOKEN || env.SHOPIFY_PRODUCTS_TOKEN;
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  const sh = { 'X-Shopify-Access-Token': token };

  try {
    const tr = await fetch(`https://${store}/admin/api/${API_VERSION}/themes.json`, { headers: sh });
    const tema = (await tr.json()).themes.find(t => t.role === 'main');
    if (!tema) return new Response(JSON.stringify({ erro: 'tema publicado não encontrado' }), { status: 502, headers });

    const cache = {};
    async function conteudo(key) {
      if (cache[key] !== undefined) return cache[key];
      const r = await fetch(`https://${store}/admin/api/${API_VERSION}/themes/${tema.id}/assets.json?asset[key]=${encodeURIComponent(key)}`, { headers: sh });
      const j = await r.json();
      cache[key] = (j.asset && j.asset.value) || '';
      return cache[key];
    }

    const falhas = [];
    for (const [key, marca, rotulo] of DEVE_TER) {
      const v = await conteudo(key);
      if (!v) falhas.push({ tipo: 'arquivo sumiu', arquivo: key, o_que: rotulo });
      else if (!v.includes(marca)) falhas.push({ tipo: 'foi desfeito', arquivo: key, o_que: rotulo });
    }
    for (const [key, marca, rotulo] of NAO_PODE_TER) {
      const v = await conteudo(key);
      if (v && v.includes(marca)) falhas.push({ tipo: 'comunicação antiga voltou', arquivo: key, o_que: rotulo });
    }

    // horário da última gravação nos arquivos que mais sofrem sobrescrita
    const vigiados = ['templates/index.json', 'templates/product.json'];
    const carimbos = {};
    for (const k of vigiados) {
      const r = await fetch(`https://${store}/admin/api/${API_VERSION}/themes/${tema.id}/assets.json?asset[key]=${encodeURIComponent(k)}`, { headers: sh });
      const j = await r.json();
      carimbos[k] = (j.asset && j.asset.updated_at) || null;
    }

    return new Response(JSON.stringify({
      ok: falhas.length === 0,
      verificado_em: new Date().toISOString(),
      tema: tema.name,
      total_de_falhas: falhas.length,
      falhas,
      ultima_gravacao: carimbos,
      resumo: falhas.length === 0
        ? 'Campanha CONECTA íntegra.'
        : `ATENÇÃO: ${falhas.length} item(ns) fora do lugar — ${falhas.map(f => f.o_que).join('; ')}`,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e) }), { status: 500, headers });
  }
}
