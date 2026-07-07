/**
 * Cloudflare Pages Function: /api/meta-catalogo (somente leitura, diagnóstico)
 * Tenta achar o catálogo de produtos ligado à conta/negócio Meta e listar produtos.
 *   ?debug=1        -> mostra os passos (conta->negócio->catálogos) pra diagnosticar permissão
 *   ?catalogo=ID     -> pula a descoberta e usa esse ID de catálogo direto
 *   ?busca=handle     -> filtra produtos do catálogo cujo retailer_id/url contém o termo
 */
const API_VERSION = 'v23.0';
const CONTA_PADRAO = 'act_968164338120112';

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const token = env.META_ACCESS_TOKEN;
  if (!token) return new Response(JSON.stringify({ erro: 'META_ACCESS_TOKEN não configurado' }), { status: 500, headers });
  const qs = new URL(request.url).searchParams;
  const conta = env.META_AD_ACCOUNT_ID || CONTA_PADRAO;
  const debug = qs.get('debug') === '1';
  const catalogoParam = qs.get('catalogo');
  const busca = (qs.get('busca') || '').toLowerCase();

  const passos = {};
  try {
    let catalogoId = catalogoParam;
    if (!catalogoId) {
      // 1) acha o negócio dono da conta de anúncios
      const rConta = await fetch(`https://graph.facebook.com/${API_VERSION}/${conta}?fields=business,name&access_token=${token}`);
      const dConta = await rConta.json();
      passos.conta = dConta;
      const businessId = dConta.business && dConta.business.id;
      if (!businessId) {
        return new Response(JSON.stringify({ erro: 'não achou o negócio (business) dono da conta de anúncios', detalhe: dConta, passos: debug ? passos : undefined }, null, 2), { status: 404, headers });
      }
      // 2) lista catálogos do negócio (owned + client)
      const rCat = await fetch(`https://graph.facebook.com/${API_VERSION}/${businessId}/owned_product_catalogs?access_token=${token}`);
      const dCat = await rCat.json();
      passos.owned_product_catalogs = dCat;
      let catalogos = (dCat.data || []);
      if (!catalogos.length) {
        const rCat2 = await fetch(`https://graph.facebook.com/${API_VERSION}/${businessId}/client_product_catalogs?access_token=${token}`);
        const dCat2 = await rCat2.json();
        passos.client_product_catalogs = dCat2;
        catalogos = (dCat2.data || []);
      }
      if (!catalogos.length) {
        return new Response(JSON.stringify({ erro: 'não achou catálogo nenhum ligado ao negócio (pode ser falta de permissão catalog_management no token)', passos }, null, 2), { status: 404, headers });
      }
      catalogoId = catalogos[0].id;
    }

    // 3) lista produtos do catálogo
    const fields = 'name,availability,retailer_id,url,visibility,review_status';
    const produtos = [];
    let url = `https://graph.facebook.com/${API_VERSION}/${catalogoId}/products?fields=${fields}&limit=250&access_token=${token}`;
    let guard = 0;
    while (url && guard < 20) {
      guard++;
      const r = await fetch(url);
      const d = await r.json();
      if (d.error) return new Response(JSON.stringify({ erro: 'Meta API', detalhe: d.error, passos: debug ? passos : undefined }, null, 2), { status: 502, headers });
      produtos.push(...(d.data || []));
      url = (d.paging && d.paging.next) || null;
    }
    const filtrados = busca ? produtos.filter(p => (p.url || '').toLowerCase().includes(busca) || (p.retailer_id || '').toLowerCase().includes(busca)) : produtos;

    return new Response(JSON.stringify({
      catalogo_id: catalogoId, total_produtos: produtos.length,
      produtos: filtrados,
      passos: debug ? passos : undefined,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message, passos: debug ? passos : undefined }), { status: 500, headers });
  }
}
