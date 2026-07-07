/**
 * Cloudflare Pages Function: /api/shopify-status
 * Altera o status (active/draft/archived) de UM produto pelo id.
 *   ?id=123                      → dry-run: mostra status atual
 *   ?id=123&status=active        → dry-run do que mudaria
 *   ?id=123&status=active&apply=1 → aplica de verdade
 */
const API_VERSION = '2024-04';
const VALIDOS = ['active', 'draft', 'archived'];

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  const qs = new URL(request.url).searchParams;
  const id = (qs.get('id') || '').trim();
  const status = (qs.get('status') || 'active').trim();
  const apply = qs.get('apply') === '1';
  const publishParam = qs.get('publish'); // '1' publica na Loja Online, '0' despublica, ausente = não mexe
  if (!id) return new Response(JSON.stringify({ erro: 'informe ?id=' }), { status: 400, headers });
  if (!VALIDOS.includes(status)) return new Response(JSON.stringify({ erro: 'status inválido', validos: VALIDOS }), { status: 400, headers });

  const base = `https://${store}/admin/api/${API_VERSION}/products/${id}.json`;
  try {
    const get = await fetch(base + '?fields=id,title,status,handle,published_at,published_scope', { headers: { 'X-Shopify-Access-Token': token } });
    if (!get.ok) return new Response(JSON.stringify({ erro: `Shopify ${get.status}`, detalhe: (await get.text()).slice(0, 200) }), { status: 502, headers });
    const atual = (await get.json()).product;

    let resultado = 'dry-run (nada escrito)';
    if (apply) {
      const body = { id: Number(id) };
      if (atual.status !== status) body.status = status;
      if (publishParam === '1') body.published = true;
      else if (publishParam === '0') body.published = false;
      if (Object.keys(body).length > 1) {
        const put = await fetch(base, {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ product: body }),
        });
        resultado = put.ok ? 'aplicado' : `falha ${put.status}: ${(await put.text()).slice(0, 200)}`;
      } else {
        resultado = 'nada a mudar (já estava assim)';
      }
    }

    return new Response(JSON.stringify({
      produto: atual.title, id: atual.id, handle: atual.handle,
      link_loja: `https://${store}/products/${atual.handle}`,
      link_admin: `https://${store}/admin/products/${atual.id}`,
      status_atual: atual.status, status_desejado: status,
      published_at: atual.published_at, published_scope: atual.published_scope,
      publish_param: publishParam,
      modo: apply ? 'APLICAR' : 'dry-run', resultado,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
