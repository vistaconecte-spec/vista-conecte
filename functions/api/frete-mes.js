/**
 * Cloudflare Pages Function: /api/frete-mes (somente leitura)
 *
 * Lado "cobrado da cliente" do card FRETE DO MÊS (pedido da Bárbara, 18/09/2026: "o valor
 * que já gastamos em frete no mês pra ir acompanhando se tomamos prejuízo"). Lista os
 * pedidos pagos criados no mês com o que a cliente pagou de frete, o método, o peso e as
 * etiquetas de rastreio. O lado "custo real" vem da fatura da Loggi, que a tela importa
 * (planilha billing_invoice_report) e casa com estes pedidos pela etiqueta BLI_.
 *
 *   GET /api/frete-mes?mes=2026-09[&antes=2]
 *   → { mes, pedidos: [{ numero, criado_em, metodo, cobrado, peso_g, uf, cep, valor, pecas,
 *        retirada, enviado, etiquetas: [], nome, cidade }], gerado_em }
 *
 * Desde 08/10/2026 o custo real vem das etiquetas da Frenet (a Manu compra lá, não mais
 * direto na Loggi). A etiqueta de outubro pode ser de um pedido de agosto (peça feita sob
 * encomenda), por isso `antes=N` puxa também os N meses anteriores; e a tela casa
 * etiqueta com pedido pelo código de rastreio ou, sem ele, pelo `nome` da entrega.
 *
 * `cep` e `valor` (total pago) entraram em 19/09/2026 pra rotina semanal "frete cobrado x
 * custo" conseguir cotar na Frenet o preço de tabela de cada pedido (peso real + destino +
 * valor da NF) e medir quanto a loja bancou no fixo R$24,90 e no grátis acima de R$599.
 *
 * GraphQL leve (como shopify-tempo-liberacao): só os campos da conta, ~250 pedidos por
 * página, cabe nos 10 ms de CPU do plano grátis. `cobrado` é o preço COM desconto
 * (cupom de frete grátis zera), porque é o que entrou no caixa.
 */
const API_VERSION = '2024-04';

const num = v => Math.round((parseFloat(v) || 0) * 100) / 100;
const ehRetirada = titulo => /loja|retir/i.test(titulo || '');

/** Primeiro e último dia do mês "AAAA-MM" em Brasília, como a Shopify espera na busca. */
export function periodoDoMes(mes, antes = 0) {
  const m = /^(\d{4})-(\d{2})$/.exec(mes || '');
  if (!m) return null;
  const ano = +m[1], mm = +m[2];
  if (mm < 1 || mm > 12) return null;
  const voltas = Math.max(0, Math.min(3, parseInt(antes, 10) || 0));
  const iniAbs = ano * 12 + (mm - 1) - voltas;
  const ini = `${Math.floor(iniAbs / 12)}-${String(iniAbs % 12 + 1).padStart(2, '0')}-01`;
  const prox = mm === 12 ? `${ano + 1}-01-01` : `${m[1]}-${String(mm + 1).padStart(2, '0')}-01`;
  return { ini, prox };
}

export function normalizar(nos) {
  const lista = [];
  for (const o of nos || []) {
    if (o.cancelledAt) continue;
    if (!['PAID', 'PARTIALLY_REFUNDED'].includes(o.displayFinancialStatus)) continue;
    if (o.currentSubtotalLineItemsQuantity === 0) continue;
    const sl = o.shippingLine || {};
    const etiquetas = [];
    let enviado = false;
    for (const f of o.fulfillments || []) {
      if (f.status !== 'SUCCESS') continue;
      enviado = true;
      for (const t of f.trackingInfo || []) if (t.number) etiquetas.push(String(t.number).trim());
    }
    lista.push({
      numero: o.name,
      criado_em: o.processedAt || o.createdAt,
      metodo: sl.title || null,
      cobrado: num(sl.discountedPriceSet && sl.discountedPriceSet.shopMoney && sl.discountedPriceSet.shopMoney.amount),
      peso_g: Math.round(o.totalWeight || 0),
      uf: (o.shippingAddress && o.shippingAddress.provinceCode) || null,
      cep: ((o.shippingAddress && o.shippingAddress.zip) || '').replace(/\D/g, '') || null,
      valor: num(o.currentTotalPriceSet && o.currentTotalPriceSet.shopMoney && o.currentTotalPriceSet.shopMoney.amount),
      pecas: o.currentSubtotalLineItemsQuantity || 0,
      retirada: ehRetirada(sl.title),
      enviado,
      etiquetas,
      nome: (o.shippingAddress && o.shippingAddress.name) || null,
      cidade: (o.shippingAddress && o.shippingAddress.city) || null,
    });
  }
  return lista;
}

const QUERY = `query($cursor: String, $q: String) {
  orders(first: 250, after: $cursor, query: $q) {
    edges { cursor node {
      name createdAt processedAt cancelledAt displayFinancialStatus
      currentSubtotalLineItemsQuantity totalWeight
      currentTotalPriceSet { shopMoney { amount } }
      shippingLine { title discountedPriceSet { shopMoney { amount } } }
      shippingAddress { provinceCode zip name city }
      fulfillments(first: 3) { status trackingInfo { number } }
    } }
    pageInfo { hasNextPage }
  }
}`;

export async function buscarPedidos(store, token, mes, fetchFn = fetch, antes = 0) {
  const p = periodoDoMes(mes, antes);
  // Fuso de Brasília explícito: sem ele a Shopify corta o mês em UTC e um pedido das 22h
  // do dia 31 cai no mês seguinte.
  const q = `created_at:>='${p.ini}T00:00:00-03:00' AND created_at:<'${p.prox}T00:00:00-03:00'`;
  const nos = [];
  let cursor = null;
  for (let pagina = 0; pagina < 8; pagina++) {
    const r = await fetchFn(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { cursor, q } }),
    });
    if (!r.ok) throw new Error(`Shopify GraphQL: HTTP ${r.status}`);
    const j = await r.json();
    if (j.errors) throw new Error('GraphQL: ' + JSON.stringify(j.errors));
    const edges = j.data.orders.edges;
    for (const e of edges) nos.push(e.node);
    if (!j.data.orders.pageInfo.hasNextPage || !edges.length) break;
    cursor = edges[edges.length - 1].cursor;
  }
  return nos;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  const params = new URL(request.url).searchParams;
  const mes = params.get('mes') || new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 7);
  const antes = params.get('antes') || 0;
  if (!periodoDoMes(mes)) return new Response(JSON.stringify({ erro: 'mes inválido (AAAA-MM)' }), { status: 400, headers });
  try {
    const nos = await buscarPedidos(store, token, mes, fetch, antes);
    return new Response(JSON.stringify({ mes, pedidos: normalizar(nos), gerado_em: new Date().toISOString() }), { headers });
  } catch (err) {
    return new Response(JSON.stringify({ erro: err.message }), { status: 502, headers });
  }
}
