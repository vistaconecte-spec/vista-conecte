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
  const out = { entradas: { total_liquido: 0, qtd: 0, por_dia: {}, itens: [] },
                saidas: { pagamentos: { total: 0, qtd: 0, itens: [] },
                          transferencias: { total: 0, qtd: 0, internas: 0, enviadas: 0, itens: [] },
                          por_dia: {} },
                saldo_final: null };
  // Reservas de pagamento por transação: débito consumido sem estorno = pagamento REAL
  // (cartão/conta em status authorized — ex.: Facebook Ads, Anthropic, Apple em 07/07).
  const reservas = {};       // source_id -> { net, dia }
  const pagamentosDiretos = new Set(); // sources que JÁ têm linha 'payment' débito (evita dupla contagem)
  for (const l of L.slice(1)) {
    const c = l.split(';');
    if (c.length < 5) continue;
    const dia = (c[iD] || '').slice(0, 10);
    const desc = c[iDesc] || '';
    const cred = parseFloat(c[iCred]) || 0;
    const deb = parseFloat(c[iDeb]) || 0;
    const src = c[iSrc] || '';
    const bal = (c[iBal] !== undefined && c[iBal] !== '') ? parseFloat(c[iBal]) : null;
    // linha de TOTAIS no rodapé (sem DATE) tem saldo 0.00 — não é o saldo da conta
    if (bal !== null && c[iD]) out.saldo_final = bal;
    if (desc === 'payment' && cred > 0) {         // recebimento (Pix/TED, líquido de taxa)
      out.entradas.total_liquido += cred; out.entradas.qtd++;
      out.entradas.por_dia[dia] = (out.entradas.por_dia[dia] || 0) + cred;
      out.entradas.itens.push({ dia, hora: (c[iD] || '').slice(11, 16), valor: cred, source_id: src || null });
    } else if (desc === 'payment' && deb > 0) {   // pagamento efetivado pela conta
      pagamentosDiretos.add(src);
      out.saidas.pagamentos.total += deb; out.saidas.pagamentos.qtd++;
      out.saidas.pagamentos.itens.push({ dia, valor: deb, source_id: src || null });
      out.saidas.por_dia[dia] = (out.saidas.por_dia[dia] || 0) + deb;
    } else if (desc === 'reserve_for_payment' && src) {
      reservas[src] = reservas[src] || { net: 0, dia };
      reservas[src].net += deb - cred;
      reservas[src].dia = dia;
    } else if (desc === 'payout' && deb > 0) {
      // transferência enviada. Heurística: se zera (ou quase) o saldo → varredura p/ banco próprio
      // (interna, não é despesa); senão → provável Pix/transferência a TERCEIRO (despesa).
      const interna = (bal !== null && bal < 1);
      out.saidas.transferencias.total += deb; out.saidas.transferencias.qtd++;
      if (interna) out.saidas.transferencias.internas += deb;
      else out.saidas.transferencias.enviadas += deb;
      out.saidas.transferencias.itens.push({ dia, valor: deb, source_id: src || null, provavel_interna: interna });
      out.saidas.por_dia[dia] = (out.saidas.por_dia[dia] || 0) + deb;
    }
  }
  // reservas consumidas (net > 0) sem 'payment' correspondente = pagamentos autorizados/em liquidação
  for (const [src, r] of Object.entries(reservas)) {
    if (r.net > 0.009 && !pagamentosDiretos.has(src)) {
      out.saidas.pagamentos.total += r.net; out.saidas.pagamentos.qtd++;
      out.saidas.pagamentos.itens.push({ dia: r.dia, valor: Math.round(r.net * 100) / 100, source_id: src, autorizado: true });
      out.saidas.por_dia[r.dia] = (out.saidas.por_dia[r.dia] || 0) + r.net;
    }
  }
  const r2 = v => Math.round(v * 100) / 100;
  out.entradas.total_liquido = r2(out.entradas.total_liquido);
  out.saidas.pagamentos.total = r2(out.saidas.pagamentos.total);
  out.saidas.transferencias.total = r2(out.saidas.transferencias.total);
  out.saidas.transferencias.internas = r2(out.saidas.transferencias.internas);
  out.saidas.transferencias.enviadas = r2(out.saidas.transferencias.enviadas);
  return out;
}

// Fallback imediato: entradas via payments/search (aprovados no período)
async function entradasViaPayments(H, desde, ate) {
  const out = { total_liquido: 0, qtd: 0, por_dia: {}, itens: [] };
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
      out.itens.push({ dia, hora: (pay.date_approved || '').slice(11, 16), valor: Math.round(liq * 100) / 100, source_id: String(pay.id || '') });
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
    // 1. procura um extrato (release_report) que cubra o INÍCIO do período
    const lst = await (await fetch('https://api.mercadopago.com/v1/account/release_report/list', { headers: H })).json();
    const agora = Date.now();
    const hojeISO = new Date(agora).toISOString().slice(0, 10);
    const periodoInclusoHoje = ate >= hojeISO;
    // horizonte real dos dados = min(end_date, date_created) — end_date pode estar no futuro
    const horizonte = f => Math.min(new Date(f.end_date).getTime(), new Date(f.date_created).getTime());
    const cobre = (Array.isArray(lst) ? lst : []).filter(f =>
      f.begin_date && f.end_date && f.date_created && f.begin_date.slice(0, 10) <= desde
    ).sort((a, b) => horizonte(b) - horizonte(a));
    const melhor = cobre[0] || null;
    // completo = o horizonte alcança o fim do período; p/ período corrente, "fresco" = horizonte <1h
    const alcancaFim = melhor && new Date(horizonte(melhor)).toISOString().slice(0, 10) > ate;
    const fresco = melhor && (!periodoInclusoHoje ? alcancaFim
      : (agora - horizonte(melhor)) < 15 * 60 * 1000);

    // extrato defasado → dispara geração de um novo até AGORA (anti-rajada: só se o último foi criado há >10 min)
    const criadoHa = melhor ? (agora - new Date(melhor.date_created).getTime()) : Infinity;
    if (!fresco && criadoHa > 4 * 60 * 1000) {
      fetch('https://api.mercadopago.com/v1/account/release_report', {
        method: 'POST', headers: H,
        body: JSON.stringify({
          begin_date: desde + 'T03:00:00Z',
          end_date: (periodoInclusoHoje ? new Date(agora - 60 * 1000) : new Date(new Date(ate + 'T23:59:59-03:00').getTime() + 1000)).toISOString().replace(/\.\d+Z/, 'Z')
        })
      }).catch(() => {});
    }

    if (melhor) {
      const csv = await (await fetch('https://api.mercadopago.com/v1/account/release_report/' + encodeURIComponent(melhor.file_name), { headers: H })).text();
      const parsed = parseReportCSV(csv);
      if (parsed) {
        // enriquece os pagamentos feitos com a descrição real (até 15 lookups p/ não estourar tempo)
        for (const it of parsed.saidas.pagamentos.itens.slice(0, 15)) {
          if (!it.source_id) continue;
          try {
            const pd = await (await fetch('https://api.mercadopago.com/v1/payments/' + it.source_id, { headers: H })).json();
            if (pd && pd.description) it.descricao = pd.description;
          } catch (e) {}
        }
        // identifica as ENTRADAS: venda Shopify (desc CONECTE) × Pix avulso (banco do pagador).
        // O MP mascara o NOME da pessoa (guest) — pro nome exato, usar o rótulo manual (✎ no painel).
        for (const it of parsed.entradas.itens.slice(-25)) {
          if (!it.source_id) continue;
          try {
            const pd = await (await fetch('https://api.mercadopago.com/v1/payments/' + it.source_id, { headers: H })).json();
            if (!pd) continue;
            if (pd.description === 'CONECTE' || (pd.external_reference || '').length > 15) {
              it.origem = 'Venda Shopify' + (pd.description && pd.description !== 'CONECTE' ? ' · ' + pd.description : '');
            } else {
              const banco = pd.point_of_interaction && pd.point_of_interaction.transaction_data
                && pd.point_of_interaction.transaction_data.bank_info
                && pd.point_of_interaction.transaction_data.bank_info.payer
                && pd.point_of_interaction.transaction_data.bank_info.payer.long_name;
              it.origem = 'Pix avulso' + (banco ? ' via ' + String(banco).split(' ').slice(0, 2).join(' ') : '');
            }
          } catch (e) {}
        }
        // extrato termina antes do fim do período → completa as ENTRADAS do trecho descoberto via payments
        if (!alcancaFim || (periodoInclusoHoje && !fresco)) {
          const desdeTopo = new Date(horizonte(melhor)).toISOString();
          const topo = await entradasViaPayments(H, desdeTopo.slice(0, 10), ate);
          parsed.entradas.total_liquido = Math.round((parsed.entradas.total_liquido + topo.total_liquido) * 100) / 100;
          parsed.entradas.qtd += topo.qtd;
          for (const [d, v] of Object.entries(topo.por_dia)) parsed.entradas.por_dia[d] = (parsed.entradas.por_dia[d] || 0) + v;
          parsed.entradas.itens = (parsed.entradas.itens || []).concat(topo.itens || []);
        }
        return J(Object.assign({
          periodo: { desde, ate },
          fonte: fresco ? 'release_report' : 'release_report + Pix recentes',
          gerando: !fresco,
          extrato_ate: new Date(horizonte(melhor)).toISOString(),
          aviso: fresco ? undefined : 'saídas/saldo refletem o extrato até ' + new Date(horizonte(melhor)).toISOString().slice(11, 16) + ' UTC — extrato novo sendo gerado (~2 min)'
        }, parsed));
      }
    }

    // 2. nenhum extrato cobre o período → fallback total via payments (entradas imediatas)
    const entradas = await entradasViaPayments(H, desde, ate);
    return J({ periodo: { desde, ate }, fonte: 'payments_fallback', gerando: true,
      entradas, saidas: { pagamentos: { total: null, qtd: 0, itens: [] }, transferencias: { total: null, qtd: 0 }, por_dia: {} },
      saldo_final: null,
      aviso: 'extrato MP sendo gerado (~2 min) — saídas e saldo disponíveis na próxima atualização' });
  } catch (e) {
    return J({ erro: String(e) }, 502);
  }
}
