// GET /api/mp-saidas — pagamentos e Pix FEITOS pela conta (somente leitura), com o nome de quem recebeu.
// O release_report (mp-extrato / mp-movimentos) traz só valor e SOURCE_ID das saídas; o nome do
// destinatário só existe no detalhe do pagamento. Usado pra achar despesas pelo nome no extrato
// (ex.: babá, faxina, Anthropic) sem depender do login no site do Mercado Pago.
//   ?desde=YYYY-MM-DD&ate=YYYY-MM-DD → busca em /v1/payments/search e devolve só onde NÓS somos o pagador
//   ?ids=1,2,3                       → detalhe de SOURCE_IDs do extrato (até 40 por chamada)
// Secret: MP_ACCESS_TOKEN.
const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});
const CONTA_MP_ID = '3013574234'; // conta CONECTE (vistaconecte@gmail.com)

export function resumo(p) {
  const bi = (p.point_of_interaction && p.point_of_interaction.transaction_data
    && p.point_of_interaction.transaction_data.bank_info) || {};
  const col = bi.collector || {};
  return {
    id: p.id,
    data: p.date_approved || p.date_created,
    valor: p.transaction_amount,
    status: p.status,
    descricao: p.description || null,
    tipo: p.operation_type || null,
    meio: p.payment_method_id || null,
    recebedor: col.long_name || (p.collector && (p.collector.nickname || p.collector.first_name)) || null,
    recebedor_id: p.collector_id || (p.collector && p.collector.id) || null,
  };
}

export async function onRequestGet({ request, env }) {
  const tk = env.MP_ACCESS_TOKEN;
  if (!tk) return J({ erro: 'MP_ACCESS_TOKEN ausente' }, 500);
  const H = { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' };
  const u = new URL(request.url);
  const ids = (u.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
  try {
    if (ids.length) {
      const itens = [];
      for (const id of ids) {
        const r = await fetch('https://api.mercadopago.com/v1/payments/' + encodeURIComponent(id), { headers: H });
        itens.push(r.ok ? resumo(await r.json()) : { id, erro: r.status });
      }
      return J({ itens });
    }
    const desde = u.searchParams.get('desde'), ate = u.searchParams.get('ate');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(ate || '')) {
      return J({ erro: 'use ?desde=YYYY-MM-DD&ate=YYYY-MM-DD ou ?ids=' }, 400);
    }
    const itens = [];
    let offset = 0, total = 0;
    for (let pg = 0; pg < 30; pg++) {
      const q = `https://api.mercadopago.com/v1/payments/search?range=date_created&begin_date=${desde}T00:00:00.000-03:00&end_date=${ate}T23:59:59.999-03:00&sort=date_created&criteria=asc&limit=50&offset=${offset}`;
      const r = await fetch(q, { headers: H });
      if (!r.ok) return J({ erro: 'payments/search ' + r.status, itens }, 502);
      const d = await r.json();
      total = (d.paging && d.paging.total) || 0;
      for (const p of (d.results || [])) {
        const somosRecebedor = String(p.collector_id || (p.collector && p.collector.id) || '') === CONTA_MP_ID;
        if (!somosRecebedor) itens.push(resumo(p));
      }
      offset += 50;
      if (offset >= total) break;
    }
    return J({ periodo: { desde, ate }, varridos: Math.min(offset, total), total, itens });
  } catch (e) {
    return J({ erro: e.message }, 500);
  }
}
