// POST /api/mp-cancelar { id: "188698909425" }
// Cancela um Pix PENDENTE no Mercado Pago (15/11/2026, #9714: a cliente pagou no cartão pelo link
// e o Pix gerado no checkout ficou pendente, travando o "marcar como pago" da Shopify).
// Só cancela pagamento com status pending e tipo bank_transfer (Pix ainda não pago): não move dinheiro.
// Qualquer outro status (aprovado, autorizado, etc.) é recusado; estorno continua sendo só no MP pela Bárbara.
// Secret: MP_ACCESS_TOKEN. Protegido pelo _middleware (sessão da dona ou X-VC-Token).
const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

export function podeCancelar(pay) {
  if (!pay || typeof pay !== 'object') return 'pagamento não encontrado';
  if (pay.status !== 'pending') return `status ${pay.status}, só cancelo pendente`;
  if (pay.payment_type_id !== 'bank_transfer') return `tipo ${pay.payment_type_id}, só cancelo Pix`;
  return '';
}

export async function onRequestPost({ request, env }) {
  const tk = env.MP_ACCESS_TOKEN;
  if (!tk) return J({ erro: 'MP_ACCESS_TOKEN ausente' }, 500);
  let b;
  try { b = await request.json(); } catch { return J({ erro: 'corpo inválido' }, 400); }
  const id = String(b && b.id || '').trim();
  if (!/^\d{6,20}$/.test(id)) return J({ erro: 'id inválido' }, 400);
  const H = { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' };
  const r0 = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, { headers: H });
  const pay = r0.ok ? await r0.json() : null;
  const motivo = podeCancelar(pay);
  if (motivo) return J({ ok: false, erro: motivo, http: r0.status }, 409);
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
    method: 'PUT', headers: H, body: JSON.stringify({ status: 'cancelled' })
  });
  const d = await r.json().catch(() => null);
  return J({ ok: r.ok && d && d.status === 'cancelled', http: r.status, id, status: d && d.status,
    detalhe: d && d.status_detail, valor: pay.transaction_amount }, r.ok ? 200 : 502);
}
