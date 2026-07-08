// GET /api/mp-saldo — saldo da conta Mercado Pago (Cloudflare Pages Function)
// O endpoint oficial de balance é FORBIDDEN para este token (app ClaudeConecte) — validado 2026-07-07.
// Estratégia: saldo = BALANCE_AMOUNT da última linha do EXTRATO (release_report).
//   • Extrato "fresco" = termina há <3h → serve direto.
//   • Extrato velho → dispara a geração de um novo (termina AGORA, fica pronto em ~2 min) e,
//     enquanto isso, serve a ESTIMATIVA = saldo do extrato + Pix líquidos recebidos depois do
//     fim dele (payments/search, imediato). Payouts pós-extrato não são visíveis → a estimativa
//     é teto; o valor exato chega quando o novo extrato fica pronto.
// Secret: MP_ACCESS_TOKEN. Retorna: { disponivel, atualizado, referencia, fonte, gerando }
const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

function saldoDoCSV(csv) {
  const L = csv.trim().split('\n');
  const head = (L[0] || '').split(';');
  const iBal = head.indexOf('BALANCE_AMOUNT');
  if (iBal < 0) return null;
  for (let i = L.length - 1; i > 0; i--) {
    const c = L[i].split(';');
    if (c[iBal] !== undefined && c[iBal] !== '') { const v = parseFloat(c[iBal]); if (!isNaN(v)) return v; }
  }
  return null;
}

// Pix líquidos aprovados desde `desdeISO` até agora (imediato, sem esperar extrato)
async function entradasDesde(H, desdeISO) {
  let total = 0, offset = 0;
  for (let p = 0; p < 10; p++) {
    const u = `https://api.mercadopago.com/v1/payments/search?range=date_approved&begin_date=${encodeURIComponent(desdeISO)}&end_date=${encodeURIComponent(new Date().toISOString())}&status=approved&limit=50&offset=${offset}`;
    const r = await fetch(u, { headers: H });
    if (!r.ok) break;
    const d = await r.json();
    for (const pay of (d.results || [])) {
      total += (typeof pay.transaction_details?.net_received_amount === 'number')
        ? pay.transaction_details.net_received_amount : (pay.transaction_amount || 0);
    }
    offset += 50;
    if (!d.paging || offset >= d.paging.total) break;
  }
  return Math.round(total * 100) / 100;
}

export async function onRequestGet({ env }) {
  const token = env.MP_ACCESS_TOKEN;
  if (!token) return J({ erro: 'MP_ACCESS_TOKEN ausente no projeto Cloudflare', disponivel: null }, 500);
  const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  try {
    const lst = await (await fetch('https://api.mercadopago.com/v1/account/release_report/list', { headers: H })).json();
    const maisRecente = (Array.isArray(lst) ? lst : [])
      .sort((a, b) => (b.end_date || '').localeCompare(a.end_date || ''))[0] || null;

    const agora = Date.now();
    // frescor = o EXTRATO TERMINA há menos de 3h (não a data de criação!)
    const fimExtrato = maisRecente ? new Date(maisRecente.end_date).getTime() : 0;
    const fresco = maisRecente && (agora - fimExtrato) < 3 * 3600 * 1000;
    // evita disparar gerações em rajada: só regenera se o extrato mais recente foi CRIADO há >10 min
    const criadoHa = maisRecente ? (agora - new Date(maisRecente.date_created).getTime()) : Infinity;

    if (!fresco && criadoHa > 10 * 60 * 1000) {
      fetch('https://api.mercadopago.com/v1/account/release_report', {
        method: 'POST', headers: H,
        body: JSON.stringify({
          begin_date: new Date(agora - 48 * 3600 * 1000).toISOString().replace(/\.\d+Z/, 'Z'),
          end_date: new Date(agora - 60 * 1000).toISOString().replace(/\.\d+Z/, 'Z')
        })
      }).catch(() => {});
    }

    if (maisRecente) {
      const csv = await (await fetch('https://api.mercadopago.com/v1/account/release_report/' + encodeURIComponent(maisRecente.file_name), { headers: H })).text();
      const saldoBase = saldoDoCSV(csv);
      if (saldoBase !== null) {
        if (fresco) {
          return J({ disponivel: saldoBase, atualizado: new Date().toISOString(), referencia: maisRecente.end_date, fonte: 'release_report', gerando: false });
        }
        // extrato velho → estimativa intradiária: saldo do extrato + Pix recebidos depois do fim dele
        const entradas = await entradasDesde(H, maisRecente.end_date);
        return J({
          disponivel: Math.round((saldoBase + entradas) * 100) / 100,
          atualizado: new Date().toISOString(),
          referencia: maisRecente.end_date,
          fonte: 'estimativa (extrato ' + String(maisRecente.end_date).slice(0, 10) + ' + Pix de hoje)',
          gerando: true
        });
      }
    }
    return J({ disponivel: null, gerando: true, aviso: 'extrato MP sendo gerado (~2 min) — atualize em instantes', fonte: 'release_report' });
  } catch (e) {
    return J({ erro: String(e), disponivel: null }, 502);
  }
}
