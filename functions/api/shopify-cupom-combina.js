/**
 * Cloudflare Pages Function: /api/shopify-cupom-combina
 * Lê e ajusta as regras de COMBINAÇÃO (combinesWith) de um cupom por código.
 * Busca pelo código exato (codeDiscountNodeByCode) — a lista geral só traz os 30
 * primeiros e cupons como o PRIMEIRACOMPRA ficam de fora.
 *
 *   GET  ?codigo=PRIMEIRACOMPRA
 *        -> tipo, status, valor e combinesWith atual
 *   POST { codigo, orderDiscounts, productDiscounts, shippingDiscounts, confirmar }
 *        -> dry-run por padrão (mostra antes/depois); só grava com confirmar:true
 *        -> os flags omitidos são preservados como estão hoje
 *
 * Só mexe no cupom informado. Nunca toca em desconto automático (escada CONECTA).
 */
const API_VERSION = '2024-10';

const Q_LER = `
query($code: String!) {
  codeDiscountNodeByCode(code: $code) {
    id
    codeDiscount {
      __typename
      ... on DiscountCodeBasic {
        title status startsAt endsAt
        codes(first: 5) { nodes { code } }
        customerGets { value { __typename ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount } } } }
        combinesWith { orderDiscounts productDiscounts shippingDiscounts }
      }
    }
  }
}`;

const M_GRAVAR = `
mutation($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode {
      id
      codeDiscount {
        ... on DiscountCodeBasic {
          title status
          combinesWith { orderDiscounts productDiscounts shippingDiscounts }
        }
      }
    }
    userErrors { field message }
  }
}`;

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });

  const store = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  const gql = async (query, variables) => {
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    return r.json();
  };

  const resumo = (node) => {
    const d = node.codeDiscount || {};
    const v = d.customerGets?.value || {};
    return {
      id: node.id,
      tipo: d.__typename,
      titulo: d.title,
      status: d.status,
      codigos: (d.codes?.nodes || []).map(c => c.code),
      valor: v.percentage != null ? `${(v.percentage * 100).toFixed(0)}%` : (v.amount?.amount ? `R$ ${v.amount.amount}` : null),
      combina: d.combinesWith || null,
    };
  };

  try {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json() : {};
    const codigo = ((request.method === 'POST' ? body.codigo : url.searchParams.get('codigo')) || '').trim();
    if (!codigo) return new Response(JSON.stringify({ erro: 'informe o código do cupom', uso: 'GET ?codigo=PRIMEIRACOMPRA' }), { status: 400, headers });

    const lido = await gql(Q_LER, { code: codigo });
    if (lido.errors) return new Response(JSON.stringify({ erro: 'GraphQL', detalhe: lido.errors }, null, 2), { status: 502, headers });
    const node = lido.data?.codeDiscountNodeByCode;
    if (!node) return new Response(JSON.stringify({ erro: `cupom "${codigo}" não encontrado` }), { status: 404, headers });

    const atual = resumo(node);
    if (request.method === 'GET') return new Response(JSON.stringify(atual, null, 2), { headers });

    if (atual.tipo !== 'DiscountCodeBasic') {
      return new Response(JSON.stringify({ erro: `só sei editar DiscountCodeBasic; este é ${atual.tipo}`, atual }, null, 2), { status: 400, headers });
    }

    const flag = (nome) => (typeof body[nome] === 'boolean' ? body[nome] : atual.combina?.[nome]);
    const novo = {
      orderDiscounts: flag('orderDiscounts'),
      productDiscounts: flag('productDiscounts'),
      shippingDiscounts: flag('shippingDiscounts'),
    };
    const mudou = Object.keys(novo).filter(k => novo[k] !== atual.combina?.[k]);

    if (body.confirmar !== true) {
      return new Response(JSON.stringify({
        modo: 'dry-run (nada gravado)',
        cupom: atual.codigos, titulo: atual.titulo, status: atual.status, valor: atual.valor,
        antes: atual.combina, depois: novo, campos_que_mudam: mudou,
        dica: 'reenvie com confirmar:true',
      }, null, 2), { headers });
    }
    if (mudou.length === 0) {
      return new Response(JSON.stringify({ ok: true, msg: 'nada a mudar — já estava assim', combina: atual.combina }, null, 2), { headers });
    }

    const gravado = await gql(M_GRAVAR, { id: atual.id, basicCodeDiscount: { combinesWith: novo } });
    if (gravado.errors) return new Response(JSON.stringify({ erro: 'GraphQL', detalhe: gravado.errors }, null, 2), { status: 502, headers });
    const ue = gravado.data?.discountCodeBasicUpdate?.userErrors || [];
    if (ue.length) return new Response(JSON.stringify({ erro: 'userErrors', detalhe: ue }, null, 2), { status: 400, headers });

    const dep = gravado.data?.discountCodeBasicUpdate?.codeDiscountNode?.codeDiscount || {};
    return new Response(JSON.stringify({
      ok: true, cupom: atual.codigos, titulo: dep.title, status: dep.status,
      antes: atual.combina, depois: dep.combinesWith, campos_alterados: mudou,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e) }), { status: 500, headers });
  }
}
