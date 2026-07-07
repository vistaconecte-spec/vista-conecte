/**
 * Cloudflare Pages Function: /api/shopify-principal
 * Define a COR principal de um produto unificado:
 *   - foto de capa (posição 1) = foto da cor
 *   - cor que abre selecionada = reordena variantes pra essa cor vir primeiro
 *   ?id=123&cor=Preto            → dry-run
 *   ?id=123&cor=Preto&apply=1    → aplica
 */
const API_VERSION = '2024-04';
const SIZES = ['PP', 'P', 'M', 'G', 'GG'];

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });
  const qs = new URL(request.url).searchParams;
  const id = qs.get('id'), cor = qs.get('cor'), apply = qs.get('apply') === '1';
  if (!id || !cor) return new Response(JSON.stringify({ erro: 'informe ?id= e ?cor=' }), { status: 400, headers: H });
  const sh = { 'X-Shopify-Access-Token': token };
  const api = (p) => `https://${store}/admin/api/${API_VERSION}/${p}`;

  try {
    const p = (await (await fetch(api(`products/${id}.json?fields=id,variants,images`), { headers: sh })).json()).product;
    const alvo = p.variants.filter(v => v.option1 === cor);
    if (!alvo.length) return new Response(JSON.stringify({ erro: `cor "${cor}" não encontrada nas variantes` }), { status: 400, headers: H });

    // ordem das variantes: cor alvo primeiro (na ordem de tamanho), depois o resto
    const sz = (v) => { const i = SIZES.indexOf((v.option2 || '').toUpperCase()); return i < 0 ? 99 : i; };
    const alvoOrd = [...alvo].sort((a, b) => sz(a) - sz(b));
    const resto = p.variants.filter(v => v.option1 !== cor);
    const novaOrdem = [...alvoOrd, ...resto];
    const variantsPayload = novaOrdem.map((v, i) => ({ id: v.id, position: i + 1 }));

    // imagem de capa: a featured da cor (tem variant_ids da cor) ou a 1ª imagem alt==cor
    const idsAlvo = new Set(alvo.map(v => v.id));
    const featured = p.images.find(im => (im.variant_ids || []).some(x => idsAlvo.has(x)));
    const porAlt = p.images.find(im => (im.alt || '') === cor);
    const capa = featured || porAlt || null;

    let resultadoVar = 'dry-run', resultadoImg = 'dry-run';
    if (apply) {
      const rv = await fetch(api(`products/${id}.json`), {
        method: 'PUT', headers: { ...sh, 'Content-Type': 'application/json' },
        body: JSON.stringify({ product: { id: Number(id), variants: variantsPayload } }),
      });
      resultadoVar = rv.ok ? 'variantes reordenadas (Preto primeiro)' : `falha var ${rv.status}: ${(await rv.text()).slice(0, 150)}`;
      if (capa) {
        const ri = await fetch(api(`products/${id}/images/${capa.id}.json`), {
          method: 'PUT', headers: { ...sh, 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: { id: capa.id, position: 1 } }),
        });
        resultadoImg = ri.ok ? 'foto de capa definida' : `falha img ${ri.status}`;
      } else resultadoImg = 'nenhuma imagem da cor encontrada';
    }

    return new Response(JSON.stringify({
      id, cor, modo: apply ? 'APLICAR' : 'dry-run',
      variantes_da_cor: alvo.length, capa_image_id: capa ? capa.id : null,
      resultado_variantes: resultadoVar, resultado_capa: resultadoImg,
    }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
