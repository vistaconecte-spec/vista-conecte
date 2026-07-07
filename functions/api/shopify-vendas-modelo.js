// GET /api/shopify-vendas-modelo?desde=YYYY-MM-DD&ate=YYYY-MM-DD
// Devolve as peças VENDIDAS por modelo, agrupadas por SEMANA (fecho domingo), + receita líquida e frete.
// Consumido pela aba Fluxo de Caixa: cada peça vendida vira custo de produção (tecido+corte+costura+frete).
//
// ⚠️ DRAFT — ANTES DE CONFIAR NO NÚMERO, VALIDAR/RECONCILIAR:
//   1. Domínio da loja + versão da API + nome do env do token → COPIAR do shopify-faturamento.js/shopify-orders.js
//      que já estão no projeto (aqui uso env.SHOPIFY_STORE e env.SHOPIFY_ADMIN_TOKEN como placeholders).
//   2. O matcher título→slug abaixo é uma RECONSTRUÇÃO dos aliases (memória custo-costura-triangulacao +
//      relatório jun/jul). O ideal é COLAR aqui o matcher validado do pipeline Python original.
//   3. CONJUNTO_PECAS: os conjuntos são expandidos no CLIENTE (main.js já tem o mapa). Esta function só
//      precisa devolver o slug do conjunto (ex.: 'conjunto-cozy'); o custo por peça é somado no cliente.
//
// Contrato de saída:
// { semanas: { 'YYYY-MM-DD'(domingo): { unidades, receita_liquida, frete, porModelo:{slug:qtd} } },
//   naoMapeados: [ { titulo, qtd } ], total_unidades, receita_liquida_total }

const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

// Aliases título(normalizado, sem acento, minúsculo) → slug do modelo. Ordem importa (mais específico primeiro).
const ALIASES = [
  [/casaco.*bear|sherpa.*ziper|sherpa.*bolso/, 'sherpa-ziper-bolsos'],
  [/moletom.*(cozy|mood)|moletom.*ziper|moletom.*bolso/, 'moletom-ziper-bolsos'],
  [/casaco.*xadrez|pele.*persa/, 'casaco-pele-persa'],
  [/casaco.*sherpa.*capuz/, 'casaco-sherpa-capuz'],
  [/casaco.*sherpa/, 'casaco-sherpa'],
  [/calca.*pantalona/, 'calca-pantalona'],
  [/calca.*flare/, 'calca-flare'],
  [/calca.*peace/, 'calca-peace'],
  [/calca.*bolso/, 'calca-bolso-frontal'],
  [/calca.*(basica|moletom)/, 'calca-basica-moletom'],
  [/macacao.*amplo/, 'macacao-amplo'],
  [/macacao.*(manga|longa)/, 'macacao-manga-longa'],
  [/macaquinho.*amplo/, 'macaquinho-amplo'],
  [/macaquinho.*ruel/, 'macaquinho-ruel'],
  [/moletom.*gola.*alta/, 'moletom-gola-alta'],
  [/vestido.*frente.*unica.*longo/, 'vestido-frente-unica-longo'],
  [/vestido.*frente.*unica.*curto/, 'vestido-frente-unica-curto'],
  [/vestido.*amplo/, 'vestido-amplo'],
  [/blusa.*canelad/, 'blusa-canelada'],
  [/saia.*midi/, 'saia-midi'],
  [/regata.*oversized/, 'regata-oversized'],
  [/camiseta.*oversized/, 'camiseta-oversized'],
  // conjuntos (o cliente expande em peças via CONJUNTO_PECAS)
  [/conjunto.*canelado/, 'conjunto-canelado'],
  [/conjunto.*(calca )?flare.*moletom/, 'conjunto-calca-flare-moletom'],
  [/conjunto.*pantalona.*moletom/, 'conjunto-calca-pantalona-moletom'],
  [/conjunto.*pantalona.*cropped/, 'conjunto-calca-pantalona-cropped'],
  [/conjunto.*wide/, 'conjunto-wide'],
  [/conjunto.*moletom.*saia/, 'conjunto-moletom-saia-midi'],
  [/conjunto.*canguru/, 'conjunto-canguru-longo'],
  [/conjunto.*cozy/, 'conjunto-cozy'],
  [/conjunto.*mood/, 'conjunto-mood'],
  [/conjunto.*peace/, 'conjunto-peace'],
  [/conjunto.*boho/, 'conjunto-boho'],
  [/conjunto.*regata.*mini.*saia/, 'conjunto-regata-mini-saia'],
  [/conjunto.*camiseta.*mini.*saia/, 'conjunto-camiseta-mini-saia'],
  [/conjunto.*(calca )?bolso.*camiseta/, 'conjunto-calca-bolso-camiseta'],
  [/conjunto.*pantalona.*blusa/, 'conjunto-pantalona-blusa'],
];

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function tituloParaSlug(titulo) {
  const t = norm(titulo);
  for (const [re, slug] of ALIASES) if (re.test(t)) return slug;
  // fallback: slugify direto (título → kebab) — pode não bater com o cadastro; vira "não mapeado" se sem custo
  return t.trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || null;
}

// domingo (fim de semana, seg–dom) da data — chave da semana
function domingoDaSemana(iso) {
  const d = new Date(iso + 'T12:00:00-03:00');
  const dow = d.getDay(); // 0=dom
  const add = (dow === 0) ? 0 : (7 - dow);
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}

// REGRA (Álvaro 06/07): só entram pedidos PAGOS. Excluir CANCELADOS e EXPIRADOS (ex.: PIX que expirou).
// Mesma regra do faturamento líquido (memória feedback-vista-faturamento-liquido).
// Aceita: paid, partially_refunded. Rejeita: cancelled_at≠null, expired, voided, pending, refunded(total), authorized.
const STATUS_OK = new Set(['paid', 'partially_refunded']);
export function pedidoConta(o) {
  if (!o) return false;
  if (o.cancelled_at) return false;                 // cancelado
  return STATUS_OK.has(o.financial_status || '');   // pago (ou parcialmente reembolsado); exclui expired/voided/pending/refunded
}

// Agrega pedidos → semanas (pura e testável). Abate quantidades e valores reembolsados (líquido).
export function agregarVendas(orders) {
  const semanas = {};
  let totalUn = 0, receitaTotal = 0;
  const get = dom => (semanas[dom] = semanas[dom] || { unidades: 0, receita_liquida: 0, frete: 0, porModelo: {} });
  for (const o of (orders || [])) {
    if (!pedidoConta(o)) continue;                  // ← aplica a regra: só pagos, sem cancelado/expirado
    const dom = domingoDaSemana((o.created_at || '').slice(0, 10));
    const s = get(dom);
    // qtd reembolsada por line_item (partially_refunded)
    const refQty = {};
    for (const rf of (o.refunds || [])) for (const rli of (rf.refund_line_items || [])) refQty[rli.line_item_id] = (refQty[rli.line_item_id] || 0) + (rli.quantity || 0);
    // receita líquida = total_price − reembolsos em dinheiro
    const reemb = (o.refunds || []).reduce((a, rf) => a + (rf.transactions || []).reduce((b, t) => b + (t.kind === 'refund' ? parseFloat(t.amount || 0) : 0), 0), 0);
    s.receita_liquida += parseFloat(o.total_price || 0) - reemb;
    receitaTotal += parseFloat(o.total_price || 0) - reemb;
    // frete real do pedido
    s.frete += (o.shipping_lines || []).reduce((a, sl) => a + parseFloat(sl.price || 0), 0);
    // itens (líquido de reembolso)
    for (const li of (o.line_items || [])) {
      const qtd = (li.quantity || 0) - (refQty[li.id] || 0);
      if (qtd <= 0) continue;
      const slug = tituloParaSlug(li.title || li.name);
      s.porModelo[slug] = (s.porModelo[slug] || 0) + qtd;
      s.unidades += qtd;
      totalUn += qtd;
    }
  }
  return { semanas, total_unidades: totalUn, receita_liquida_total: Math.round(receitaTotal * 100) / 100 };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const desde = url.searchParams.get('desde');
  const ate = url.searchParams.get('ate');
  const store = env.SHOPIFY_STORE_DOMAIN || env.SHOPIFY_STORE;  // ex.: 'vista-conecte.myshopify.com'
  const token = env.SHOPIFY_ADMIN_TOKEN;        // CONFERIR nome do env com as outras functions
  if (!store || !token) return J({ erro: 'SHOPIFY_STORE/SHOPIFY_ADMIN_TOKEN ausentes (conferir nomes com as outras functions)', semanas: {} }, 500);
  if (!desde || !ate) return J({ erro: 'faltam ?desde= e ?ate=', semanas: {} }, 400);

  // Puxa TODOS os pedidos do intervalo (status=any) e aplica a regra no código (pedidoConta):
  // só PAGOS, sem cancelados/expirados. Filtrar no código é mais robusto que o filtro da query.
  const orders = [];
  try {
    let pageUrl = `https://${store}/admin/api/2024-04/orders.json?status=any&created_at_min=${desde}T00:00:00-03:00&created_at_max=${ate}T23:59:59-03:00&limit=250`;
    let guard = 0;
    while (pageUrl && guard++ < 60) {
      const r = await fetch(pageUrl, { headers: { 'X-Shopify-Access-Token': token } });
      if (!r.ok) return J({ erro: 'Shopify ' + r.status, semanas: {} }, 502);
      const data = await r.json();
      orders.push(...(data.orders || []));
      const link = r.headers.get('Link') || '';
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      pageUrl = m ? m[1] : null;
    }
    const agg = agregarVendas(orders); // aplica a regra (pedidoConta) e abate reembolsos
    return J(Object.assign({ naoMapeados: [] }, agg));
  } catch (e) {
    return J({ erro: String(e), semanas: {} }, 502);
  }
}
