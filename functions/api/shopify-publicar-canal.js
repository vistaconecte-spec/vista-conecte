/**
 * Cloudflare Pages Function: /api/shopify-publicar-canal
 * Publica (ou remove) um produto num canal de venda específico (ex: Facebook & Instagram).
 *   ?id=PRODUTO_ID&canal=Facebook            → dry-run: mostra se já está publicado no canal
 *   ?id=PRODUTO_ID&canal=Facebook&apply=1     → publica de verdade
 *   ?id=PRODUTO_ID&canal=Facebook&apply=1&remover=1 → despublica do canal
 * "canal" casa por substring (case-insensitive) no nome do canal (ex: "facebook", "instagram", "online store").
 * Requer read_publications + write_publications.
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  const qs = new URL(request.url).searchParams;
  const id = qs.get('id');
  const canalBusca = (qs.get('canal') || '').toLowerCase().trim();
  const apply = qs.get('apply') === '1';
  const remover = qs.get('remover') === '1';
  if (!id || !canalBusca) return new Response(JSON.stringify({ erro: 'informe ?id= e ?canal=' }), { status: 400, headers });

  const gql = async (query, variables) => {
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json();
    if (j.errors) throw new Error('GraphQL: ' + JSON.stringify(j.errors));
    return j.data;
  };

  try {
    // 1) acha o canal pelo nome
    const canaisData = await gql(`{ publications(first: 20) { edges { node { id name } } } }`);
    const canais = canaisData.publications.edges.map(e => e.node);
    const canal = canais.find(c => c.name.toLowerCase().includes(canalBusca));
    if (!canal) return new Response(JSON.stringify({ erro: `canal não encontrado para "${canalBusca}"`, canais_disponiveis: canais.map(c => c.name) }), { status: 404, headers });

    const gid = `gid://shopify/Product/${id}`;

    // 2) título do produto (só pra exibir no resultado)
    const statusData = await gql(`query($id: ID!) { product(id: $id) { title } }`, { id: gid });

    // publica/despublica via mutation dedicada
    let resultado = 'dry-run (nada alterado)';
    if (apply) {
      const mutation = remover
        ? `mutation($id: ID!, $input: [PublicationInput!]!) { publishableUnpublish(id: $id, input: $input) { userErrors { field message } } }`
        : `mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`;
      const mutData = await gql(mutation, { id: gid, input: [{ publicationId: canal.id }] });
      const key = remover ? 'publishableUnpublish' : 'publishablePublish';
      const errs = mutData[key].userErrors;
      resultado = errs.length ? `falha: ${JSON.stringify(errs)}` : (remover ? 'removido do canal' : 'publicado no canal');
    }

    return new Response(JSON.stringify({
      produto: statusData.product ? statusData.product.title : null,
      id, canal: canal.name, canal_id: canal.id,
      modo: apply ? 'APLICAR' : 'dry-run', resultado,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
