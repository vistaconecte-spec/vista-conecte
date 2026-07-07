/**
 * Cloudflare Pages Function: /api/shopify-produto (somente leitura, diagnóstico)
 * Lista produtos cujo título contém ?q=... (inclui rascunhos), mostrando
 * as opções (Cor/Tamanho) e uma amostra das variantes — pra conferir a estrutura.
 *   ?q=flare
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  const qs = new URL(request.url).searchParams;
  const q = (qs.get('q') || '').toLowerCase().trim();
  const comHtml = qs.get('html') === '1';
  if (!q) return new Response(JSON.stringify({ erro: 'informe ?q=' }), { status: 400, headers });

  try {
    const achados = [];
    // sem filtro de status → traz active + draft + archived
    const campos = 'id,title,status,options,variants,images' + (comHtml ? ',body_html' : '');
    let url = `https://${store}/admin/api/${API_VERSION}/products.json?limit=250&fields=${campos}`;
    while (url) {
      const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}`, detalhe: (await res.text()).slice(0, 200) }), { status: 502, headers });
      const data = await res.json();
      for (const p of (data.products || [])) {
        if (!(p.title || '').toLowerCase().includes(q)) continue;
        const variantes = (p.variants || []).map(v => ({
          id: v.id, title: v.title, option1: v.option1, option2: v.option2, option3: v.option3,
          preco: v.price, estoque: v.inventory_quantity, politica: v.inventory_policy, gestao: v.inventory_management,
        }));
        const imagens = (p.images || []).map(im => ({ id: im.id, src: im.src, variant_ids: im.variant_ids || [] }));
        // conta imagens por cor (via variante associada)
        const corDaVariante = {};
        for (const v of (p.variants || [])) corDaVariante[v.id] = v.option1;
        const imgsPorCor = {};
        for (const im of (p.images || [])) {
          for (const vid of (im.variant_ids || [])) {
            const c = corDaVariante[vid]; if (!c) continue;
            imgsPorCor[c] = (imgsPorCor[c] || new Set());
            imgsPorCor[c].add(im.id);
          }
        }
        const imgsPorCorCount = {};
        for (const c in imgsPorCor) imgsPorCorCount[c] = imgsPorCor[c].size;
        // Resumo de estoque por cor (option1)
        const porCor = {};
        for (const v of variantes) {
          const c = v.option1 || '(sem cor)';
          porCor[c] = (porCor[c] || 0) + (v.estoque || 0);
        }
        achados.push({
          id: p.id, title: p.title, status: p.status,
          opcoes: (p.options || []).map(o => ({ nome: o.name, valores: o.values })),
          total_variantes: variantes.length,
          estoque_por_cor: porCor,
          num_imagens: imagens.length,
          imagens_por_cor: imgsPorCorCount,
          imagens,
          variantes,
          ...(comHtml ? { body_html: p.body_html || '' } : {}),
        });
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
    return new Response(JSON.stringify({ q, encontrados: achados.length, produtos: achados }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
