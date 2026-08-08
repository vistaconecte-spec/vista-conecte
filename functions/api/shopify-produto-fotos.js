/**
 * Cloudflare Pages Function: /api/shopify-produto-fotos
 * Gerencia as fotos de um produto (listar, adicionar, remover).
 *
 *   GET  ?produto_id=123            -> lista as fotos com id, posicao, alt e variantes ligadas
 *   GET  ?produto_id=123&alt=#Cor_Cinza -> só as fotos daquele alt (agrupamento por cor do tema)
 *   POST { produto_id, acao:'adicionar', imagens:[{attachment, alt, position, variant_ids}], confirmar }
 *   POST { produto_id, acao:'remover', imagem_ids:[...], confirmar }
 *
 * Dry-run por padrão: só executa com confirmar:true. Remoção é irreversível —
 * o dry-run devolve exatamente quais fotos sairiam.
 */
const API_VERSION = '2024-04';

export async function onRequest({ request, env }) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  const token = env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN;
  const store = env.SHOPIFY_STORE_DOMAIN;
  if (!token || !store) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  const sh = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  const api = (p) => `https://${store}/admin/api/${API_VERSION}/${p}`;

  const listar = async (produtoId) => {
    const r = await fetch(api(`products/${produtoId}/images.json`), { headers: sh });
    if (!r.ok) throw new Error(`listar imagens: ${r.status}`);
    return (await r.json()).images || [];
  };
  const resumo = (img) => ({
    id: img.id, posicao: img.position, alt: img.alt || null,
    arquivo: (img.src || '').split('/').pop().split('?')[0],
    variantes_ligadas: (img.variant_ids || []).length,
    src: img.src,
  });

  try {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      const produtoId = url.searchParams.get('produto_id');
      if (!produtoId) return new Response(JSON.stringify({ erro: 'informe ?produto_id=' }), { status: 400, headers });
      const alt = url.searchParams.get('alt');
      let imgs = (await listar(produtoId)).map(resumo);
      if (alt) imgs = imgs.filter(i => (i.alt || '') === alt);
      const porAlt = {};
      imgs.forEach(i => { const k = i.alt || '(sem alt)'; porAlt[k] = (porAlt[k] || 0) + 1; });
      return new Response(JSON.stringify({ produto_id: produtoId, total: imgs.length, por_alt: porAlt, fotos: imgs }, null, 2), { headers });
    }

    const b = await request.json();
    const produtoId = b.produto_id;
    if (!produtoId || !b.acao) return new Response(JSON.stringify({ erro: 'informe produto_id e acao' }), { status: 400, headers });

    if (b.acao === 'adicionar') {
      const imagens = Array.isArray(b.imagens) ? b.imagens : [];
      if (!imagens.length) return new Response(JSON.stringify({ erro: 'informe imagens[]' }), { status: 400, headers });
      if (b.confirmar !== true) {
        return new Response(JSON.stringify({
          modo: 'dry-run (nada enviado)', produto_id: produtoId,
          vai_adicionar: imagens.map((i, n) => ({ n: n + 1, alt: i.alt || null, position: i.position || null, variantes: (i.variant_ids || []).length, bytes_base64: (i.attachment || '').length })),
        }, null, 2), { headers });
      }
      const criadas = [];
      for (const img of imagens) {
        const payload = { image: { attachment: img.attachment } };
        if (img.alt) payload.image.alt = img.alt;
        if (img.position) payload.image.position = img.position;
        if (Array.isArray(img.variant_ids) && img.variant_ids.length) payload.image.variant_ids = img.variant_ids;
        const r = await fetch(api(`products/${produtoId}/images.json`), { method: 'POST', headers: sh, body: JSON.stringify(payload) });
        const j = await r.json();
        if (!r.ok) return new Response(JSON.stringify({ erro: 'falha ao adicionar', detalhe: j, ja_criadas: criadas }, null, 2), { status: 502, headers });
        criadas.push(resumo(j.image));
      }
      return new Response(JSON.stringify({ ok: true, adicionadas: criadas }, null, 2), { headers });
    }

    if (b.acao === 'remover') {
      const ids = Array.isArray(b.imagem_ids) ? b.imagem_ids.map(String) : [];
      if (!ids.length) return new Response(JSON.stringify({ erro: 'informe imagem_ids[]' }), { status: 400, headers });
      const atuais = await listar(produtoId);
      const alvo = atuais.filter(i => ids.includes(String(i.id))).map(resumo);
      const naoEncontradas = ids.filter(id => !atuais.some(i => String(i.id) === id));
      if (b.confirmar !== true) {
        return new Response(JSON.stringify({
          modo: 'dry-run (nada removido)', produto_id: produtoId,
          vai_remover: alvo, nao_encontradas: naoEncontradas,
          restariam: atuais.length - alvo.length,
          aviso: 'remoção é irreversível',
        }, null, 2), { headers });
      }
      const removidas = [];
      for (const img of alvo) {
        const r = await fetch(api(`products/${produtoId}/images/${img.id}.json`), { method: 'DELETE', headers: sh });
        if (!r.ok) return new Response(JSON.stringify({ erro: 'falha ao remover', imagem_id: img.id, status: r.status, ja_removidas: removidas }, null, 2), { status: 502, headers });
        removidas.push(img.id);
      }
      return new Response(JSON.stringify({ ok: true, removidas, restantes: (await listar(produtoId)).length }, null, 2), { headers });
    }

    return new Response(JSON.stringify({ erro: `ação "${b.acao}" desconhecida (use adicionar|remover)` }), { status: 400, headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e && e.message || e) }), { status: 500, headers });
  }
}
