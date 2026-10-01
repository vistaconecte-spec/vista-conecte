// GET /api/mp-extrato?mes=YYYY-MM
// Extrato OFICIAL do Mercado Pago (release_report, CSV linha a linha) do mês fechado inteiro,
// no horário de Brasília. É o arquivo que vai pra contabilidade todo mês.
// O MP gera o relatório sob demanda (~1-3 min): enquanto não existe, dispara a geração e
// responde 202 { gerando:true } — chamar de novo depois.
// Secret: MP_ACCESS_TOKEN.
const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

// mesmo cuidado do mp-movimentos: o MP às vezes rotula errado o fuso do date_created
function criadoEm(str) {
  const p1 = new Date(str).getTime();
  if (!isNaN(p1) && p1 <= Date.now()) return p1;
  const p2 = new Date(String(str).replace(/\.\d+/, '').replace(/[+-]\d{2}:?\d{2}$/, 'Z')).getTime();
  return Math.min(isNaN(p1) ? Infinity : p1, isNaN(p2) ? Infinity : p2, Date.now());
}

// limites do mês em UTC (00:00 de Brasília = 03:00Z)
export function limitesMes(mes) {
  const m = /^(\d{4})-(\d{2})$/.exec(mes || '');
  if (!m) return null;
  const a = +m[1], n = +m[2];
  if (n < 1 || n > 12) return null;
  const ini = Date.UTC(a, n - 1, 1, 3, 0, 0);
  const fim = Date.UTC(a, n, 1, 3, 0, 0) - 1000;   // 23:59:59 do último dia, Brasília
  return { ini, fim };
}

export async function onRequestGet({ request, env }) {
  const tk = env.MP_ACCESS_TOKEN;
  if (!tk) return J({ erro: 'MP_ACCESS_TOKEN ausente' }, 500);
  const H = { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' };
  const mes = new URL(request.url).searchParams.get('mes');
  const lim = limitesMes(mes);
  if (!lim) return J({ erro: 'use ?mes=YYYY-MM' }, 400);
  if (lim.fim > Date.now()) return J({ erro: 'mês ainda não fechou' }, 400);

  try {
    const lst = await (await fetch('https://api.mercadopago.com/v1/account/release_report/list', { headers: H })).json();
    const arr = Array.isArray(lst) ? lst : [];
    // relatório do mês exato: começa no 1º dia, termina no último, e foi gerado depois do fim
    const doMes = arr.filter(f => f.begin_date && f.end_date && f.file_name &&
      Math.abs(new Date(f.begin_date).getTime() - lim.ini) < 60 * 1000 &&
      Math.abs(new Date(f.end_date).getTime() - lim.fim) < 60 * 1000);
    const pronto = doMes.filter(f => f.date_created && criadoEm(f.date_created) > lim.fim)
      .sort((a, b) => criadoEm(b.date_created) - criadoEm(a.date_created))[0];

    if (pronto) {
      const r = await fetch('https://api.mercadopago.com/v1/account/release_report/' + encodeURIComponent(pronto.file_name), { headers: H });
      if (!r.ok) return J({ erro: 'MP devolveu ' + r.status + ' ao baixar ' + pronto.file_name }, 502);
      return new Response(r.body, { headers: {
        'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="extrato-mercadopago-${mes}.csv"`,
        'X-MP-Arquivo': pronto.file_name
      } });
    }

    // ainda não existe: pede ao MP (anti-rajada: só se nenhum pedido do mês nos últimos 5 min)
    const pedidoRecente = doMes.some(f => !f.date_created || Date.now() - criadoEm(f.date_created) < 5 * 60 * 1000);
    let pedido = null;
    if (!pedidoRecente) {
      const iso = t => new Date(t).toISOString().replace(/\.\d+Z/, 'Z');
      try {
        const r = await fetch('https://api.mercadopago.com/v1/account/release_report', {
          method: 'POST', headers: H,
          body: JSON.stringify({ begin_date: iso(lim.ini), end_date: iso(lim.fim) })
        });
        pedido = { status: r.status, resposta: (await r.text()).slice(0, 300) };
      } catch (e) { pedido = { erro: String(e) }; }
    }
    return J({ mes, gerando: true, aviso: 'extrato sendo gerado pelo Mercado Pago, chamar de novo em ~3 min',
      pedido, do_mes: doMes.map(f => ({ begin_date: f.begin_date, end_date: f.end_date, date_created: f.date_created, file_name: f.file_name })),
      recentes: arr.slice(-5).map(f => ({ begin_date: f.begin_date, end_date: f.end_date, date_created: f.date_created, file_name: f.file_name }))
    }, 202);
  } catch (e) {
    return J({ erro: String(e) }, 502);
  }
}
