// GET /api/mp-contestacoes?ids=175198112311,173832786475[&claims=1]
// Contestações do Mercado Pago: detalhe do chargeback de cada pagamento (prazo e status da
// documentação, cobertura) e as reclamações abertas pela compradora (post-purchase claims).
// Só leitura. Criado 2026-09-30. Secret: MP_ACCESS_TOKEN.
const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

async function get(url, H) {
  const r = await fetch(url, { headers: H });
  const t = await r.text();
  let d = null; try { d = JSON.parse(t); } catch { d = t.slice(0, 300); }
  return { http: r.status, d };
}

export async function onRequestGet({ request, env }) {
  const tk = env.MP_ACCESS_TOKEN;
  if (!tk) return J({ erro: 'MP_ACCESS_TOKEN ausente' }, 500);
  const u = new URL(request.url);
  const H = { Authorization: `Bearer ${tk}` };
  const ids = (u.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
  const pagamentos = [];
  for (const id of ids) {
    const p = await get(`https://api.mercadopago.com/v1/payments/${id}`, H);
    const pay = p.d || {};
    const cbs = [];
    for (const cb of ((pay.charges_details || []).filter(c => /chargeback/i.test(c.type || c.name || '')))) cbs.push({ ref: cb.id, tipo: cb.type });
    const busca = await get(`https://api.mercadopago.com/v1/chargebacks/search?payment_id=${id}`, H);
    const lista = (busca.d && (busca.d.results || busca.d.elements)) || [];
    const detalhes = [];
    for (const c of lista) {
      const d = await get(`https://api.mercadopago.com/v1/chargebacks/${c.id}`, H);
      detalhes.push(d.d);
    }
    pagamentos.push({
      id, status: pay.status, detalhe: pay.status_detail, valor: pay.transaction_amount,
      criado: pay.date_created, pedido: pay.external_reference, comprador: pay.payer && { email: pay.payer.email, nome: [pay.payer.first_name, pay.payer.last_name].filter(Boolean).join(' ') },
      itens: pay.additional_info && pay.additional_info.items, envio: pay.additional_info && pay.additional_info.shipments,
      metadata: pay.metadata, charges: cbs, busca_http: busca.http, busca_bruta: lista.length ? undefined : busca.d, chargebacks: detalhes
    });
  }
  let reclamacoes = null;
  if (u.searchParams.get('claims')) {
    const c = await get('https://api.mercadopago.com/post-purchase/v1/claims/search?status=opened&limit=50', H);
    const c2 = await get('https://api.mercadopago.com/post-purchase/v1/claims/search?limit=50&sort=date_created:desc', H);
    reclamacoes = { abertas: c, recentes: c2 };
  }
  return J({ pagamentos, reclamacoes });
}
