/**
 * Cloudflare Pages Function: /api/shopify-unificar
 * Cria um produto unificado (Cor + Tamanho) a partir dos produtos separados por cor.
 *
 * Etapa 1 — criar:
 *   ?base=Macaquinho Amplo                  → dry-run: mostra o plano (cores, preços, variantes)
 *   ?base=Macaquinho Amplo&apply=1          → cria o produto RASCUNHO com as variantes/preços
 *     (retorna newid + mapa cor→oldid pra etapa 2)
 *
 * Etapa 2 — imagens (rode 1x por cor):
 *   ?img=1&newid=X&oldid=Y&cor=Preto&apply=1 → copia as fotos da cor Y → produto X, vinculadas à cor
 */
const API_VERSION = '2024-04';
const SIZES = ['PP', 'P', 'M', 'G', 'GG'];
const COLOR_NORM = { offwhite: 'Off White', 'off white': 'Off White', off: 'Off White', branca: 'Off White', branco: 'Off White', preta: 'Preto', 'petroleo': 'Petróleo' };
function normCor(c) { return COLOR_NORM[c.toLowerCase()] || c; }

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });
  const qs = new URL(request.url).searchParams;
  const apply = qs.get('apply') === '1';
  const sh = { 'X-Shopify-Access-Token': token };
  const api = (path) => `https://${store}/admin/api/${API_VERSION}/${path}`;

  try {
    // ─── DELETAR produto (limpeza) ───
    if (qs.get('del') === '1') {
      const id = qs.get('id');
      if (!id) return new Response(JSON.stringify({ erro: 'del precisa de id' }), { status: 400, headers: H });
      let resultado = 'dry-run';
      if (apply) {
        const r = await fetch(api(`products/${id}.json`), { method: 'DELETE', headers: sh });
        resultado = r.ok ? 'deletado' : `falha ${r.status}`;
      }
      return new Response(JSON.stringify({ acao: 'deletar', id, modo: apply ? 'APLICAR' : 'dry-run', resultado }, null, 2), { headers: H });
    }

    // ─── ETAPA 2: imagens (idempotente via alt=cor) ───
    if (qs.get('img') === '1') {
      const newid = qs.get('newid'), oldid = qs.get('oldid'), cor = qs.get('cor');
      if (!newid || !oldid || !cor) return new Response(JSON.stringify({ erro: 'img precisa de newid, oldid, cor' }), { status: 400, headers: H });
      const oldP = await (await fetch(api(`products/${oldid}.json?fields=images`), { headers: sh })).json();
      const srcs = (oldP.product.images || []).map(im => im.src);
      const newP = await (await fetch(api(`products/${newid}.json?fields=variants,images`), { headers: sh })).json();
      const variantIds = (newP.product.variants || []).filter(v => v.option1 === cor).map(v => v.id);
      // já existentes desta cor (marcadas com alt=cor) → apaga p/ idempotência
      const existentesDaCor = (newP.product.images || []).filter(im => (im.alt || '') === cor);
      let apagadas = 0, feitas = 0;
      if (apply) {
        for (const im of existentesDaCor) {
          const r = await fetch(api(`products/${newid}/images/${im.id}.json`), { method: 'DELETE', headers: sh });
          if (r.ok) apagadas++;
        }
        let primeira = true; // 1ª imagem da cor vira a featured (variant image)
        for (const src of srcs) {
          const body = { image: { src, alt: cor } };
          if (primeira) { body.image.variant_ids = variantIds; primeira = false; }
          const r = await fetch(api(`products/${newid}/images.json`), {
            method: 'POST', headers: { ...sh, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
          if (r.ok) feitas++;
        }
      }
      return new Response(JSON.stringify({ etapa: 'imagens', cor, variantes_da_cor: variantIds.length, fotos_origem: srcs.length, ja_existiam_da_cor: existentesDaCor.length, apagadas: apply ? apagadas : '(dry-run)', fotos_anexadas: apply ? feitas : '(dry-run)', modo: apply ? 'APLICAR' : 'dry-run' }, null, 2), { headers: H });
    }

    // ─── ETAPA 1: criar ───
    const base = (qs.get('base') || '').trim();
    if (!base) return new Response(JSON.stringify({ erro: 'informe ?base=' }), { status: 400, headers: H });
    const baseL = base.toLowerCase();

    // override manual: ?tamanhos=34,35,36 — usa quando o modelo não é PP-GG (ex: calçados)
    const tamanhosParam = (qs.get('tamanhos') || '').trim();
    const SIZES_USAR = tamanhosParam ? tamanhosParam.split(',').map(s => s.trim()).filter(Boolean) : SIZES;

    // override manual: ?ids=oldid1:Cor1,oldid2:Cor2 — usa quando os títulos não têm prefixo comum
    const idsParam = (qs.get('ids') || '').trim();
    const origem = [];
    if (idsParam) {
      for (const par of idsParam.split(',')) {
        const [oldid, corOriginal] = par.split(':').map(s => (s || '').trim());
        if (!oldid || !corOriginal) continue;
        const p = await (await fetch(api(`products/${oldid}.json?fields=id,title,variants`), { headers: sh })).json();
        const preco = (p.product && p.product.variants && p.product.variants[0] && p.product.variants[0].price) || '0';
        origem.push({ oldid: Number(oldid), corOriginal, cor: normCor(corOriginal), preco });
      }
    } else {
      let url = api(`products.json?status=active&limit=250&fields=id,title,options,variants`);
      while (url) {
        const res = await fetch(url, { headers: sh });
        const data = await res.json();
        for (const p of (data.products || [])) {
          const t = (p.title || '').trim();
          if (!t.toLowerCase().startsWith(baseL)) continue;
          const resto = t.slice(base.length).trim();
          if (!resto) continue; // é o próprio base, sem cor
          if ((p.options || []).some(o => /cor|color/i.test(o.name))) continue; // já unificado
          const preco = (p.variants && p.variants[0] && p.variants[0].price) || '0';
          origem.push({ oldid: p.id, corOriginal: resto, cor: normCor(resto), preco });
        }
        const link = res.headers.get('Link') || '';
        const next = link.match(/<([^>]+)>;\s*rel="next"/);
        url = next ? next[1] : null;
      }
    }
    origem.sort((a, b) => a.cor.localeCompare(b.cor));

    // monta variantes: cor × tamanho
    const variants = [];
    for (const o of origem) for (const tam of SIZES_USAR) {
      variants.push({ option1: o.cor, option2: tam, price: o.preco, inventory_management: null });
    }
    const produto = {
      title: base, status: 'draft',
      options: [{ name: 'Cor' }, { name: 'Tamanho' }],
      variants,
    };

    let resultado = 'dry-run (nada criado)', newid = null;
    if (apply) {
      const r = await fetch(api('products.json'), {
        method: 'POST', headers: { ...sh, 'Content-Type': 'application/json' },
        body: JSON.stringify({ product: produto }),
      });
      const j = await r.json();
      if (r.ok) { newid = j.product.id; resultado = 'criado (rascunho)'; }
      else resultado = `falha ${r.status}: ${JSON.stringify(j).slice(0, 300)}`;
    }

    return new Response(JSON.stringify({
      base, modo: apply ? 'APLICAR' : 'dry-run', resultado, newid,
      cores: origem.map(o => ({ cor: o.cor, preco: o.preco, oldid: o.oldid })),
      total_variantes: variants.length,
      proximo_passo: newid ? `Para cada cor: ?img=1&newid=${newid}&oldid=OLDID&cor=COR&apply=1` : null,
    }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
