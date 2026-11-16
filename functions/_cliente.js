// Painel "Pedido" ao lado da conversa no app Vi Atendimento (etapa 2, 16/11/2026).
// Pedido da Bárbara: ver pedido, pagamento, envio, rastreio e prazo sem trocar de aba.
//
// Como acha os pedidos: pela CLIENTE da Shopify com o telefone da conversa (com e sem o 9). A busca
// de pedidos da Shopify ignora o filtro de telefone (devolve qualquer pedido); a de clientes não.
// Uma consulta GraphQL só, com os últimos pedidos de cada conta (a mesma pessoa pode ter duas
// contas, como a Barbara do #9178). Só leitura.
import { variantes } from './_whatsapp.js';
import { prazoDoPedido, brt } from './_casos.js';

const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
const API_SHOPIFY = '2024-10';
export const MAX_PEDIDOS = 6;

const CONSULTA = `query($q:String!){ customers(first:4, query:$q){ nodes{ displayName email
  orders(first:6, sortKey:CREATED_AT, reverse:true){ nodes{ name createdAt processedAt cancelledAt
    displayFinancialStatus displayFulfillmentStatus tags
    totalPriceSet{ shopMoney{ amount } }
    lineItems(first:15){ nodes{ quantity title variantTitle } }
    fulfillments(first:5){ createdAt trackingInfo(first:2){ number company url } } } } } } }`;

// Telefone da conversa (com 55) nas grafias que a busca de clientes da Shopify entende.
export function buscaPorTelefone(tel) {
  return variantes(tel).filter(v => v.length >= 12).map(v => `phone:+${v}`).join(' OR ');
}

const PAGAMENTO = { PAID: 'pago', PENDING: 'aguardando pagamento', AUTHORIZED: 'autorizado', PARTIALLY_PAID: 'pago em parte',
  REFUNDED: 'estornado', PARTIALLY_REFUNDED: 'estorno parcial', VOIDED: 'cancelado', EXPIRED: 'expirado' };
const ENVIO = { FULFILLED: 'enviado', UNFULFILLED: 'não enviado', PARTIALLY_FULFILLED: 'enviado em parte',
  IN_PROGRESS: 'em separação', ON_HOLD: 'em espera', SCHEDULED: 'agendado', OPEN: 'não enviado', RESTOCKED: 'devolvido ao estoque' };

const dataBR = iso => iso ? new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(0, 10).split('-').reverse().join('/') : null;

// Clientes da Shopify (consulta acima) → lista curta para a tela, mais novo primeiro, sem repetir.
export function resumirPedidos(clientes, agora = Date.now()) {
  const vistos = new Set();
  const pedidos = [];
  for (const c of clientes || []) {
    for (const o of ((c.orders || {}).nodes || [])) {
      if (vistos.has(o.name)) continue;
      vistos.add(o.name);
      const fin = o.displayFinancialStatus, ful = o.displayFulfillmentStatus;
      const pago = fin === 'PAID' || fin === 'PARTIALLY_REFUNDED';
      const envios = (o.fulfillments || []).flatMap(f => (f.trackingInfo || []).map(t => ({ codigo: t.number, transportadora: t.company, url: t.url, em: dataBR(f.createdAt) })))
        .filter(t => t.codigo);
      const enviadoEm = (o.fulfillments || [])[0] && o.fulfillments[0].createdAt;
      const prazo = pago && !o.cancelledAt ? prazoDoPedido(o.processedAt || o.createdAt, agora, enviadoEm || null) : null;
      pedidos.push({
        numero: o.name, criado_em: o.createdAt, data: dataBR(o.createdAt),
        total: Number((o.totalPriceSet && o.totalPriceSet.shopMoney.amount) || 0),
        pagamento: PAGAMENTO[fin] || String(fin || '').toLowerCase(),
        envio: o.cancelledAt ? 'cancelado' : (ENVIO[ful] || String(ful || '').toLowerCase()),
        itens: ((o.lineItems || {}).nodes || []).map(i => `${i.quantity}x ${i.title}${i.variantTitle ? ' (' + i.variantTitle + ')' : ''}`),
        rastreio: envios,
        troca: (o.tags || []).some(t => /^troca/i.test(t)),
        prazo: prazo && !enviadoEm ? { dias_uteis: prazo.dias_uteis_desde_pagamento, de: prazo.prazo_dias_uteis, atrasado: prazo.passou_do_prazo }
          : prazo && enviadoEm ? { saiu_em_dias_uteis: prazo.dias_uteis_ate_envio, no_prazo: prazo.saiu_no_prazo } : null,
      });
    }
  }
  pedidos.sort((a, b) => (a.criado_em < b.criado_em ? 1 : -1));
  return pedidos.slice(0, MAX_PEDIDOS);
}

export async function painelCliente(env, tel, agora = Date.now()) {
  const v = variantes(tel);
  if (!v[0] || v[0].length < 10) return { status: 400, erro: 'telefone inválido' };
  const k = env.SUPABASE_SERVICE_ROLE_KEY;
  const [shop, casos] = await Promise.all([
    fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${API_SHOPIFY}/graphql.json`, {
      method: 'POST', headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: CONSULTA, variables: { q: buscaPorTelefone(tel) } }),
    }).then(r => r.json()).catch(e => ({ errors: [{ message: e.message }] })),
    fetch(`${SB_URL}/rest/v1/wati_sac_casos?wa_id=in.(${v.join(',')})&status=eq.aberto&order=criado_at.desc&limit=3&select=id,tipo,resumo,pedido,criado_at,responsavel`,
      { headers: { apikey: k, Authorization: 'Bearer ' + k } }).then(r => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  const clientes = (shop.data && shop.data.customers && shop.data.customers.nodes) || [];
  return {
    status: 200,
    cliente: clientes[0] ? { nome: clientes[0].displayName, contas: clientes.length } : null,
    pedidos: resumirPedidos(clientes, agora),
    erro_shopify: shop.errors ? String((shop.errors[0] || {}).message || 'erro').slice(0, 200) : null,
    casos: (casos || []).map(c => ({ id: c.id, tipo: String(c.tipo || '').slice(0, 120), resumo: String(c.resumo || '').slice(0, 400),
      pedido: c.pedido || null, aberto_em: brt(c.criado_at), responsavel: c.responsavel || null })),
  };
}
