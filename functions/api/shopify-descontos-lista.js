/**
 * Cloudflare Pages Function: /api/shopify-descontos-lista (somente leitura)
 * Lista os descontos automáticos e por código da loja, com tipo, status e regras.
 * Serve pra saber o que já existe antes de criar a escada progressiva (CONECTA 2).
 */
const API_VERSION = '2024-10';

const QUERY = `
query {
  automaticDiscountNodes(first: 50) {
    nodes {
      id
      automaticDiscount {
        __typename
        ... on DiscountAutomaticBasic {
          title status startsAt endsAt
          minimumRequirement {
            __typename
            ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
            ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } }
          }
          customerGets {
            value {
              __typename
              ... on DiscountPercentage { percentage }
              ... on DiscountAmount { amount { amount } }
            }
            items { __typename ... on AllDiscountItems { allItems } }
          }
          combinesWith { orderDiscounts productDiscounts shippingDiscounts }
        }
        ... on DiscountAutomaticBxgy {
          title status startsAt endsAt usesPerOrderLimit
          combinesWith { orderDiscounts productDiscounts shippingDiscounts }
        }
        ... on DiscountAutomaticApp {
          title status startsAt endsAt appDiscountType { functionId title }
          combinesWith { orderDiscounts productDiscounts shippingDiscounts }
        }
      }
    }
  }
  codeDiscountNodes(first: 30, query: "status:active") {
    nodes {
      id
      codeDiscount {
        __typename
        ... on DiscountCodeBasic {
          title status
          codes(first: 3) { nodes { code } }
          customerGets { value { __typename ... on DiscountPercentage { percentage } } }
          combinesWith { orderDiscounts productDiscounts shippingDiscounts }
        }
      }
    }
  }
}`;

export async function onRequest(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const store = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  try {
    const res = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY }),
    });
    const data = await res.json();
    if (data.errors) return new Response(JSON.stringify({ erro: 'GraphQL', detalhe: data.errors }, null, 2), { status: 502, headers });

    const aut = (data.data?.automaticDiscountNodes?.nodes || []).map(n => {
      const d = n.automaticDiscount || {};
      const v = d.customerGets?.value || {};
      return {
        id: n.id,
        tipo: d.__typename,
        titulo: d.title,
        status: d.status,
        minimo: d.minimumRequirement
          ? (d.minimumRequirement.greaterThanOrEqualToQuantity
              ? `${d.minimumRequirement.greaterThanOrEqualToQuantity} itens`
              : `R$ ${d.minimumRequirement.greaterThanOrEqualToSubtotal?.amount}`)
          : null,
        valor: v.percentage != null ? `${(v.percentage * 100).toFixed(0)}%` : (v.amount?.amount ? `R$ ${v.amount.amount}` : null),
        function_id: d.appDiscountType?.functionId || null,
        app: d.appDiscountType?.title || null,
        combina: d.combinesWith || null,
      };
    });
    const cod = (data.data?.codeDiscountNodes?.nodes || []).map(n => {
      const d = n.codeDiscount || {};
      return {
        id: n.id,
        tipo: d.__typename,
        titulo: d.title,
        status: d.status,
        codigos: (d.codes?.nodes || []).map(c => c.code),
        valor: d.customerGets?.value?.percentage != null ? `${(d.customerGets.value.percentage * 100).toFixed(0)}%` : null,
        combina: d.combinesWith || null,
      };
    });

    return new Response(JSON.stringify({
      automaticos: aut.length, por_codigo: cod.length,
      descontos_automaticos: aut, descontos_por_codigo: cod,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e) }), { status: 500, headers });
  }
}
