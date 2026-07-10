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
  const iD = head.indexOf('DATE');
  if (iBal < 0) return null;
  for (let i = L.length - 1; i > 0; i--) {
    const c = L[i].split(';');
    // pula a linha de TOTAIS no rodapé (sem DATE) — o saldo dela vem 0.00 e mascarava o real
    if (!c[iD]) continue;
    if (c[iBal] !== undefined && c[iBal] !== '') { const v = parseFloat(c[iBal]); if (!isNaN(v)) return v; }
  }
  return null;
}

// Movimentos aprovados desde `desdeISO` (imediato, sem esperar extrato), SEPARADOS por direção:
// collector = nós → entrada (líquida); nós como pagador → saída (pagamento feito).
// (antes somava tudo como entrada — pagamento feito inflava a estimativa)
// O MP rotula ERRADO o fuso de date_created dos extratos (dígitos em UTC com sufixo -04:00 →
// parse fica ~4h no futuro e congelava o frescor). Interpretação robusta: o MENOR entre o parse
// normal e os dígitos-como-UTC, nunca no futuro.
function criadoEm(str) {
  const p1 = new Date(str).getTime();
  const p2 = new Date(String(str).replace(/\.\d+/, '').replace(/[+-]\d{2}:?\d{2}$/, 'Z')).getTime();
  const t = Math.min(isNaN(p1) ? Infinity : p1, isNaN(p2) ? Infinity : p2);
  return Math.min(t, Date.now());
}

const CONTA_MP_ID = '3013574234'; // conta CONECTE (vistaconecte@gmail.com)
async function movimentosDesde(H, desdeISO) {
  let ent = 0, sai = 0, offset = 0;
  for (let p = 0; p < 10; p++) {
    const u = `https://api.mercadopago.com/v1/payments/search?range=date_approved&begin_date=${encodeURIComponent(desdeISO)}&end_date=${encodeURIComponent(new Date().toISOString())}&status=approved&limit=50&offset=${offset}`;
    const r = await fetch(u, { headers: H });
    if (!r.ok) break;
    const d = await r.json();
    for (const pay of (d.results || [])) {
      const somos = String(pay.collector_id || (pay.collector && pay.collector.id) || '') === CONTA_MP_ID;
      if (somos) {
        ent += (typeof pay.transaction_details?.net_received_amount === 'number')
          ? pay.transaction_details.net_received_amount : (pay.transaction_amount || 0);
      } else {
        sai += (pay.transaction_amount || 0);
      }
    }
    offset += 50;
    if (!d.paging || offset >= d.paging.total) break;
  }
  return { ent: Math.round(ent * 100) / 100, sai: Math.round(sai * 100) / 100 };
}

export async function onRequestGet({ env }) {
  const token = env.MP_ACCESS_TOKEN;
  if (!token) return J({ erro: 'MP_ACCESS_TOKEN ausente no projeto Cloudflare', disponivel: null }, 500);
  const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  try {
    const lst = await (await fetch('https://api.mercadopago.com/v1/account/release_report/list', { headers: H })).json();
    // HORIZONTE REAL dos dados = min(end_date, date_created): um extrato pode ser pedido com
    // fim no FUTURO (ex.: até 23:59 de hoje), mas os dados só vão até o momento da geração.
    // Confiar no end_date congelava o saldo o dia inteiro (bug corrigido 08/07).
    const horizonte = f => Math.min(new Date(f.end_date).getTime(), criadoEm(f.date_created));
    const maisRecente = (Array.isArray(lst) ? lst : [])
      .filter(f => f.end_date && f.date_created)
      .sort((a, b) => horizonte(b) - horizonte(a))[0] || null;

    const agora = Date.now();
    // frescor = o horizonte de dados tem menos de 1h
    const fimExtrato = maisRecente ? horizonte(maisRecente) : 0;
    const fresco = maisRecente && (agora - fimExtrato) < 15 * 60 * 1000; // quase-tempo-real: exato com ≤15 min
    // evita disparar gerações em rajada: só regenera se o extrato mais recente foi CRIADO há >10 min
    const criadoHa = maisRecente ? (agora - criadoEm(maisRecente.date_created)) : Infinity;

    if (!fresco && criadoHa > 4 * 60 * 1000) {
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
        const refISO = new Date(fimExtrato).toISOString();
        if (fresco) {
          return J({ disponivel: saldoBase, atualizado: new Date().toISOString(), referencia: refISO, fonte: 'release_report', gerando: false });
        }
        // extrato defasado → estimativa direcional: saldo + entradas − pagamentos feitos desde o
        // horizonte (payouts/transferências continuam invisíveis até o próximo extrato)
        const mov = await movimentosDesde(H, refISO);
        return J({
          disponivel: Math.round((saldoBase + mov.ent - mov.sai) * 100) / 100,
          atualizado: new Date().toISOString(),
          referencia: refISO,
          fonte: 'estimativa (extrato ' + refISO.slice(11, 16) + 'Z + movimentos desde então)',
          gerando: true
        });
      }
    }
    return J({ disponivel: null, gerando: true, aviso: 'extrato MP sendo gerado (~2 min) — atualize em instantes', fonte: 'release_report' });
  } catch (e) {
    return J({ erro: String(e), disponivel: null }, 502);
  }
}
