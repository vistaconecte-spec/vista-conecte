/**
 * Cloudflare Pages Function: /api/vc-sentinela (somente leitura)
 * Confere se a promoção atual (R$ 70 OFF em pedidos com 2 peças ou mais) continua
 * íntegra no tema publicado. A escada CONECTA (20/25/30/35%) foi desligada em 16/09/2026.
 * Devolve { ok: true/false, falhas: [...] } — feito para ser chamado por rotina.
 *
 * Verifica:
 *   - texto do R$ 70 no selo, na barra do topo, na olhada rápida e na barra de progresso
 *   - barra de progresso do carrinho instalada nos dois carrinhos
 *   - banner da promoção presente na home
 *   - AUSÊNCIA da escada antiga e da comunicação antiga de combo
 *     (nos templates JSON, seções desativadas são ignoradas)
 */
const API_VERSION = '2024-04';

const DEVE_TER = [
  ['snippets/product-item.liquid', 'R$ 70 OFF', 'selo "Leve 2 e ganhe R$ 70 OFF" nos cards'],
  ['sections/header-group.json', 'R$ 70 OFF', 'barra de avisos do topo com R$ 70 OFF'],
  ['snippets/product-quick-buy.liquid', 'R$ 70 OFF', 'promo R$ 70 OFF na olhada rápida'],
  ['snippets/vc-escada-progresso.liquid', 'R$ 70', 'barra de progresso com R$ 70 (snippet)'],
  ['snippets/vc-escada-progresso.liquid', 'vc-escada__trilho', 'barra de progresso (snippet)'],
  ['sections/main-cart.liquid', 'vc-escada-progresso', 'barra no carrinho'],
  ['sections/mini-cart.liquid', 'vc-escada-progresso', 'barra no mini-carrinho'],
  ['templates/index.json', 'banner_conecta', 'banner da promoção na home'],
];

const NAO_PODE_TER = [
  ['sections/header-group.json', '20% OFF', 'escada antiga (20% OFF) voltou na barra do topo'],
  ['snippets/product-quick-buy.liquid', '20% OFF', 'escada antiga (20% OFF) voltou na olhada rápida'],
  ['snippets/product-item.liquid', '20% OFF', 'escada antiga (20% OFF) voltou no selo dos cards'],
  ['snippets/vc-escada-progresso.liquid', '35%', 'escada antiga (até 35%) voltou na barra de progresso'],
  ['templates/index.json', '35%', 'banner da escada antiga (até 35%) voltou ativo na home'],
  ['templates/index.json', '1.090', 'âncora falsa R$ 1.090 voltou na home'],
  ['templates/index.json', 'combo_duo', 'seção "PROMOÇÃO DE COMBOS" voltou na home'],
  ['templates/index.json', 'por R$ 699', 'preço de combo voltou na home'],
  ['templates/product.json', '35%', 'escada antiga (até 35%) voltou no produto'],
  ['templates/product.json', '1.090', 'âncora falsa R$ 1.090 voltou no produto'],
  ['templates/product.json', 'pecas_frio_pdp', 'grade de combo voltou no produto'],
  ['templates/product.json', 'por R$ 399', 'preço de combo voltou no produto'],
];

// Nos templates JSON, seção desativada não aparece na loja: tira do texto conferido.
function semDesativadas(key, v) {
  if (!key.endsWith('.json') || !v) return v;
  try {
    const t = JSON.parse(v.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ''));
    if (!t.sections) return v;
    for (const k of Object.keys(t.sections)) {
      if (t.sections[k] && t.sections[k].disabled) delete t.sections[k];
    }
    return JSON.stringify(t);
  } catch (_) { return v; }
}

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
      cache[key] = semDesativadas(key, (j.asset && j.asset.value) || '');
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
        ? 'Promoção R$ 70 íntegra.'
        : `ATENÇÃO: ${falhas.length} item(ns) fora do lugar — ${falhas.map(f => f.o_que).join('; ')}`,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e) }), { status: 500, headers });
  }
}
