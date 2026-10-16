// Rodada da emissão automática de NF-e (16/10/2026). Roda no GitHub Actions
// (.github/workflows/bling-notas.yml) às 9h e às 14h de Brasília, de segunda a sexta, sem
// Claude e sem computador ligado. Não sabe nada de Bling: só chama o painel, que tem as travas.
//
// Em cada rodada: pega os pedidos pendentes (/api/bling-nfe?acao=pendentes), chama
// acao=emitir&confirmar=1 UM POR VEZ e grava o resumo em /api/bling-nfe-resumo (página
// /notas.html). Para na primeira falha de emissão: nota autorizada só cancela em 24h, então
// erro repetido em lote é pior que pedido esperando a próxima rodada.
//
// Precisa do secret VC_API_TOKEN no repositório (o mesmo API_TOKEN do Pages).
//   node scripts/bling-notas.mjs

const BASE = 'https://vistaconecte.pages.dev';
const MAX_POR_RODADA = 40;

async function chamar(token, caminho, init = {}) {
  const r = await fetch(BASE + caminho, { ...init, headers: { 'X-VC-Token': token, ...(init.headers || {}) } });
  let d = null;
  try { d = await r.json(); } catch { d = { erro: `resposta não-JSON (${r.status})` }; }
  return { status: r.status, d };
}

export async function rodada(token) {
  const resultados = [];
  let erro_geral = null;
  const p = await chamar(token, '/api/bling-nfe?acao=pendentes&dias=2');
  if (p.status !== 200 || !p.d || !Array.isArray(p.d.pedidos)) {
    erro_geral = 'pendentes: ' + ((p.d && p.d.erro) || p.status);
  } else {
    for (const ped of p.d.pedidos.slice(0, MAX_POR_RODADA)) {
      const e = await chamar(token, `/api/bling-nfe?acao=emitir&pedido=${ped.id}&confirmar=1`);
      const d = e.d || {};
      const r = d.resumo || {};
      resultados.push({
        pedido: ped.id, numero: ped.numero, shopify: r.shopify, total: ped.total,
        emitido: !!d.emitido,
        nota: d.nota && d.nota.numero_nota ? d.nota.numero_nota : null,
        motivos: d.decisao ? d.decisao.motivos : [],
        erro: d.erro || (e.status >= 400 ? `HTTP ${e.status}` : null),
      });
      // Travas recusaram = normal, segue. Nota criada e pendente (ex.: item fora da tabela de
      // NCM) é problema SÓ daquele pedido: registra e segue. Falha sem nota criada (Bling fora,
      // token) é do sistema: para tudo, que os próximos iam falhar igual.
      if (d.decisao && d.decisao.emitir && !d.emitido && !d.nota) { erro_geral = `parou no pedido ${ped.numero}: ${d.erro || 'sem detalhe'}`; break; }
      if (e.status >= 500 && !d.decisao) { erro_geral = `parou no pedido ${ped.numero}: ${d.erro || e.status}`; break; }
    }
  }
  await chamar(token, '/api/bling-nfe-resumo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rodada: { resultados, erro_geral } }),
  });
  // O Bling arquiva o pedido na Shopify alguns segundos depois que a nota sai, e ela não quer
  // pedido arquivado. Espera e reabre; repete uma vez pra pegar o que o Bling demorou a fechar.
  const reabertos = [];
  for (const espera of [45e3, 60e3]) {
    await new Promise(r => setTimeout(r, espera));
    const x = await chamar(token, '/api/bling-nfe?acao=reabrir&confirmar=1');
    reabertos.push(...((x.d && x.d.reabertos) || []).filter(o => o.ok).map(o => o.pedido));
  }
  return { emitidas: resultados.filter(x => x.emitido).length, pedidos: resultados.length, reabertos, erro_geral };
}

if (process.argv[1] && process.argv[1].endsWith('bling-notas.mjs')) {
  const token = process.env.VC_API_TOKEN;
  if (!token) { console.error('falta VC_API_TOKEN'); process.exit(1); }
  const r = await rodada(token);
  console.log(JSON.stringify(r));
  if (r.erro_geral) process.exit(1); // o GitHub marca a execução em vermelho e manda e-mail
}
