/**
 * Cloudflare Pages Function: /api/shopify-preco-de
 * Ajusta SÓ o preço "de" (compare_at_price, o riscado) das variantes de um produto.
 * Não encosta no preço de venda — pra isso existe /api/shopify-update-preco.
 *
 *   GET  ?id=123                        -> mostra preço e "de" de cada variante
 *   POST { id, compareAt, confirmar }   -> grava; sem confirmar = dry-run
 *        compareAt número > 0 define o riscado; 0 ou null limpa o riscado.
 *
 * Recusa gravar se o riscado ficar MENOR OU IGUAL ao preço de venda — nesse caso
 * a Shopify mostraria um "desconto" negativo ou zerado na vitrine.
 */
const API_VERSION = '2024-04';

export async function onRequest({ request, env }) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });

  const store = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  const sh = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  const lerProduto = async (id) => {
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/products/${id}.json`, { headers: sh });
    if (!r.ok) return null;
    return (await r.json()).product;
  };

  try {
    if (request.method === 'GET') {
      const id = new URL(request.url).searchParams.get('id');
      if (!id) return new Response(JSON.stringify({ erro: 'informe ?id=' }), { status: 400, headers });
      const p = await lerProduto(id);
      if (!p) return new Response(JSON.stringify({ erro: 'produto não encontrado' }), { status: 404, headers });
      return new Response(JSON.stringify({
        id: p.id, produto: p.title,
        variantes: p.variants.map(v => ({ id: v.id, variante: v.title, preco: v.price, de: v.compare_at_price })),
      }, null, 2), { headers });
    }

    const b = await request.json();
    if (!b.id) return new Response(JSON.stringify({ erro: 'informe id' }), { status: 400, headers });
    const limpar = b.compareAt === 0 || b.compareAt === null;
    const novo = limpar ? null : Number(b.compareAt);
    if (!limpar && (!isFinite(novo) || novo <= 0)) {
      return new Response(JSON.stringify({ erro: 'compareAt deve ser número > 0, ou 0/null pra limpar' }), { status: 400, headers });
    }

    const p = await lerProduto(b.id);
    if (!p) return new Response(JSON.stringify({ erro: 'produto não encontrado' }), { status: 404, headers });

    const plano = p.variants.map(v => ({
      variantId: v.id, variante: v.title, preco: v.price,
      de_antes: v.compare_at_price,
      de_depois: limpar ? null : novo.toFixed(2),
      muda: String(v.compare_at_price ?? '') !== String(limpar ? '' : novo.toFixed(2)),
    }));

    const conflito = limpar ? [] : plano.filter(x => Number(x.preco) >= novo);
    if (conflito.length) {
      return new Response(JSON.stringify({
        erro: 'riscado menor ou igual ao preço de venda',
        detalhe: conflito.map(c => `${c.variante}: venda R$ ${c.preco} x riscado R$ ${novo.toFixed(2)}`),
      }, null, 2), { status: 400, headers });
    }

    if (b.confirmar !== true) {
      return new Response(JSON.stringify({
        modo: 'dry-run (nada gravado)', produto: p.title, id: p.id,
        compareAt_novo: limpar ? null : novo.toFixed(2),
        variantes: plano.length, mudam: plano.filter(x => x.muda).length, plano,
      }, null, 2), { headers });
    }

    const resultados = [];
    for (const x of plano) {
      if (!x.muda) { resultados.push({ ...x, status: 'sem mudança' }); continue; }
      const r = await fetch(`https://${store}/admin/api/${API_VERSION}/variants/${x.variantId}.json`, {
        method: 'PUT', headers: sh,
        body: JSON.stringify({ variant: { id: x.variantId, compare_at_price: limpar ? null : novo.toFixed(2) } }),
      });
      resultados.push({ ...x, status: r.ok ? 'atualizado' : `falhou ${r.status}` });
    }
    return new Response(JSON.stringify({ ok: true, produto: p.title, atualizados: resultados.filter(r => r.status === 'atualizado').length, resultados }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e) }), { status: 500, headers });
  }
}
