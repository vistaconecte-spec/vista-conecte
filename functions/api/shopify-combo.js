/**
 * Cloudflare Pages Function: /api/shopify-combo
 * Busca coleções customizadas da Shopify e os produtos de cada uma,
 * para identificar quais peças compõem o combo R$399.
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_ADMIN_TOKEN;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (!store || !token) {
    return new Response(JSON.stringify({ erro: 'Variáveis de ambiente não configuradas' }), { status: 500, headers });
  }

  const shopHeaders = { 'X-Shopify-Access-Token': token };
  const base = `https://${store}/admin/api/${API_VERSION}`;

  try {
    // 1) Busca todas as custom collections
    const colRes = await fetch(`${base}/custom_collections.json?limit=250`, { headers: shopHeaders });
    const colData = await colRes.json();
    const collections = colData.custom_collections || [];

    // 2) Para cada coleção, busca os produtos
    const result = [];
    for (const col of collections) {
      const prodRes = await fetch(`${base}/products.json?collection_id=${col.id}&limit=250&fields=id,title,variants`, { headers: shopHeaders });
      const prodData = await prodRes.json();
      const produtos = (prodData.products || []).map(p => ({
        id: p.id,
        titulo: p.title,
        precos: [...new Set((p.variants || []).map(v => v.price))],
      }));
      result.push({
        colecao_id: col.id,
        colecao_nome: col.title,
        colecao_handle: col.handle,
        qtd_produtos: produtos.length,
        produtos,
      });
    }

    // 3) Busca também price rules para identificar desconto do combo
    const prRes = await fetch(`${base}/price_rules.json?limit=250`, { headers: shopHeaders });
    const prData = await prRes.json();
    const priceRules = (prData.price_rules || []).map(r => ({
      id: r.id,
      titulo: r.title,
      tipo: r.value_type,
      valor: r.value,
      quantidade_minima: r.prerequisite_quantity_range,
      quantia_minima: r.prerequisite_subtotal_range,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
    }));

    return new Response(JSON.stringify({ colecoes: result, price_rules: priceRules }, null, 2), { headers });
  } catch (err) {
    return new Response(JSON.stringify({ erro: err.message }), { status: 500, headers });
  }
}
