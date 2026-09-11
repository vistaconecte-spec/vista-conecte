/**
 * Cloudflare Pages Function: /api/webhook-shopify-pedido  (PÚBLICA — quem chama é a Shopify)
 * Recebe o webhook `orders/updated` e, se o pedido foi barrado no cartão, dispara o resgate
 * (ver functions/_cartao-barrado.js).
 *
 * Segurança: aceita se a assinatura X-Shopify-Hmac-Sha256 bate com SHOPIFY_CLIENT_SECRET,
 * ou se a URL trouxe ?k=WEBHOOK_KEY (reserva, caso o segredo do app não seja o do webhook).
 * E mesmo assim o corpo é tratado como AVISO: o pedido é relido na API antes de qualquer
 * decisão — o pior que um corpo forjado consegue é fazer a gente reler um pedido.
 *
 * Responde 200 na hora e trabalha em segundo plano (waitUntil): a Shopify espera 5 s e
 * reenvia se não responder, e o resgate faz 4 chamadas de rede.
 */
import { verificarHmacShopify, igual, processarPedido, json, TAG_AVISADO } from '../_cartao-barrado.js';

// O que dá pra descartar só olhando o corpo, antes de gastar chamada na API.
export function descartarPeloCorpo(o) {
  if (!o || !o.id) return 'sem id';
  if (o.cancelled_at) return 'cancelado';
  if (['paid', 'refunded', 'partially_refunded', 'partially_paid', 'authorized'].includes(o.financial_status)) return 'pago';
  if (!(o.payment_gateway_names || []).some(g => /Cart/i.test(g))) return 'sem cartão';
  if (String(o.tags || '').split(',').map(s => s.trim()).includes(TAG_AVISADO)) return 'já avisado';
  return null;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ erro: 'só POST' }, 405);
  const url = new URL(request.url);
  const kOk = !!env.WEBHOOK_KEY && igual(url.searchParams.get('k') || '', env.WEBHOOK_KEY);
  const raw = await request.arrayBuffer();
  const hmacOk = await verificarHmacShopify(raw, request.headers.get('X-Shopify-Hmac-Sha256'), env.SHOPIFY_CLIENT_SECRET);
  if (!hmacOk && !kOk) return json({ erro: 'assinatura inválida' }, 401);

  let o;
  try { o = JSON.parse(new TextDecoder().decode(raw)); } catch (e) { return json({ erro: 'corpo não é JSON' }, 400); }
  const topico = request.headers.get('X-Shopify-Topic') || '';
  if (topico && !/^orders\//.test(topico)) return json({ ok: true, ignorado: topico });

  const motivo = descartarPeloCorpo(o);
  if (motivo) return json({ ok: true, ignorado: motivo, hmac: hmacOk });

  context.waitUntil(processarPedido(env, o.id).catch(() => {}));
  return json({ ok: true, processando: o.name || o.id, hmac: hmacOk });
}
