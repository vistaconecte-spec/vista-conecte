// GET /api/mp-contestacoes?ids=175198112311,173832786475[&claims=1]
// GET /api/mp-contestacoes?varrer=1[&dias=180] → todo pagamento charged_back/in_mediation criado nos
//   últimos N dias, com o chargeback, o prazo e se ainda dá pra defender (aberta = sem documentação e
//   prazo no futuro). É o que a tarefa diária consulta pra avisar a tempo.
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
  if (u.searchParams.get('varrer')) return J(await varrer(H, Number(u.searchParams.get('dias')) || 180));
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

async function varrer(H, dias) {
  const fim = new Date(Date.now() - 3 * 3600e3);
  const ini = new Date(fim.getTime() - dias * 864e5);
  const d0 = ini.toISOString().slice(0, 10), d1 = fim.toISOString().slice(0, 10);
  const achados = [];
  for (const st of ['charged_back', 'in_mediation']) {
    for (let offset = 0; offset < 500; offset += 50) {
      const r = await get(`https://api.mercadopago.com/v1/payments/search?status=${st}&range=date_created&begin_date=${d0}T00:00:00.000-03:00&end_date=${d1}T23:59:59.999-03:00&sort=date_created&criteria=desc&limit=50&offset=${offset}`, H);
      if (r.http !== 200) return { erro: 'MP ' + r.http, corpo: r.d };
      const res = (r.d && r.d.results) || [];
      for (const pay of res) achados.push(pay);
      if (res.length < 50) break;
    }
  }
  const agora = Date.now();
  const itens = [];
  for (const pay of achados) {
    const busca = await get(`https://api.mercadopago.com/v1/chargebacks/search?payment_id=${pay.id}`, H);
    const lista = (busca.d && (busca.d.results || busca.d.elements)) || [];
    const cbs = [];
    for (const c of lista) { const d = await get(`https://api.mercadopago.com/v1/chargebacks/${c.id}`, H); if (d.http === 200) cbs.push(d.d); }
    const nome = pay.metadata && pay.metadata.shopify_data && pay.metadata.shopify_data.customer && pay.metadata.shopify_data.customer.billing_address;
    for (const cb of (cbs.length ? cbs : [null])) {
      const prazo = cb && cb.date_documentation_deadline;
      const semDoc = cb && (cb.documentation_status === 'not_supplied' || !(cb.documentation || []).length);
      itens.push({
        pagamento: String(pay.id), status: pay.status, detalhe: pay.status_detail, valor: pay.transaction_amount,
        compra: (pay.date_created || '').slice(0, 10), sessao_shopify: pay.external_reference || '',
        email: (pay.payer && pay.payer.email) || '', cliente: nome ? [nome.given_name, nome.family_name].filter(Boolean).join(' ') : '',
        telefone: nome ? nome.phone_number || '' : '',
        chargeback: cb && { id: String(cb.id), motivo: cb.reason, aberto_em: cb.date_created, prazo, documentacao: cb.documentation_status, cobertura_elegivel: cb.coverage_elegible, cobertura_aplicada: cb.coverage_applied },
        aberta: !!(cb && semDoc && prazo && Date.parse(prazo) > agora) || pay.status === 'in_mediation',
        dias_restantes: prazo ? Math.floor((Date.parse(prazo) - agora) / 864e5) : null
      });
    }
  }
  itens.sort((a, b) => (b.aberta - a.aberta) || String(b.compra).localeCompare(a.compra));
  return { periodo: { desde: d0, ate: d1 }, total: itens.length, abertas: itens.filter(i => i.aberta).length, itens };
}

// POST /api/mp-contestacoes  {chargeback: "<id>", arquivos: [{nome, tipo, base64}]}
// Envia a defesa (comprovante de entrega, conversa, nota) pro chargeback. Só rodar com o OK da
// usuária pra aquele caso. MP aceita jpg/png/pdf, até 10 MB no total.
export async function onRequestPost({ request, env }) {
  const tk = env.MP_ACCESS_TOKEN;
  if (!tk) return J({ erro: 'MP_ACCESS_TOKEN ausente' }, 500);
  let b; try { b = await request.json(); } catch { return J({ erro: 'json inválido' }, 400); }
  const id = String(b.chargeback || '').replace(/\D/g, '');
  const arqs = Array.isArray(b.arquivos) ? b.arquivos : [];
  if (!id || !arqs.length) return J({ erro: 'informe chargeback e arquivos' }, 400);
  const fd = new FormData();
  for (const a of arqs) {
    const bin = Uint8Array.from(atob(a.base64 || ''), c => c.charCodeAt(0));
    fd.append('files[]', new Blob([bin], { type: a.tipo || 'application/pdf' }), a.nome || 'documento.pdf');
  }
  const r = await fetch(`https://api.mercadopago.com/v1/chargebacks/${id}/documentation`, {
    method: 'POST', headers: { Authorization: `Bearer ${tk}` }, body: fd
  });
  const t = await r.text();
  const depois = await get(`https://api.mercadopago.com/v1/chargebacks/${id}`, { Authorization: `Bearer ${tk}` });
  return J({ http: r.status, resposta: t.slice(0, 500), documentacao: depois.d && depois.d.documentation_status }, r.ok ? 200 : 502);
}
