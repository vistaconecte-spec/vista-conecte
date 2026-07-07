// GET /api/mp-movimentos?desde=YYYY-MM-DD&ate=YYYY-MM-DD
// Movimentações REAIS da conta Mercado Pago (CONECTE id 3013574234) no período:
//   entradas  = Pix recebidos (payment crédito, líquido de taxa MP)
//   saidas    = pagamentos feitos pela conta (payment débito) + transferências p/ banco (payout)
//   saldo_final = BALANCE_AMOUNT da última linha do extrato (o endpoint /balance é Forbidden p/ este token)
// Fonte: release_report da API MP (gerado sob demanda; leva ~1-3 min). Enquanto gera,
// responde as ENTRADAS via /v1/payments/search (imediato) com gerando:true.
// Secret: MP_ACCESS_TOKEN. Validado 2026-07-07 (jul 1-6: entradas líq 15.317,29 · payouts 7.585,64 · pagamentos 2.227,73).
const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

export function parseReportCSV(csv) {
  const L = csv.trim().split('\n');
  const head = (L[0] || '').split(';');
  const idx = n => head.indexOf(n);
  const iD = idx('DATE'), iDesc = idx('DESCRIPTION'), iCred = idx('NET_CREDIT_AMOUNT'),
        iDeb = idx('NET_DEBIT_AMOUNT'), iBal = idx('BALANCE_AMOUNT'), iSrc = idx('SOURCE_ID');
  if (iD < 0 || iCred < 0) return null;
  const out = { entradas: { total_liquido: 0, qtd: 0, por_dia: {} },
                saidas: { pagamentos: { total: 0, qtd: 0, itens: [] }, transferencias: { total: 0, qtd: 0 }, por_dia: {} },
                saldo_final: null };
  for (const l of L.slice(1)) {
    const c = l.split(';');
    if (c.length < 5) continue;
    const dia = (c[iD] || '').slice(0, 10);
    const desc = c[iDesc] || '';
    const cred = parseFloat(c[iCred]) || 0;
    const deb = parseFloat(c[iDeb]) || 0;
    if (c[iBal] !== undefined && c[iBal] !== '') out.saldo_final = parseFloat(c[iBal]);
    if (desc === 'payment' && cred > 0) {         // Pix recebido (líquido)
      out.entradas.total_liquido += cred; out.entradas.qtd++;
      out.entradas.por_dia[dia] = (out.entradas.por_dia[dia] || 0) + cred;
    } else if (desc === 'payment' && deb > 0) {   // pagamento FEITO pela conta (despesa real)
      out.saidas.pagamentos.total += deb; out.saidas.pagamentos.qtd++;
      out.saidas.pagamentos.itens.push({ dia, valor: deb, source_id: c[iSrc] || null });
      out.saidas.por_dia[dia] = (out.saidas.por_dia[dia] || 0) + deb;
    } else if (desc === 'payout' && deb > 0) {    // transferência p/ conta bancária (interna, não é despesa)
      out.saidas.transferencias.total += deb; out.saidas.transferencias.qtd++;
      out.saidas.por_dia[dia] = (out.saidas.por_dia[dia] || 0) + deb;
    }
    // reserve_for_* são movimentos transitórios (crédito+débito se anulam) — ignorados
  }
  const r2 = v => Math.round(v * 100) / 100;
  out.entradas.total_liquido = r2(out.entradas.total_liquido);
  out.saidas.pagamentos.total = r2(out.saidas.pagamentos.total);
  out.saidas.transferencias.total = r2(out.saidas.transferencias.total);
  return out;
}

// Fallback imediato: entradas via payments/search (aprovados no período)
async function entradasViaPayments(H, desde, ate) {
  const out = { total_liquido: 0, qtd: 0, por_dia: {} };
  let offset = 0;
  for (let p = 0; p < 20; p++) {
    const u = `https://api.mercadopago.com/v1/payments/search?range=date_approved&begin_date=${desde}T00:00:00.000-03:00&end_date=${ate}T23:59:59.999-03:00&status=approved&limit=50&offset=${offset}`;
    const r = await fetch(u, { headers: H });
    if (!r.ok) break;
    const d = await r.json();
    for (const pay of (d.results || [])) {
      const liq = (typeof pay.transaction_details?.net_received_amount === 'number')
        ? pay.transaction_details.net_received_amount : (pay.transaction_amount || 0);
      const dia = (pay.date_approved || '').slice(0, 10);
      out.total_liquido += liq; out.qtd++;
      out.por_dia[dia] = (out.por_dia[dia] || 0) + liq;
    }
    offset += 50;
    if (!d.paging || offset >= d.paging.total) break;
  }
  out.total_liquido = Math.round(out.total_liquido * 100) / 100;
  return out;
}

export async function onRequestGet({ request, env }) {
  const tk = env.MP_ACCESS_TOKEN;
  if (!tk) return J({ erro: 'MP_ACCESS_TOKEN ausente' }, 500);
  const H = { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' };
  const url = new URL(request.url);
  const desde = url.searchParams.get('desde'), ate = url.searchParams.get('ate');
  if (!desde || !ate) return J({ erro: 'faltam ?desde= e ?ate=' }, 400);

  try {
    // 1. procura um extrato (release_report) que cubra o período e seja recente
    const lst = await (await fetch('https://api.mercadopago.com/v1/account/release_report/list', { headers: H })).json();
    const cobre = (Array.isArray(lst) ? lst : []).filter(f =>
      f.begin_date && f.end_date &&
      f.begin_date.slice(0, 10) <= desde && f.end_date.slice(0, 10) >= ate
    ).sort((a, b) => (b.date_created || '').localeCompare(a.date_created || ''));
    // fresco = criado depois do fim do período OU nas últimas 6h (período corrente muda ao longo do dia)
    const agora = Date.now();
    const fresco = cobre.find(f => {
      const criado = new Date(f.date_created).getTime();
      const fimPeriodoPassado = ate < new Date(agora).toISOString().slice(0, 10);
      return fimPeriodoPassado ? true : (agora - criado) < 6 * 3600 * 1000;
    });

    if (fresco) {
      const csv = await (await fetch('https://api.mercadopago.com/v1/account/release_report/' + encodeURIComponent(fresco.file_name), { headers: H })).text();
      const parsed = parseReportCSV(csv);
      if (parsed) return J(Object.assign({ periodo: { desde, ate }, fonte: 'release_report', gerando: false, gerado_em: fresco.date_created }, parsed));
    }

    // 2. não tem extrato pronto → dispara a geração (202, fire-and-forget) e responde com o fallback
    fetch('https://api.mercadopago.com/v1/account/release_report', {
      method: 'POST', headers: H,
      body: JSON.stringify({ begin_date: desde + 'T03:00:00Z', end_date: new Date(new Date(ate + 'T23:59:59-03:00').getTime() + 1000).toISOString().replace(/\.\d+Z/, 'Z') })
    }).catch(() => {});
    const entradas = await entradasViaPayments(H, desde, ate);
    return J({ periodo: { desde, ate }, fonte: 'payments_fallback', gerando: true,
      entradas, saidas: { pagamentos: { total: null, qtd: 0, itens: [] }, transferencias: { total: null, qtd: 0 }, por_dia: {} },
      saldo_final: null,
      aviso: 'extrato MP sendo gerado (~2 min) — saídas e saldo disponíveis na próxima atualização' });
  } catch (e) {
    return J({ erro: String(e) }, 502);
  }
}
