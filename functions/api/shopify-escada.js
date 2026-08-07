/**
 * Cloudflare Pages Function: /api/shopify-escada
 * Cria a escada de desconto progressivo por quantidade (CONECTA — "quanto mais peças, maior o desconto").
 * Usa DiscountAutomaticBasic com mínimo de QUANTIDADE — nativo, sem app.
 *
 * GET                      → mostra o que seria criado (dry-run) e os níveis padrão.
 * POST { confirmar:true }  → cria de verdade.
 *   Opcionais no body:
 *     niveis:   [{ qtd, pct }]  (padrão: 2→10%, 3→20%, 4→25%, 5→30%)
 *     inicioEm: ISO date        (padrão: amanhã 03:00 UTC — nasce AGENDADO, não ativo)
 *     dias:     número          (padrão: 7 — duração da campanha; 0 = sem data de fim)
 *     prefixo:  string          (padrão: 'CONECTA')
 *
 * Segurança: nunca mexe em descontos existentes, só cria novos.
 */
const API_VERSION = '2024-10';

const MUTATION = `
mutation criar($d: DiscountAutomaticBasicInput!) {
  discountAutomaticBasicCreate(automaticBasicDiscount: $d) {
    automaticDiscountNode { id automaticDiscount { ... on DiscountAutomaticBasic { title status startsAt endsAt } } }
    userErrors { field message }
  }
}`;

const NIVEIS_PADRAO = [
  { qtd: 2, pct: 10 },
  { qtd: 3, pct: 20 },
  { qtd: 4, pct: 25 },
  { qtd: 5, pct: 30 },
];

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });

  const store = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  let body = {};
  if (request.method === 'POST') { try { body = await request.json(); } catch (e) { body = {}; } }

  // Ação de reagendamento: muda só a data de início/fim dos descontos indicados.
  // Usada para testar o carrinho agora e depois devolver a data original.
  if (request.method === 'POST' && body.acao === 'reagendar') {
    if (!Array.isArray(body.ids) || !body.ids.length) {
      return new Response(JSON.stringify({ erro: 'informe ids: ["gid://shopify/DiscountAutomaticNode/..."]' }), { status: 400, headers });
    }
    const ini = body.inicioEm ? new Date(body.inicioEm) : new Date(Date.now() - 60000);
    const f = body.fimEm ? new Date(body.fimEm) : null;
    const MUT_UP = `
      mutation up($id: ID!, $d: DiscountAutomaticBasicInput!) {
        discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $d) {
          automaticDiscountNode { id automaticDiscount { ... on DiscountAutomaticBasic { title status startsAt endsAt } } }
          userErrors { field message }
        }
      }`;
    const out = [];
    for (const id of body.ids) {
      const res = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: MUT_UP, variables: { id, d: { startsAt: ini.toISOString(), ...(f ? { endsAt: f.toISOString() } : {}) } } }),
      });
      const data = await res.json();
      const r = data.data?.discountAutomaticBasicUpdate;
      const errs = r?.userErrors || [];
      const nd = r?.automaticDiscountNode?.automaticDiscount;
      out.push((data.errors || errs.length)
        ? { id, ok: false, erro: data.errors || errs }
        : { id, ok: true, titulo: nd?.title, status: nd?.status, comeca: nd?.startsAt, termina: nd?.endsAt });
    }
    return new Response(JSON.stringify({ modo: 'reagendado', resultado: out }, null, 2), { headers });
  }

  const niveis = Array.isArray(body.niveis) && body.niveis.length ? body.niveis : NIVEIS_PADRAO;
  const prefixo = body.prefixo || 'CONECTA';
  const dias = body.dias != null ? Number(body.dias) : 7;

  // Padrão: começa amanhã às 03:00 UTC → o desconto nasce AGENDADO, dá tempo de conferir antes de valer.
  let inicio;
  if (body.inicioEm) {
    inicio = new Date(body.inicioEm);
  } else {
    inicio = new Date();
    inicio.setUTCDate(inicio.getUTCDate() + 1);
    inicio.setUTCHours(3, 0, 0, 0);
  }
  const fim = dias > 0 ? new Date(inicio.getTime() + dias * 86400000) : null;

  const plano = niveis
    .map(n => ({ qtd: Number(n.qtd), pct: Number(n.pct) }))
    .filter(n => n.qtd >= 1 && n.pct > 0 && n.pct < 100)
    .sort((a, b) => a.qtd - b.qtd)
    .map(n => ({
      titulo: `${prefixo} ${n.qtd}+ peças — ${n.pct}% OFF`,
      minimo_itens: n.qtd,
      desconto: `${n.pct}%`,
      pct: n.pct,
      qtd: n.qtd,
    }));

  // Escada tem que ser crescente: se não for, o cliente é punido por levar mais.
  for (let i = 1; i < plano.length; i++) {
    if (plano[i].pct <= plano[i - 1].pct) {
      return new Response(JSON.stringify({
        erro: 'escada inválida: o desconto precisa crescer a cada nível',
        detalhe: `${plano[i - 1].qtd} peças = ${plano[i - 1].pct}% mas ${plano[i].qtd} peças = ${plano[i].pct}%`,
      }, null, 2), { status: 400, headers });
    }
  }

  const resumo = {
    loja: store,
    niveis: plano.map(p => ({ titulo: p.titulo, minimo_itens: p.minimo_itens, desconto: p.desconto })),
    comeca_em: inicio.toISOString(),
    termina_em: fim ? fim.toISOString() : 'sem data de fim',
    observacao: 'Nasce AGENDADO (início no futuro). Nenhum desconto existente é alterado ou removido.',
  };

  if (request.method !== 'POST' || !body.confirmar) {
    return new Response(JSON.stringify({ modo: 'dry-run — nada foi criado', ...resumo, como_criar: 'POST com {"confirmar":true}' }, null, 2), { headers });
  }

  const criados = [];
  try {
    for (const p of plano) {
      const variaveis = {
        d: {
          title: p.titulo,
          startsAt: inicio.toISOString(),
          ...(fim ? { endsAt: fim.toISOString() } : {}),
          minimumRequirement: { quantity: { greaterThanOrEqualToQuantity: String(p.qtd) } },
          customerGets: {
            value: { percentage: p.pct / 100 },
            items: { all: true },
          },
          // Não combina com outros descontos de pedido; permite cupom de produto e frete.
          combinesWith: { orderDiscounts: false, productDiscounts: true, shippingDiscounts: true },
        },
      };
      const res = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: MUTATION, variables: variaveis }),
      });
      const data = await res.json();
      const r = data.data?.discountAutomaticBasicCreate;
      const erros = r?.userErrors || [];
      if (data.errors || erros.length) {
        criados.push({ titulo: p.titulo, ok: false, erro: data.errors || erros });
      } else {
        const nd = r.automaticDiscountNode;
        criados.push({
          titulo: p.titulo, ok: true, id: nd?.id,
          status: nd?.automaticDiscount?.status,
          comeca: nd?.automaticDiscount?.startsAt,
          termina: nd?.automaticDiscount?.endsAt,
        });
      }
    }
    const falhas = criados.filter(c => !c.ok).length;
    return new Response(JSON.stringify({
      modo: 'criado',
      criados_ok: criados.length - falhas,
      falhas,
      resultado: criados,
      proximo_passo: 'Confira no admin (Descontos) e teste um carrinho com 2, 3, 4 e 5 peças antes de adiantar a data de início.',
    }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e), criados }, null, 2), { status: 500, headers });
  }
}
