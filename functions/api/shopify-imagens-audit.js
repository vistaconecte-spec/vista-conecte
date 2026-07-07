/**
 * Cloudflare Pages Function: /api/shopify-imagens-audit (somente leitura)
 * Audita todos os produtos ativos com opção "Cor": lista quais cores NÃO têm
 * nenhuma imagem vinculada (variant_ids) — sintoma de foto enviada mas não
 * "linkada" à variante, fazendo o clique na cor não trocar a imagem no site.
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  const sh = { 'X-Shopify-Access-Token': token };
  const api = (p) => `https://${store}/admin/api/${API_VERSION}/${p}`;

  try {
    let url = api('products.json?status=active&limit=250&fields=id,title,options,variants,images');
    const problemas = [];
    let totalComCor = 0;
    while (url) {
      const res = await fetch(url, { headers: sh });
      const data = await res.json();
      for (const p of (data.products || [])) {
        const corIdx = (p.options || []).findIndex(o => /cor|color/i.test(o.name));
        if (corIdx < 0) continue;
        const corOpt = p.options[corIdx];
        const corKey = 'option' + (corIdx + 1);
        totalComCor++;
        const cores = corOpt.values || [];
        if (cores.length <= 1) continue; // só 1 cor não precisa de vínculo por cor

        // mapa cor -> tem imagem vinculada? (usa a option certa, cor nem sempre é option1)
        const corDaVariante = {};
        for (const v of (p.variants || [])) corDaVariante[v.id] = v[corKey];
        const coresComImagem = new Set();
        for (const im of (p.images || [])) {
          for (const vid of (im.variant_ids || [])) {
            const c = corDaVariante[vid];
            if (c) coresComImagem.add(c);
          }
        }
        const semImagem = cores.filter(c => !coresComImagem.has(c));
        if (semImagem.length) {
          problemas.push({ id: p.id, titulo: p.title, cores_sem_foto: semImagem, total_cores: cores.length });
        }
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    return new Response(JSON.stringify({
      total_produtos_com_opcao_cor: totalComCor,
      total_com_cor_sem_foto: problemas.length,
      produtos: problemas,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
