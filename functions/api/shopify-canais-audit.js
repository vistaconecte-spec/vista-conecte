/**
 * Cloudflare Pages Function: /api/shopify-canais-audit (somente leitura)
 * Audita todos os produtos ativos e mostra em quais canais de venda cada um
 * está publicado (Online Store, Facebook & Instagram, Google & YouTube, Pinterest, TikTok).
 * Retorna só os produtos com pelo menos 1 canal faltando (?todos=1 pra listar todos).
 */
const API_VERSION = '2024-04';
const CANAIS = [
  { chave: 'onlineStore', nome: 'Online Store', id: 'gid://shopify/Publication/105517809773' },
  { chave: 'facebook', nome: 'Facebook & Instagram', id: 'gid://shopify/Publication/106497310829' },
  { chave: 'google', nome: 'Google & YouTube', id: 'gid://shopify/Publication/106507501677' },
  { chave: 'pinterest', nome: 'Pinterest', id: 'gid://shopify/Publication/108844023917' },
  { chave: 'tiktok', nome: 'TikTok', id: 'gid://shopify/Publication/134462079085' },
];

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  const todos = new URL(request.url).searchParams.get('todos') === '1';

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

  const campos = CANAIS.map(c => `${c.chave}: publishedOnPublication(publicationId: "${c.id}")`).join('\n        ');
  const query = `
    query($cursor: String) {
      products(first: 50, after: $cursor, query: "status:active") {
        edges {
          cursor
          node {
            id
            title
            handle
            ${campos}
          }
        }
        pageInfo { hasNextPage }
      }
    }`;

  try {
    let cursor = null, hasNext = true;
    const produtos = [];
    let paginas = 0;
    while (hasNext && paginas < 10) {
      const d = await gql(query, { cursor });
      const edges = d.products.edges;
      edges.forEach(e => produtos.push(e.node));
      hasNext = d.products.pageInfo.hasNextPage;
      cursor = edges.length ? edges[edges.length - 1].cursor : null;
      paginas++;
    }

    const resultado = produtos.map(p => {
      const faltando = CANAIS.filter(c => !p[c.chave]).map(c => c.nome);
      return {
        id: p.id.replace('gid://shopify/Product/', ''),
        titulo: p.title,
        handle: p.handle,
        faltando,
      };
    });

    const comFalta = resultado.filter(p => p.faltando.length > 0);
    return new Response(JSON.stringify({
      total_produtos_ativos: produtos.length,
      total_com_canal_faltando: comFalta.length,
      canais_auditados: CANAIS.map(c => c.nome),
      produtos: todos ? resultado : comFalta,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
