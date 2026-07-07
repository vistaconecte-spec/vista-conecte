// GET /api/mp-saldo — saldo da conta Mercado Pago (Cloudflare Pages Function)
// O endpoint oficial de balance é FORBIDDEN para este token (app ClaudeConecte) — validado 2026-07-07.
// Workaround: deriva o saldo do EXTRATO (release_report): BALANCE_AMOUNT da última linha.
// O extrato é gerado sob demanda (~1-3 min). Fluxo: usa o mais recente se fresco (<6h);
// senão dispara a geração e responde o saldo "stale" que tiver (com a data de referência).
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

export async function onRequestGet({ env }) {
  const token = env.MP_ACCESS_TOKEN;
  if (!token) return J({ erro: 'MP_ACCESS_TOKEN ausente no projeto Cloudflare', disponivel: null }, 500);
  const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  try {
    const lst = await (await fetch('https://api.mercadopago.com/v1/account/release_report/list', { headers: H })).json();
    const ordenados = (Array.isArray(lst) ? lst : [])
      .sort((a, b) => (b.end_date || '').localeCompare(a.end_date || '') || (b.date_created || '').localeCompare(a.date_created || ''));
    const maisRecente = ordenados[0] || null;

    const agora = Date.now();
    const fresco = maisRecente && (agora - new Date(maisRecente.date_created).getTime()) < 6 * 3600 * 1000
      && (agora - new Date(maisRecente.end_date).getTime()) < 30 * 3600 * 1000;

    // sem extrato fresco → dispara a geração de um novo (do início do dia anterior até agora)
    if (!fresco) {
      const fim = new Date(agora);
      const ini = new Date(agora - 48 * 3600 * 1000);
      fetch('https://api.mercadopago.com/v1/account/release_report', {
        method: 'POST', headers: H,
        body: JSON.stringify({
          begin_date: ini.toISOString().replace(/\.\d+Z/, 'Z'),
          end_date: fim.toISOString().replace(/\.\d+Z/, 'Z')
        })
      }).catch(() => {});
    }

    if (maisRecente) {
      const csv = await (await fetch('https://api.mercadopago.com/v1/account/release_report/' + encodeURIComponent(maisRecente.file_name), { headers: H })).text();
      const saldo = saldoDoCSV(csv);
      if (saldo !== null) return J({
        disponivel: saldo,
        atualizado: new Date().toISOString(),
        referencia: maisRecente.end_date,           // o saldo é "até" esta data/hora
        fonte: 'release_report',
        gerando: !fresco
      });
    }
    return J({ disponivel: null, gerando: true, aviso: 'extrato MP sendo gerado (~2 min) — atualize em instantes', fonte: 'release_report' });
  } catch (e) {
    return J({ erro: String(e), disponivel: null }, 502);
  }
}
