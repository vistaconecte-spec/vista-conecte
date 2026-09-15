/**
 * Cloudflare Pages Function: /api/shopify-tempo-liberacao (somente leitura)
 *
 * Quanto tempo o pedido leva do pagamento ao envio, em DIAS ÚTEIS. Alimenta o card
 * TEMPO DE LIBERAÇÃO do painel (pedido da Bárbara, 15/09/2026: "é legal ir acompanhando").
 *
 * Fonte: GraphQL da Shopify, e não a REST de /api/shopify-orders. A REST devolve os
 * fulfillments com line_items dentro (1,3 MB para 60 dias); aqui só entram nome, datas,
 * status, frete e a data de cada remessa (~200 KB), o que cabe folgado nos 10 ms de CPU
 * do plano gratuito (ver o histórico do erro 1102 em shopify-orders.js).
 *
 * Regras:
 *   - Só pedido PAGO (ou parcialmente estornado) e não cancelado. Pedido "cancelado na
 *     prática" (todos os itens removidos por edição, nota "CANCELADO NÃO QUIS ESPERAR",
 *     mas sem cancelamento formal, como #5996/#6617/#7653) também sai: a Shopify o marca
 *     como unfulfilled para sempre e ele ficaria eterno como "mais antigo da fila".
 *   - "Liberado" = primeira remessa com status SUCCESS na Shopify, a mesma fonte dos
 *     mini-cards LIBERADOS HOJE / NA SEMANA e da baixa de estoque.
 *   - Retirada em loja ("Loja Conecte") fica fora: não passa pela expedição.
 *   - O relógio começa em processedAt (a Shopify só cria o pedido de Pix quando ele é
 *     pago, então pagamento e criação são a mesma hora; conferido em 15/09/2026).
 *   - Dia útil: segunda a sexta, fora os feriados nacionais da lista abaixo. Mesmo dia = 0;
 *     pago na sexta e enviado na segunda = 1. Dias contados no fuso de Brasília (UTC-3
 *     fixo, sem horário de verão desde 2019).
 *   - As janelas (7 e 30 dias) são pela data de ENVIO (quem saiu nesse período, quanto
 *     levou). Pela data de pagamento a conta engana: nos dias recentes só saiu quem tinha
 *     peça pronta, e a média parece cair enquanto o resto ainda espera na fila.
 */
const API_VERSION = '2024-04';
const DIA_MS = 86400000;
const FUSO_MS = 3 * 3600000; // Brasília = UTC-3, fixo

// Feriados nacionais (não entram na conta de dias úteis)
const FERIADOS = [
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-04-03', '2026-04-21', '2026-05-01',
  '2026-06-04', '2026-09-07', '2026-10-12', '2026-11-02', '2026-11-15', '2026-11-20', '2026-12-25',
  '2027-01-01', '2027-02-08', '2027-02-09', '2027-03-26', '2027-04-21', '2027-05-01',
  '2027-05-27', '2027-09-07', '2027-10-12', '2027-11-02', '2027-11-15', '2027-11-20', '2027-12-25',
];
const FERIADOS_DIA = new Set(FERIADOS.map(s => Math.floor(Date.parse(s + 'T00:00:00Z') / DIA_MS)));

/** Número do dia (dias desde 1970) no fuso de Brasília. */
export function diaLocal(iso) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  return Math.floor((t - FUSO_MS) / DIA_MS);
}

/** Dia da semana do número do dia: 0 = domingo ... 6 = sábado (1970-01-01 foi quinta). */
const diaDaSemana = dia => (dia + 4) % 7;

export function ehDiaUtil(dia) {
  const w = diaDaSemana(dia);
  return w !== 0 && w !== 6 && !FERIADOS_DIA.has(dia);
}

/** Dias úteis entre dois instantes: conta os dias úteis DEPOIS do dia de `a` até o dia de `b`. */
export function diasUteisEntre(a, b) {
  const da = diaLocal(a), db = diaLocal(b);
  if (db <= da) return 0;
  return acumulado(db) - acumulado(da);
}

// Dias úteis acumulados desde a BASE, montados uma vez por isolate. Somar dia a dia por
// pedido (800 pedidos × até 60 dias) custava ~5 ms no primeiro acesso, metade do limite de
// CPU da função; com a tabela cada pedido vira duas leituras de array.
const BASE = Math.floor(Date.parse('2025-01-01T00:00:00Z') / DIA_MS);
const ACUM = [0];
function acumulado(dia) {
  if (dia < BASE) return 0;
  while (ACUM.length <= dia - BASE) ACUM.push(ACUM[ACUM.length - 1] + (ehDiaUtil(BASE + ACUM.length) ? 1 : 0));
  return ACUM[dia - BASE];
}

const ehRetirada = titulo => /loja|retir/i.test(titulo || '');

/**
 * Normaliza os nós do GraphQL para o mínimo que a conta precisa:
 * { numero, pago_em, enviado_em|null, retirada }. Cancelados, não pagos e retirada saem.
 */
export function normalizar(nos) {
  const lista = [];
  for (const o of nos || []) {
    if (o.cancelledAt) continue;
    if (!['PAID', 'PARTIALLY_REFUNDED'].includes(o.displayFinancialStatus)) continue;
    if (ehRetirada(o.shippingLine && o.shippingLine.title)) continue;
    if (o.currentSubtotalLineItemsQuantity === 0) continue; // itens todos removidos por edição
    let enviado = null;
    for (const f of o.fulfillments || []) {
      if (f.status !== 'SUCCESS') continue;
      if (!enviado || f.createdAt < enviado) enviado = f.createdAt;
    }
    lista.push({ numero: o.name, pago_em: o.processedAt || o.createdAt, enviado_em: enviado });
  }
  return lista;
}

const media = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
const mediana = arr => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const arred = v => v == null ? null : Math.round(v * 10) / 10;

/**
 * Resumo para o card. `agora` é injetável para os testes.
 *
 *   enviados: { d7: {n, media, mediana, corridos}, d30: {...} }  → dias úteis do pagamento ao envio
 *   faixas:   distribuição dos enviados em 30 dias (até 2 / 3 a 5 / 6 a 10 / 11+ dias úteis)
 *   fila:     pagos ainda sem envio: quantos, há quantos dias úteis esperam, o mais antigo
 */
export function resumir(pedidos, agora = Date.now()) {
  // Uma passada só, com as datas convertidas uma vez por pedido. Com ~800 pedidos, filtrar
  // a lista várias vezes com Date.parse dentro custava metade dos 10 ms de CPU da função
  // no primeiro acesso.
  const d7 = [], d30 = [];
  const faixas = { ate2: 0, de3a5: 0, de6a10: 0, mais11: 0 };
  let corr7 = 0, corr30 = 0;
  const filaUteis = [];
  let antigo = null;

  for (const p of pedidos) {
    const pagoTs = Date.parse(p.pago_em);
    if (!p.enviado_em) {
      const uteis = diasUteisEntre(pagoTs, agora), corridos = (agora - pagoTs) / DIA_MS;
      filaUteis.push(uteis);
      if (!antigo || corridos > antigo.corridos) antigo = { numero: p.numero, uteis, corridos };
      continue;
    }
    const envTs = Date.parse(p.enviado_em);
    const uteis = diasUteisEntre(pagoTs, envTs), corridos = (envTs - pagoTs) / DIA_MS;
    if (envTs >= agora - 7 * DIA_MS) { d7.push(uteis); corr7 += corridos; }
    if (envTs >= agora - 30 * DIA_MS) {
      d30.push(uteis); corr30 += corridos;
      if (uteis <= 2) faixas.ate2++;
      else if (uteis <= 5) faixas.de3a5++;
      else if (uteis <= 10) faixas.de6a10++;
      else faixas.mais11++;
    }
  }

  const stats = (lista, corr) => ({
    n: lista.length, media: arred(media(lista)), mediana: mediana(lista),
    corridos: lista.length ? arred(corr / lista.length) : null,
  });

  return {
    enviados: { d7: stats(d7, corr7), d30: stats(d30, corr30) },
    faixas,
    fila: {
      n: filaUteis.length,
      media: arred(media(filaUteis)),
      mais_antigo: antigo ? { numero: antigo.numero, uteis: antigo.uteis, corridos: Math.round(antigo.corridos) } : null,
    },
    gerado_em: new Date(agora).toISOString(),
  };
}

const QUERY = `query($cursor: String, $q: String) {
  orders(first: 250, after: $cursor, query: $q) {
    edges { cursor node {
      name createdAt processedAt cancelledAt displayFinancialStatus
      currentSubtotalLineItemsQuantity
      shippingLine { title }
      fulfillments(first: 3) { createdAt status }
    } }
    pageInfo { hasNextPage }
  }
}`;

/**
 * Lê da Shopify os pedidos criados nos últimos `dias` MAIS os ainda em aberto e sem envio
 * de qualquer data (o #8564, de julho, seguia na fila em setembro; sem isto ele sumiria da
 * conta e o "mais antigo" mentiria). 60 dias porque a janela é de 30 dias de ENVIO e o
 * pedido mais lento levou 50 dias corridos: com menos, a janela perderia justamente os
 * lentos. São 3 páginas de 250 (~70 KB cada). `fetchFn` é injetável para os testes.
 */
export async function buscarPedidos(store, token, dias = 60, fetchFn = fetch, agora = Date.now()) {
  const desde = new Date(agora - dias * DIA_MS).toISOString().slice(0, 10);
  const q = `created_at:>=${desde} OR (fulfillment_status:unfulfilled AND status:open)`;
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

export async function onRequest(context) {
  const { env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  try {
    const nos = await buscarPedidos(store, token);
    return new Response(JSON.stringify(resumir(normalizar(nos))), { headers });
  } catch (err) {
    return new Response(JSON.stringify({ erro: err.message }), { status: 502, headers });
  }
}
