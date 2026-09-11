/**
 * Cloudflare Pages Function: /api/webhook-pagarme  (PÚBLICA — quem chama é o Pagar.me)
 * Postback do link de resgate (functions/_cartao-barrado.js). A URL do postback é gerada
 * por link e leva ?pedido=<id da Shopify>&k=WEBHOOK_KEY.
 *
 * O corpo do postback é só um AVISO (form-urlencoded, às vezes JSON): o que vale é reler a
 * transação em GET /1/transactions/{id} com a nossa chave. Pagou o valor do pedido → o
 * pedido é marcado como pago na Shopify com a tag `pago-link-pagarme`.
 */
import { igual, json, confirmarPagamento, registrarEvento } from '../_cartao-barrado.js';

export function lerCorpo(texto, contentType) {
  if (/json/i.test(contentType || '')) { try { return JSON.parse(texto); } catch (e) { return {}; } }
  const p = new URLSearchParams(texto);
  const o = {};
  for (const [k, v] of p) o[k] = v;
  return o;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ erro: 'só POST' }, 405);
  const url = new URL(request.url);
  if (!env.WEBHOOK_KEY || !igual(url.searchParams.get('k') || '', env.WEBHOOK_KEY)) return json({ erro: 'não autorizado' }, 401);
  const orderId = String(url.searchParams.get('pedido') || '').replace(/\D/g, '');
  if (!orderId) return json({ erro: 'sem pedido' }, 400);

  const corpo = lerCorpo(await request.text(), request.headers.get('Content-Type'));
  const objeto = corpo.object || (corpo.transaction ? 'transaction' : '');
  const id = corpo.id || (corpo.transaction && corpo.transaction.id) || corpo['transaction[id]'];
  if (objeto && objeto !== 'transaction') return json({ ok: true, ignorado: objeto });
  if (!id) return json({ ok: true, ignorado: 'sem id de transação' });

  const sk = env.PAGARME_SECRET_KEY;
  if (!sk) return json({ erro: 'PAGARME_SECRET_KEY ausente' }, 500);
  const r = await fetch(`https://api.pagar.me/1/transactions/${encodeURIComponent(id)}?api_key=${encodeURIComponent(sk)}`);
  const t = await r.json().catch(() => ({}));
  if (!r.ok) return json({ erro: 'Pagar.me não devolveu a transação', status: r.status }, 502);

  // O link foi criado com o id do pedido como id do item — se o Pagar.me devolver os itens,
  // a transação tem que ser desse pedido.
  const itens = Array.isArray(t.items) ? t.items : [];
  if (itens.length && !itens.some(i => String(i.id) === orderId)) return json({ erro: 'transação de outro pedido' }, 409);

  const resumo = { status: t.status, metodo: t.payment_method, parcelas: t.installments, final: t.card_last_digits || null, recusa: t.refuse_reason || t.acquirer_response_code || null };
  if (t.status !== 'paid') {
    await registrarEvento(env, orderId, { provedor: 'pagarme', pagamento_id: String(t.id || id), ...resumo });
    return json({ ok: true, registrado: resumo });
  }
  const res = await confirmarPagamento(env, orderId, { provedor: 'pagarme', pagamento_id: String(t.id || id), valorCentavos: Number(t.amount), bruto: resumo });
  return json({ ok: res.ok, motivo: res.motivo });
}
