// GET /api/pagarme-taxas?desde=YYYY-MM-DD&ate=YYYY-MM-DD  (somente leitura, diagnóstico)
// Taxa REAL cobrada pelo Pagar.me: para cada transação paga no período, compara o valor
// bruto (amount) com o custo cobrado (cost) e agrupa por número de parcelas.
// Responde a pergunta "quanto pagamos de taxa pro Pagar.me vs quanto pagamos hoje no MP".
// Secret: PAGARME_SECRET_KEY (sk_... do recebedor padrão). API v4 (api.pagar.me/1).
// A v4 NÃO aceita date_created[gte]/[lte] como filtro de query (devolve 400) — por isso
// pagina do mais recente pro mais antigo e corta no código quando passa de `desde`.
const J = (o, s = 200) => new Response(JSON.stringify(o, null, 2), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});
// nunca deixar a api_key vazar em mensagem de erro
const limpa = s => String(s).replace(/api_key=[^&"\s]+/g, 'api_key=***');

export async function onRequestGet({ env, request }) {
  const sk = env.PAGARME_SECRET_KEY;
  if (!sk) return J({ erro: 'PAGARME_SECRET_KEY ausente no projeto Cloudflare' }, 500);

  const u = new URL(request.url);
  const desde = u.searchParams.get('desde') || '2026-06-01';
  const ate = u.searchParams.get('ate') || '2026-08-31';
  const maxPag = Math.min(parseInt(u.searchParams.get('paginas') || '10', 10), 20);
  const cents = v => (typeof v === 'number' ? v / 100 : 0);

  const trans = [];
  let paginas = 0, chegouNoFim = false;
  try {
    for (let page = 1; page <= maxPag; page++) {
      const q = new URLSearchParams({ api_key: sk, count: '250', page: String(page) });
      const r = await fetch('https://api.pagar.me/1/transactions?' + q);
      if (!r.ok) return J({ erro: 'pagar.me HTTP ' + r.status, detalhe: limpa((await r.text()).slice(0, 300)) }, 502);
      const lote = await r.json();
      paginas++;
      if (!Array.isArray(lote) || lote.length === 0) { chegouNoFim = true; break; }
      trans.push(...lote);
      // a v4 devolve da mais recente pra mais antiga: se a última já é anterior ao período, parar
      const ultima = (lote[lote.length - 1].date_created || '').slice(0, 10);
      if (ultima && ultima < desde) { chegouNoFim = true; break; }
      if (lote.length < 250) { chegouNoFim = true; break; }
    }
  } catch (e) { return J({ erro: limpa(e) }, 502); }

  const noPeriodo = trans.filter(t => {
    const d = (t.date_created || '').slice(0, 10);
    return d >= desde && d <= ate;
  });
  const pagas = noPeriodo.filter(t => t.status === 'paid');

  const porParcela = {}, porMes = {};
  let bruto = 0, custo = 0, semCusto = 0;
  for (const t of pagas) {
    const a = cents(t.amount), c = cents(t.cost);
    bruto += a; custo += c;
    if (!t.cost) semCusto++;
    const k = String(t.installments || 1);
    (porParcela[k] = porParcela[k] || { qtd: 0, bruto: 0, custo: 0 });
    porParcela[k].qtd++; porParcela[k].bruto += a; porParcela[k].custo += c;
    const m = (t.date_created || '').slice(0, 7);
    (porMes[m] = porMes[m] || { qtd: 0, bruto: 0, custo: 0 });
    porMes[m].qtd++; porMes[m].bruto += a; porMes[m].custo += c;
  }
  const fecha = o => { for (const k of Object.keys(o)) {
    const p = o[k];
    p.bruto = +p.bruto.toFixed(2); p.custo = +p.custo.toFixed(2);
    p.taxa_efetiva_pct = p.bruto ? +(100 * p.custo / p.bruto).toFixed(2) : null;
    p.pct_do_faturamento = bruto ? +(100 * p.bruto / bruto).toFixed(1) : null;
  } };
  fecha(porParcela); fecha(porMes);

  return J({
    periodo: { desde, ate },
    paginas_lidas: paginas, cobertura_completa: chegouNoFim,
    transacoes_lidas: trans.length, no_periodo: noPeriodo.length, pagas: pagas.length,
    transacoes_sem_campo_cost: semCusto,
    bruto: +bruto.toFixed(2),
    custo_total: +custo.toFixed(2),
    taxa_efetiva_pct: bruto ? +(100 * custo / bruto).toFixed(2) : null,
    por_parcela: porParcela,
    por_mes: porMes,
    status_encontrados: [...new Set(noPeriodo.map(t => t.status))]
  });
}
