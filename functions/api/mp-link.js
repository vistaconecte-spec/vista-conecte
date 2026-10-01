// Link de pagamento do Mercado Pago para venda fechada no WhatsApp (central de missões, 01/10/2026).
//
// POST /api/mp-link  { valor: 514.21, descricao: "Venda Marcelly", parcelas: 3 }
//   → { ok, url, id, valor, parcelas, expira }
//   Regra da Bárbara (01/10/2026): até 3x sem juros, parcelamento por conta do vendedor. Pedido de
//   mais parcelas é rebaixado para 3. As parcelas sem juros vêm da configuração da conta no MP;
//   o GET abaixo mostra como a conta está parcelando de verdade.
// GET /api/mp-link?valor=514.21 → como o MP parcela esse valor (juros do cliente por parcela), sem criar nada.
//
// Secret: MP_ACCESS_TOKEN. Protegido pelo _middleware (sessão da dona ou X-VC-Token).
const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

const VALOR_MAX = 5000;
const PARCELAS_MAX = 3;
const VALIDADE_DIAS = 7;

export async function onRequestPost({ request, env }) {
  const token = env.MP_ACCESS_TOKEN;
  if (!token) return J({ erro: 'MP_ACCESS_TOKEN ausente' }, 500);
  let b;
  try { b = await request.json(); } catch { return J({ erro: 'corpo inválido' }, 400); }
  const valor = Math.round(Number(String(b.valor).replace(',', '.')) * 100) / 100;
  if (!(valor > 0) || valor > VALOR_MAX) return J({ erro: `valor fora do permitido (0 a ${VALOR_MAX})` }, 400);
  const parcelas = Math.min(PARCELAS_MAX, Math.max(1, parseInt(b.parcelas, 10) || PARCELAS_MAX));
  const descricao = String(b.descricao || 'Compra Vista Conecte').slice(0, 120);
  const ate = new Date(Date.now() + VALIDADE_DIAS * 864e5);
  const body = {
    items: [{ id: 'whatsapp', title: descricao, quantity: 1, unit_price: valor, currency_id: 'BRL' }],
    payment_methods: { excluded_payment_types: [{ id: 'ticket' }], installments: parcelas },
    expires: true,
    expiration_date_to: ate.toISOString().replace('Z', '-00:00'),
    statement_descriptor: 'VISTA CONECTE',
    external_reference: 'whatsapp-' + Date.now(),
    metadata: { origem: 'central-missoes' },
  };
  const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.init_point) return J({ erro: `Mercado Pago ${r.status}`, detalhe: JSON.stringify(j).slice(0, 300) }, 502);
  return J({ ok: true, url: j.init_point, id: j.id, valor, parcelas, expira: j.expiration_date_to || null });
}

export async function onRequestGet({ request, env }) {
  const token = env.MP_ACCESS_TOKEN;
  if (!token) return J({ erro: 'MP_ACCESS_TOKEN ausente' }, 500);
  const valor = Number(new URL(request.url).searchParams.get('valor') || '100');
  const out = { valor };
  for (const pm of ['master', 'visa']) {
    const r = await fetch(`https://api.mercadopago.com/v1/payment_methods/installments?amount=${valor}&payment_method_id=${pm}`,
      { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json().catch(() => null);
    out[pm] = Array.isArray(j) && j[0]
      ? j[0].payer_costs.slice(0, 6).map(c => ({ parcelas: c.installments, juros_cliente_pct: c.installment_rate, total: c.total_amount }))
      : { status: r.status, resposta: JSON.stringify(j).slice(0, 200) };
  }
  return J(out);
}
