/**
 * /api/bling-nfe-resumo: o que a emissão automática fez (página /notas.html).
 *
 * GET               → rodadas dos últimos 7 dias (doc bling-nfe-rodada:<dia>)
 * POST {rodada}     → o agendador (workers/bling-cron) grava o resultado de uma rodada
 *
 * Os dois passam pelo _middleware: sessão da dona ou header X-VC-Token.
 */
import { json } from '../_bling.js';
import { gravarRodada, lerRodadas } from '../_bling-nfe.js';

export async function onRequestGet({ env }) {
  try {
    return json({ rodadas_por_dia: await lerRodadas(env, 7) });
  } catch (e) {
    return json({ erro: e.message }, 502);
  }
}

export async function onRequestPost({ request, env }) {
  let corpo;
  try { corpo = await request.json(); } catch { return json({ erro: 'JSON inválido' }, 400); }
  const r = corpo && corpo.rodada;
  if (!r || !Array.isArray(r.resultados)) return json({ erro: 'falta rodada.resultados' }, 400);
  const dia = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const rodada = {
    em: new Date().toISOString(),
    emitidas: r.resultados.filter(x => x.emitido).length,
    resultados: r.resultados.slice(0, 80).map(x => ({
      pedido: x.pedido, numero: x.numero, shopify: x.shopify || null, total: x.total ?? null,
      emitido: !!x.emitido, nota: x.nota || null, motivos: (x.motivos || []).slice(0, 5), erro: x.erro ? String(x.erro).slice(0, 300) : null,
    })),
    erro_geral: r.erro_geral ? String(r.erro_geral).slice(0, 300) : null,
  };
  try {
    await gravarRodada(env, dia, rodada);
    return json({ ok: true, dia, emitidas: rodada.emitidas });
  } catch (e) {
    return json({ erro: e.message }, 502);
  }
}
