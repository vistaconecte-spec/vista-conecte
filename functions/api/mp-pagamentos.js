// GET /api/mp-pagamentos?desde=YYYY-MM-DD&ate=YYYY-MM-DD[&status=rejected]
// Diagnóstico do checkout: lista TODOS os pagamentos criados no Mercado Pago no período
// (aprovado, recusado, pendente, cancelado) com motivo (status_detail), meio e valor.
// Criado 2026-09-16 pra investigar "zero vendas desde ontem" sem depender do painel do MP.
// Secret: MP_ACCESS_TOKEN.
const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

export async function onRequestGet({ request, env }) {
  const tk = env.MP_ACCESS_TOKEN;
  if (!tk) return J({ erro: 'MP_ACCESS_TOKEN ausente' }, 500);
  const u0 = new URL(request.url);
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const desde = u0.searchParams.get('desde') || hoje;
  const ate = u0.searchParams.get('ate') || hoje;
  const filtro = u0.searchParams.get('status') || '';
  const H = { Authorization: `Bearer ${tk}` };
  const itens = [];
  const porStatus = {};
  let offset = 0;
  for (let p = 0; p < 10; p++) {
    const u = `https://api.mercadopago.com/v1/payments/search?range=date_created&begin_date=${desde}T00:00:00.000-03:00&end_date=${ate}T23:59:59.999-03:00&sort=date_created&criteria=desc&limit=50&offset=${offset}`;
    const r = await fetch(u, { headers: H });
    if (!r.ok) return J({ erro: 'MP ' + r.status, corpo: (await r.text()).slice(0, 300) }, 502);
    const d = await r.json();
    for (const pay of (d.results || [])) {
      const st = pay.status || '?';
      porStatus[st] = (porStatus[st] || 0) + 1;
      if (filtro && st !== filtro) continue;
      itens.push({
        id: String(pay.id || ''),
        criado: (pay.date_created || '').slice(0, 16),
        status: st,
        detalhe: pay.status_detail || '',
        meio: pay.payment_method_id || '',
        tipo: pay.payment_type_id || '',
        parcelas: pay.installments || null,
        valor: pay.transaction_amount || 0,
        email: (pay.payer && pay.payer.email) || '',
        ref: pay.external_reference || '',
        descricao: pay.description || ''
      });
    }
    if ((d.results || []).length < 50) break;
    offset += 50;
  }
  return J({ periodo: { desde, ate }, por_status: porStatus, qtd: itens.length, itens });
}
