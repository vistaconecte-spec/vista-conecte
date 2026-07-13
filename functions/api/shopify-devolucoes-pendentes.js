/**
 * Cloudflare Pages Function: /api/shopify-devolucoes-pendentes (somente leitura)
 * Lista as devoluções com status "solicitada" (ainda não processadas) de toda a loja,
 * uma linha por peça — usado pra alimentar automaticamente a aba Devolução do Atendimento.
 */
const API_VERSION = '2024-04';

const MOTIVOS = {
  SIZE_TOO_SMALL: 'Tamanho pequeno',
  SIZE_TOO_LARGE: 'Muito grande',
  UNWANTED: 'Não quis mais',
  NOT_AS_DESCRIBED: 'Item diferente da descrição',
  WRONG_ITEM: 'Item errado',
  DEFECTIVE: 'Defeito',
  STYLE: 'Estilo não agradou',
  COLOR: 'Cor não agradou',
  OTHER: 'Outro',
  UNKNOWN: 'Não informado',
};

export async function onRequest(context) {
  const { env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });

  try {
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query {
          orders(first: 50, query: "return_status:RETURN_REQUESTED", sortKey: CREATED_AT, reverse: true) {
            nodes {
              name
              shippingAddress { name }
              returns(first: 10) {
                nodes {
                  id name status createdAt
                  returnLineItems(first: 20) {
                    nodes {
                      ... on ReturnLineItem {
                        id quantity returnReason returnReasonNote
                        withCodeDiscountedTotalPriceSet { presentmentMoney { amount currencyCode } }
                        fulfillmentLineItem { lineItem { title variantTitle } }
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
      }),
    });
    const j = await r.json();
    if (j.errors) return new Response(JSON.stringify({ erro: 'Shopify GraphQL', detalhe: j.errors }), { status: 502, headers: H });

    const linhas = [];
    for (const o of (j.data?.orders?.nodes || [])) {
      for (const ret of (o.returns?.nodes || [])) {
        if (ret.status !== 'REQUESTED') continue; // já processada — não repete aqui
        for (const li of (ret.returnLineItems?.nodes || [])) {
          const preco = li.withCodeDiscountedTotalPriceSet?.presentmentMoney;
          linhas.push({
            id: li.id, // gid://shopify/ReturnLineItem/... — usado como chave única, evita duplicar
            pedido: o.name,
            cliente: o.shippingAddress?.name || null,
            peca: `${li.quantity}× ${li.fulfillmentLineItem?.lineItem?.title || '?'}${li.fulfillmentLineItem?.lineItem?.variantTitle ? ' (' + li.fulfillmentLineItem.lineItem.variantTitle + ')' : ''}`,
            valor: preco ? parseFloat(preco.amount) : null,
            motivo: MOTIVOS[li.returnReason] || li.returnReason,
            motivo_nota: li.returnReasonNote || null,
            codigo_devolucao: ret.name, // ex: #8153-R1 — referência da devolução na Shopify
            data: ret.createdAt,
          });
        }
      }
    }
    return new Response(JSON.stringify({ total: linhas.length, devolucoes: linhas }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
