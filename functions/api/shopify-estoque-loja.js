/**
 * Cloudflare Pages Function: /api/shopify-estoque-loja (somente leitura)
 * Audita disponibilidade dos produtos ATIVOS: quantas variantes têm estoque,
 * se o estoque é rastreado, e sinaliza produtos "esgotados" (0 variantes com saldo).
 * Ajuda a diagnosticar queda de conversão por falta de produto-herói.
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  try {
    const itens = [];
    let url = `https://${store}/admin/api/${API_VERSION}/products.json?status=active&published_status=any&limit=250&fields=id,title,published_at,variants`;
    while (url) {
      const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}` }), { status: 502, headers });
      const data = await res.json();
      for (const p of (data.products || [])) {
        const vs = p.variants || [];
        const rastreadas = vs.filter(v => v.inventory_management === 'shopify');
        const comSaldo = rastreadas.filter(v => (v.inventory_quantity || 0) > 0);
        const saldoTotal = rastreadas.reduce((s, v) => s + (v.inventory_quantity || 0), 0);
        itens.push({
          titulo: p.title,
          publicado: !!p.published_at,
          variantes: vs.length,
          rastreadas: rastreadas.length,
          variantes_com_saldo: comSaldo.length,
          saldo_total: saldoTotal,
          // só consideramos "esgotado" quando o estoque é rastreado e zerou tudo
          esgotado: rastreadas.length > 0 && comSaldo.length === 0,
          estoque_nao_rastreado: rastreadas.length === 0,
        });
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    const ativos = itens.length;
    const esgotados = itens.filter(i => i.esgotado);
    const naoRastreados = itens.filter(i => i.estoque_nao_rastreado);
    const rastreadosComSaldo = itens.filter(i => !i.estoque_nao_rastreado && !i.esgotado);
    // Produtos rastreados, ordenados pelos com MENOS saldo (risco de esgotar)
    const baixoEstoque = itens.filter(i => !i.estoque_nao_rastreado)
      .sort((a, b) => a.saldo_total - b.saldo_total).slice(0, 30);

    return new Response(JSON.stringify({
      resumo: {
        produtos_ativos: ativos,
        esgotados: esgotados.length,
        estoque_nao_rastreado: naoRastreados.length,
        rastreados_com_saldo: rastreadosComSaldo.length,
      },
      esgotados: esgotados.map(i => i.titulo),
      baixo_estoque: baixoEstoque,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
