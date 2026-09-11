/**
 * Cloudflare Pages Function: /api/shopify-rascunhos (somente leitura)
 *
 * Vendas fechadas pelo SAC no WhatsApp: a Marcelly cria o pedido como RASCUNHO na
 * Shopify e manda o link de pagamento. Esta rota lista esses rascunhos para a aba
 * VENDAS do Atendimento (pedido da dona no grupo Sac/Expedição em 11/09/2026).
 *
 * Rascunho com total R$ 0 é TROCA (a peça sai sem cobrança) e fica de fora da conta,
 * mas a quantidade ocultada volta na resposta para a tela dizer que ela existe.
 *
 *   GET /api/shopify-rascunhos?desde=2026-09-01&ate=2026-09-30
 *   → { rascunhos: [...], quantidade, total, ocultos_zero, desde, ate }
 */
const API_VERSION = '2024-04';

const num = v => Math.round((parseFloat(v) || 0) * 100) / 100;

function nomeDoCliente(d) {
  const c = d.customer || {};
  const nome = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return nome || (d.shipping_address && d.shipping_address.name) || d.email || '';
}

// Lê a próxima página do cabeçalho Link da Shopify (rel="next"), ou null.
function proximaPagina(link) {
  const m = /<([^>]+)>;\s*rel="next"/.exec(link || '');
  return m ? m[1] : null;
}

export async function listarRascunhos(store, token, desdeISO, fetchFn = fetch) {
  const H = { 'X-Shopify-Access-Token': token };
  // updated_at_min e não created_at: a Shopify não filtra rascunho por data de criação, e
  // um rascunho antigo que virou pedido neste mês tem updated_at recente — ele interessa.
  let url = `https://${store}/admin/api/${API_VERSION}/draft_orders.json?limit=250&updated_at_min=${encodeURIComponent(desdeISO)}`;
  const todos = [];
  for (let pag = 0; url && pag < 6; pag++) {
    const r = await fetchFn(url, { headers: H });
    if (!r.ok) throw new Error(`Shopify draft_orders ${r.status}`);
    const j = await r.json();
    todos.push(...(j.draft_orders || []));
    url = proximaPagina(r.headers && r.headers.get ? r.headers.get('link') : null);
  }
  return todos;
}

// Situação dos pedidos gerados pelos rascunhos concluídos, em UMA chamada (ids em lote).
export async function situacaoDosPedidos(store, token, ids, fetchFn = fetch) {
  const out = {};
  for (let i = 0; i < ids.length; i += 200) {
    const lote = ids.slice(i, i + 200);
    const url = `https://${store}/admin/api/${API_VERSION}/orders.json?status=any&limit=250&fields=id,name,financial_status,fulfillment_status,cancelled_at&ids=${lote.join(',')}`;
    const r = await fetchFn(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (!r.ok) continue; // sem a situação a lista ainda serve
    for (const o of (await r.json()).orders || []) out[String(o.id)] = o;
  }
  return out;
}

export function montarLista(drafts, pedidos, desde, ate) {
  const noPeriodo = drafts.filter(d => {
    const c = String(d.created_at || '').slice(0, 10);
    return c >= desde && c <= ate;
  });
  const ocultosZero = noPeriodo.filter(d => num(d.total_price) <= 0).length;
  const rascunhos = noPeriodo
    .filter(d => num(d.total_price) > 0)
    .map(d => {
      const ped = d.order_id ? pedidos[String(d.order_id)] : null;
      return {
        id: d.id,
        numero: d.name,
        criado_em: d.created_at,
        cliente: nomeDoCliente(d),
        valor: num(d.total_price),
        status: d.status === 'completed' ? 'concluido' : 'aberto',
        pedido: d.order_id ? {
          id: d.order_id,
          numero: ped ? ped.name : null,
          pago: ped ? ped.financial_status === 'paid' : null,
          enviado: ped ? ped.fulfillment_status === 'fulfilled' : null,
          cancelado: ped ? !!ped.cancelled_at : null,
        } : null,
        itens: (d.line_items || []).map(li => ({ qtd: li.quantity, titulo: li.title, variante: li.variant_title || '' })),
      };
    })
    .sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)));
  const total = num(rascunhos.reduce((s, r) => s + r.valor, 0));
  return { rascunhos, quantidade: rascunhos.length, total, ocultos_zero: ocultosZero, desde, ate };
}

export async function onRequest(context) {
  const { env, request } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });

  const q = new URL(request.url).searchParams;
  const hoje = new Date().toISOString().slice(0, 10);
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(q.get('desde') || '') ? q.get('desde') : hoje.slice(0, 8) + '01';
  const ate   = /^\d{4}-\d{2}-\d{2}$/.test(q.get('ate') || '') ? q.get('ate') : hoje;

  try {
    // -03:00: a loja fecha o dia no horário de Brasília, não em UTC.
    const drafts = await listarRascunhos(store, token, `${desde}T00:00:00-03:00`);
    const ids = drafts.filter(d => d.order_id && num(d.total_price) > 0).map(d => d.order_id);
    const pedidos = ids.length ? await situacaoDosPedidos(store, token, ids) : {};
    return new Response(JSON.stringify(montarLista(drafts, pedidos, desde, ate)), { headers: H });
  } catch (err) {
    return new Response(JSON.stringify({ erro: err.message }), { status: 502, headers: H });
  }
}
