// Agendador da emissão de NF-e (16/10/2026). Worker separado do Pages porque o Pages não tem
// cron. Não sabe nada de Bling: só chama o painel, que tem todas as travas.
//
// Em cada rodada: pega os pedidos pendentes (/api/bling-nfe?acao=pendentes), chama
// acao=emitir&confirmar=1 UM POR VEZ e grava o resumo em /api/bling-nfe-resumo (página
// /notas.html). Para na primeira falha de emissão: nota autorizada só cancela em 24h, então
// erro repetido em lote é pior que pedido esperando a próxima rodada.
//
// Secret: VC_API_TOKEN (o mesmo API_TOKEN do Pages). Horários no wrangler.toml (UTC).

const BASE = 'https://vistaconecte.pages.dev';
const MAX_POR_RODADA = 40; // limite de subrequisições do plano grátis (50 por execução)

async function chamar(env, caminho, init = {}) {
  const r = await fetch(BASE + caminho, { ...init, headers: { 'X-VC-Token': env.VC_API_TOKEN, ...(init.headers || {}) } });
  let d = null;
  try { d = await r.json(); } catch { d = { erro: `resposta não-JSON (${r.status})` }; }
  return { status: r.status, d };
}

export async function rodada(env) {
  const resultados = [];
  let erro_geral = null;
  const p = await chamar(env, '/api/bling-nfe?acao=pendentes&dias=4');
  if (p.status !== 200 || !p.d || !Array.isArray(p.d.pedidos)) {
    erro_geral = 'pendentes: ' + ((p.d && p.d.erro) || p.status);
  } else {
    for (const ped of p.d.pedidos.slice(0, MAX_POR_RODADA)) {
      const e = await chamar(env, `/api/bling-nfe?acao=emitir&pedido=${ped.id}&confirmar=1`);
      const d = e.d || {};
      const r = d.resumo || {};
      resultados.push({
        pedido: ped.id, numero: ped.numero, shopify: r.shopify, total: ped.total,
        emitido: !!d.emitido,
        nota: d.nota && d.nota.numero_nota ? d.nota.numero_nota : null,
        motivos: d.decisao ? d.decisao.motivos : [],
        erro: d.erro || (e.status >= 400 ? `HTTP ${e.status}` : null),
      });
      // Travas recusaram = normal, segue. Falha DEPOIS de decidir emitir = para tudo.
      if (d.decisao && d.decisao.emitir && !d.emitido) { erro_geral = `parou no pedido ${ped.numero}: ${d.erro || 'sem detalhe'}`; break; }
      if (e.status >= 500 && !d.decisao) { erro_geral = `parou no pedido ${ped.numero}: ${d.erro || e.status}`; break; }
    }
  }
  await chamar(env, '/api/bling-nfe-resumo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rodada: { resultados, erro_geral } }),
  });
  return { emitidas: resultados.filter(x => x.emitido).length, total: resultados.length, erro_geral };
}

export default {
  async scheduled(_evento, env, ctx) {
    ctx.waitUntil(rodada(env));
  },
  // Rodada manual: só com o mesmo token do painel.
  async fetch(request, env) {
    if (request.headers.get('X-VC-Token') !== env.VC_API_TOKEN || !env.VC_API_TOKEN) return new Response('não', { status: 404 });
    return Response.json(await rodada(env));
  },
};
