/**
 * Cloudflare Pages Function: /api/meta-product-sets (somente leitura, diagnóstico)
 * Localiza campanhas por nome, lista os ad sets e o "conjunto de produtos" (product set)
 * usado em cada um — pra checar se ainda filtra por produtos/IDs antigos removidos do catálogo.
 *   ?busca=Catálogo   -> filtra campanhas cujo nome contém o termo (padrão: "Catálogo")
 */
const API_VERSION = 'v23.0';
const CONTA_PADRAO = 'act_968164338120112';

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const token = env.META_ACCESS_TOKEN;
  if (!token) return new Response(JSON.stringify({ erro: 'META_ACCESS_TOKEN não configurado' }), { status: 500, headers });
  const conta = env.META_AD_ACCOUNT_ID || CONTA_PADRAO;
  const qsBusca = new URL(request.url).searchParams;
  const todos = qsBusca.get('todos') === '1';
  const busca = (qsBusca.get('busca') || 'Catálogo').toLowerCase();

  const g = async (path) => {
    const r = await fetch(`https://graph.facebook.com/${API_VERSION}/${path}${path.includes('?') ? '&' : '?'}access_token=${token}`);
    return r.json();
  };

  try {
    // 1) campanhas ativas/todas que batem com a busca
    const dCamp = await g(`${conta}/campaigns?fields=name,status,effective_status&limit=200`);
    if (dCamp.error) return new Response(JSON.stringify({ erro: 'Meta API (campaigns)', detalhe: dCamp.error }, null, 2), { status: 502, headers });
    let campanhas = todos ? (dCamp.data || []) : (dCamp.data || []).filter(c => c.name.toLowerCase().includes(busca));
    // modo "todos": só investiga adsets das campanhas ATIVAS (evita estourar limite de subrequests do Worker)
    if (todos) campanhas = campanhas.filter(c => c.effective_status === 'ACTIVE');

    const leve = todos; // modo "todos" não busca product_set (evita estourar limite de subrequests)
    const resultado = [];
    for (const camp of campanhas) {
      const dSets = await g(`${camp.id}/adsets?fields=name,status,effective_status${leve ? '' : ',promoted_object'}`);
      const adsets = [];
      if (dSets.error) { resultado.push({ campanha: camp.name, status: camp.effective_status, erro_adsets: dSets.error }); continue; }
      for (const s of (dSets.data || [])) {
        if (leve) { adsets.push({ nome: s.name, status: s.effective_status }); continue; }
        const productSetId = s.promoted_object && s.promoted_object.product_set_id;
        let productSet = null;
        if (productSetId) {
          const dPs = await g(`${productSetId}?fields=name,product_count,filter`);
          productSet = dPs;
        }
        adsets.push({ nome: s.name, status: s.effective_status, product_set_id: productSetId || null, product_set: productSet });
      }
      resultado.push({ campanha: camp.name, status: camp.effective_status, adsets });
    }

    const pausadas = todos ? (dCamp.data || []).filter(c => c.effective_status !== 'ACTIVE').map(c => c.name) : undefined;
    return new Response(JSON.stringify({ total_campanhas: campanhas.length, resultado, total_pausadas: pausadas ? pausadas.length : undefined, pausadas }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
