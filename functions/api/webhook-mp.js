/**
 * Cloudflare Pages Function: /api/webhook-mp  (PÚBLICA — quem chama é o Mercado Pago)
 * Notificação do link de resgate (Checkout Pro) gerado em functions/_cartao-barrado.js.
 * A preferência é criada com notification_url = esta rota + ?pedido=<id da Shopify>&k=WEBHOOK_KEY
 * e external_reference = id do pedido.
 *
 * Chega de dois jeitos: webhook novo (JSON {type:'payment', data:{id}}) ou IPN antigo
 * (?topic=payment&id=). Nos dois o corpo é AVISO: o pagamento é relido em GET /v1/payments/{id}
 * com o nosso token, e só conta se external_reference bate com o pedido e o status é approved.
 */
import { igual, json, confirmarPagamento, registrarEvento } from '../_cartao-barrado.js';

export function extrairPagamento(query, corpo) {
  const tipo = query.get('type') || query.get('topic') || (corpo && corpo.type) || '';
  const id = query.get('data.id') || query.get('id') || (corpo && corpo.data && corpo.data.id) || '';
  return { tipo: String(tipo), id: String(id || '') };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST' && request.method !== 'GET') return json({ erro: 'método' }, 405);
  const url = new URL(request.url);
  if (!env.WEBHOOK_KEY || !igual(url.searchParams.get('k') || '', env.WEBHOOK_KEY)) return json({ erro: 'não autorizado' }, 401);
  const orderId = String(url.searchParams.get('pedido') || '').replace(/\D/g, '');
  if (!orderId) return json({ erro: 'sem pedido' }, 400);

  let corpo = {};
  if (request.method === 'POST') { try { corpo = await request.json(); } catch (e) { corpo = {}; } }
  const { tipo, id } = extrairPagamento(url.searchParams, corpo);
  if (tipo && tipo !== 'payment') return json({ ok: true, ignorado: tipo });
  if (!id) return json({ ok: true, ignorado: 'sem id de pagamento' });

  const token = env.MP_ACCESS_TOKEN;
  if (!token) return json({ erro: 'MP_ACCESS_TOKEN ausente' }, 500);
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(id)}`, { headers: { Authorization: 'Bearer ' + token } });
  const p = await r.json().catch(() => ({}));
  if (!r.ok) return json({ erro: 'Mercado Pago não devolveu o pagamento', status: r.status }, 502);
  if (String(p.external_reference || '') !== orderId) return json({ erro: 'pagamento de outro pedido' }, 409);

  const resumo = { status: p.status, detalhe: p.status_detail, metodo: p.payment_method_id, parcelas: p.installments, final: (p.card && p.card.last_four_digits) || null };
  if (p.status !== 'approved') {
    await registrarEvento(env, orderId, { provedor: 'mp', pagamento_id: String(p.id || id), ...resumo });
    return json({ ok: true, registrado: resumo });
  }
  const res = await confirmarPagamento(env, orderId, { provedor: 'mp', pagamento_id: String(p.id || id), valorCentavos: Math.round(Number(p.transaction_amount) * 100), bruto: resumo });
  return json({ ok: res.ok, motivo: res.motivo });
}
