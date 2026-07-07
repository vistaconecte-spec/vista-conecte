/**
 * Cloudflare Pages Function: /api/shopify-desconto-colecao?handle=sale-ate-60-off (somente leitura)
 * Calcula o desconto real (compare_at_price vs price) dos produtos ativos de uma coleção.
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  const handle = new URL(request.url).searchParams.get('handle');
  if (!handle) return new Response(JSON.stringify({ erro: 'informe ?handle=' }), { status: 400, headers });
  const sh = { 'X-Shopify-Access-Token': token };
  const api = (p) => `https://${store}/admin/api/${API_VERSION}/${p}`;

  try {
    const colRes = await fetch(api(`custom_collections.json?handle=${encodeURIComponent(handle)}`), { headers: sh });
    let col = (await colRes.json()).custom_collections?.[0];
    if (!col) {
      const smartRes = await fetch(api(`smart_collections.json?handle=${encodeURIComponent(handle)}`), { headers: sh });
      col = (await smartRes.json()).smart_collections?.[0];
    }
    if (!col) return new Response(JSON.stringify({ erro: `coleção "${handle}" não encontrada` }), { status: 404, headers });

    const num = v => parseFloat(v || '0') || 0;
    const debug = new URL(request.url).searchParams.get('debug') === '1';
    let url = api(`products.json?collection_id=${col.id}&limit=250&status=active&fields=id,title,variants`);
    const itens = [];
    const brutos = [];
    while (url) {
      const res = await fetch(url, { headers: sh });
      const data = await res.json();
      for (const p of (data.products || [])) {
        for (const v of (p.variants || [])) {
          const price = num(v.price), compare = num(v.compare_at_price);
          if (debug && brutos.length < 500) brutos.push({ produto: p.title, price: v.price, compare_at_price: v.compare_at_price });
          if (compare > price && price > 0) {
            const pct = Math.round((1 - price / compare) * 100);
            itens.push({ produto: p.title, price, compare, pct });
          }
        }
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    const pcts = itens.map(i => i.pct);
    const maxPct = pcts.length ? Math.max(...pcts) : 0;
    const minPct = pcts.length ? Math.min(...pcts) : 0;
    const media = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0;
    itens.sort((a, b) => b.pct - a.pct);

    // preço médio por PRODUTO único (1ª variante), pra simular "N peças avulsas" vs combo fechado
    const porProduto = new Map();
    let url2 = api(`products.json?collection_id=${col.id}&limit=250&status=active&fields=id,title,variants`);
    while (url2) {
      const res = await fetch(url2, { headers: sh });
      const data = await res.json();
      for (const p of (data.products || [])) {
        const preco = num(p.variants && p.variants[0] && p.variants[0].price);
        if (preco > 0 && !porProduto.has(p.title)) porProduto.set(p.title, preco);
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url2 = next ? next[1] : null;
    }
    const precos = [...porProduto.values()];
    const precoMedio = precos.length ? precos.reduce((a, b) => a + b, 0) / precos.length : 0;

    const qs2 = new URL(request.url).searchParams;
    const nPecas = parseInt(qs2.get('combo_pecas') || '0', 10);
    const precoCombo = num(qs2.get('combo_preco'));
    let simulacaoCombo = null;
    if (nPecas > 0 && precoCombo > 0 && precoMedio > 0) {
      const totalAvulso = precoMedio * nPecas;
      const economiaReais = totalAvulso - precoCombo;
      const economiaPct = Math.round((economiaReais / totalAvulso) * 100);
      simulacaoCombo = { produtos_considerados: precos.length, preco_medio_peca: +precoMedio.toFixed(2), pecas_no_combo: nPecas, total_comprando_avulso: +totalAvulso.toFixed(2), preco_combo: precoCombo, economia_reais: +economiaReais.toFixed(2), economia_pct: economiaPct };
    }

    return new Response(JSON.stringify({
      colecao: col.title, handle, total_variantes_com_desconto: itens.length,
      desconto_maximo_pct: maxPct, desconto_minimo_pct: minPct, desconto_medio_pct: media,
      preco_medio_produto_colecao: +precoMedio.toFixed(2), total_produtos_precificados: precos.length,
      simulacao_combo: simulacaoCombo,
      top_10: itens.slice(0, 10),
      amostra_bruta: debug ? brutos : undefined,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
