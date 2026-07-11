/**
 * Cloudflare Pages Function: /api/shopify-introspect-enum
 * Diagnóstico only-leitura: consulta o schema GraphQL da Shopify pra listar os valores
 * válidos de um enum (não executa mutation nenhuma, é introspection pura).
 *   ?tipo=ProductOptionUpdateVariantStrategy
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });

  const tipo = (new URL(request.url).searchParams.get('tipo') || '').trim();
  if (!tipo) return new Response(JSON.stringify({ erro: 'informe ?tipo=' }), { status: 400, headers: H });

  try {
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($tipo: String!) { __type(name: $tipo) { name kind enumValues { name description } inputFields { name type { name kind ofType { name } } } } }`,
        variables: { tipo },
      }),
    });
    const j = await r.json();
    return new Response(JSON.stringify(j, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
