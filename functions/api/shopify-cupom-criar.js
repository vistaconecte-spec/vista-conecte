/**
 * Cloudflare Pages Function: /api/shopify-cupom-criar
 * Cria um cupom de desconto por CÓDIGO (DiscountCodeBasic) — % OFF no pedido inteiro.
 * Diferente da escada CONECTA (shopify-escada.js), que é desconto AUTOMÁTICO por quantidade.
 *
 * GET  ?codigo=VIPVC&pct=5                    → dry-run (mostra o que seria criado)
 * POST { codigo, pct, confirmar:true, ... }   → cria de verdade
 *   Opcionais no body/query:
 *     titulo:        string   (padrão: "<codigo> <pct>% OFF")
 *     inicioEm:       ISO date (padrão: agora — nasce ATIVO)
 *     dias:           número   (padrão: sem data de fim)
 *     limiteUsos:     número   (padrão: sem limite)
 *     umPorCliente:   boolean  (padrão: true — 1 uso por cliente)
 *     minimoSubtotal: número   (padrão: sem mínimo)
 *
 * Segurança: nunca mexe em cupom existente, só cria novo (dá erro se o código já existe).
 */
const API_VERSION = '2024-10';

const Q_EXISTE = `
query($code: String!) {
  codeDiscountNodeByCode(code: $code) { id }
}`;

const MUTATION = `
mutation criar($d: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $d) {
    codeDiscountNode {
      id
      codeDiscount {
        ... on DiscountCodeBasic {
          title status startsAt endsAt
          codes(first: 1) { nodes { code } }
        }
      }
    }
    userErrors { field message }
  }
}`;

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
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

  let body = {};
  if (request.method === 'POST') { try { body = await request.json(); } catch (e) { body = {}; } }
  const qs = new URL(request.url).searchParams;
  const get = (nome) => (body[nome] != null ? body[nome] : qs.get(nome));

  const codigo = String(get('codigo') || '').trim().toUpperCase();
  const pct = Number(get('pct'));
  if (!codigo) return new Response(JSON.stringify({ erro: 'informe codigo' }), { status: 400, headers });
  if (!(pct > 0 && pct < 100)) return new Response(JSON.stringify({ erro: 'informe pct entre 0 e 100' }), { status: 400, headers });

  const titulo = get('titulo') || `${codigo} ${pct}% OFF`;
  const inicio = get('inicioEm') ? new Date(get('inicioEm')) : new Date();
  const dias = get('dias') != null ? Number(get('dias')) : 0;
  const fim = dias > 0 ? new Date(inicio.getTime() + dias * 86400000) : null;
  const limiteUsos = get('limiteUsos') != null ? Number(get('limiteUsos')) : null;
  const umPorCliente = get('umPorCliente') != null ? get('umPorCliente') === true || get('umPorCliente') === 'true' : true;
  const minimoSubtotal = get('minimoSubtotal') != null ? Number(get('minimoSubtotal')) : null;

  // Nunca sobrescreve: se o código já existe, para aqui (dry-run ou não).
  const existe = await gql(Q_EXISTE, { code: codigo });
  if (existe.errors) return new Response(JSON.stringify({ erro: 'GraphQL', detalhe: existe.errors }, null, 2), { status: 502, headers });
  if (existe.data?.codeDiscountNodeByCode) {
    return new Response(JSON.stringify({ erro: `o código "${codigo}" já existe — use /api/shopify-cupom-combina para editar` }, null, 2), { status: 409, headers });
  }

  const resumo = {
    loja: store, codigo, titulo, valor: `${pct}%`,
    comeca_em: inicio.toISOString(),
    termina_em: fim ? fim.toISOString() : 'sem data de fim',
    limite_de_usos: limiteUsos ?? 'sem limite',
    um_uso_por_cliente: umPorCliente,
    minimo_no_carrinho: minimoSubtotal ? `R$ ${minimoSubtotal}` : 'sem mínimo',
    combina_com: 'produto e frete sim; outro desconto de pedido (cupom/escada) não',
  };

  if (request.method !== 'POST' || body.confirmar !== true) {
    return new Response(JSON.stringify({ modo: 'dry-run — nada foi criado', ...resumo, como_criar: 'POST com {"confirmar":true}' }, null, 2), { headers });
  }

  const variaveis = {
    d: {
      title: titulo,
      code: codigo,
      startsAt: inicio.toISOString(),
      ...(fim ? { endsAt: fim.toISOString() } : {}),
      ...(limiteUsos ? { usageLimit: limiteUsos } : {}),
      appliesOncePerCustomer: umPorCliente,
      ...(minimoSubtotal ? { minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: String(minimoSubtotal) } } } : {}),
      customerSelection: { all: true },
      customerGets: { value: { percentage: pct / 100 }, items: { all: true } },
      // Mesma regra da escada CONECTA: não empilha com outro desconto de PEDIDO (cupom/escada),
      // mas deixa passar desconto de produto e de frete.
      combinesWith: { orderDiscounts: false, productDiscounts: true, shippingDiscounts: true },
    },
  };

  try {
    const criado = await gql(MUTATION, variaveis);
    if (criado.errors) return new Response(JSON.stringify({ erro: 'GraphQL', detalhe: criado.errors }, null, 2), { status: 502, headers });
    const r = criado.data?.discountCodeBasicCreate;
    const erros = r?.userErrors || [];
    if (erros.length) return new Response(JSON.stringify({ erro: 'userErrors', detalhe: erros }, null, 2), { status: 400, headers });

    const nd = r.codeDiscountNode;
    const d = nd?.codeDiscount || {};
    return new Response(JSON.stringify({
      modo: 'criado', ok: true, id: nd?.id,
      codigo: d.codes?.nodes?.[0]?.code, titulo: d.title, status: d.status,
      comeca: d.startsAt, termina: d.endsAt,
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e) }), { status: 500, headers });
  }
}
