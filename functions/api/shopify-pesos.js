/**
 * Cloudflare Pages Function: /api/shopify-pesos (somente leitura)
 * Lista o peso cadastrado de cada produto/variante ativo na Shopify.
 * Útil pra auditar se o frete vai sair coerente com a cubagem.
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  try {
    const itens = [];
    let semPeso = 0, comPeso = 0;
    let url = `https://${store}/admin/api/${API_VERSION}/products.json?status=active&limit=250&fields=id,title,variants`;
    while (url) {
      const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}` }), { status: 502, headers });
      const data = await res.json();
      for (const p of (data.products || [])) {
        const vs = p.variants || [];
        const gramas = vs.map(v => v.grams || 0);
        const g = Math.max(0, ...gramas);
        if (g > 0) comPeso++; else semPeso++;
        itens.push({ titulo: p.title, gramas: g, todas_variantes_iguais: new Set(gramas).size === 1 });
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
    itens.sort((a, b) => a.gramas - b.gramas);
    return new Response(JSON.stringify({ total: itens.length, com_peso: comPeso, sem_peso: semPeso, itens }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
