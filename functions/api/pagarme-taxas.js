// GET /api/pagarme-taxas?desde=YYYY-MM-DD&ate=YYYY-MM-DD  (somente leitura, diagnóstico)
// Taxa REAL cobrada pelo Pagar.me: para cada transação paga no período, compara o valor
// bruto (amount) com o custo cobrado (cost) e agrupa por número de parcelas.
// Responde a pergunta "quanto pagamos de taxa pro Pagar.me vs quanto pagamos hoje no MP".
// Secret: PAGARME_SECRET_KEY (sk_... do recebedor padrão). API v4 (api.pagar.me/1).
const J = (o, s = 200) => new Response(JSON.stringify(o, null, 2), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

export async function onRequestGet({ env, request }) {
  const sk = env.PAGARME_SECRET_KEY;
  if (!sk) return J({ erro: 'PAGARME_SECRET_KEY ausente no projeto Cloudflare' }, 500);

  const u = new URL(request.url);
  const desde = u.searchParams.get('desde') || '2026-06-01';
  const ate = u.searchParams.get('ate') || '2026-08-31';
  const cents = v => (typeof v === 'number' ? v / 100 : 0);

  const trans = [];
  try {
    // paginação: count máx 1000 por página na v4
    for (let page = 1; page <= 6; page++) {
      const q = new URLSearchParams({
        api_key: sk, count: '250', page: String(page),
        'date_created[gte]': desde + 'T00:00:00-03:00',
        'date_created[lte]': ate + 'T23:59:59-03:00'
      });
      const r = await fetch('https://api.pagar.me/1/transactions?' + q);
      if (!r.ok) return J({ erro: 'pagar.me HTTP ' + r.status, detalhe: (await r.text()).slice(0, 300) }, 502);
      const lote = await r.json();
      if (!Array.isArray(lote) || lote.length === 0) break;
      trans.push(...lote);
      if (lote.length < 250) break;
    }
  } catch (e) { return J({ erro: String(e) }, 502); }

  const pagas = trans.filter(t => t.status === 'paid');
  const porParcela = {};
  let bruto = 0, custo = 0, semCusto = 0;

  for (const t of pagas) {
    const a = cents(t.amount), c = cents(t.cost);
    bruto += a; custo += c;
    if (!t.cost) semCusto++;
    const k = String(t.installments || 1);
    porParcela[k] = porParcela[k] || { qtd: 0, bruto: 0, custo: 0 };
    porParcela[k].qtd++; porParcela[k].bruto += a; porParcela[k].custo += c;
  }
  for (const k of Object.keys(porParcela)) {
    const p = porParcela[k];
    p.bruto = +p.bruto.toFixed(2); p.custo = +p.custo.toFixed(2);
    p.taxa_efetiva_pct = p.bruto ? +(100 * p.custo / p.bruto).toFixed(2) : null;
    p.pct_do_faturamento = bruto ? +(100 * p.bruto / bruto).toFixed(1) : null;
  }

  return J({
    periodo: { desde, ate },
    transacoes_lidas: trans.length,
    transacoes_pagas: pagas.length,
    transacoes_sem_campo_cost: semCusto,
    bruto: +bruto.toFixed(2),
    custo_total: +custo.toFixed(2),
    taxa_efetiva_pct: bruto ? +(100 * custo / bruto).toFixed(2) : null,
    por_parcela: porParcela,
    status_encontrados: [...new Set(trans.map(t => t.status))]
  });
}
