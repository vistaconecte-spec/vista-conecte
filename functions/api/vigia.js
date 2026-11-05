/**
 * /api/vigia: confere se as automações do notebook estão vivas. Regras em functions/_vigia.js.
 *
 * GET   → o que está errado agora, sem avisar ninguém
 * POST  → confere e, se for o caso, avisa a Bárbara pelo número da loja (template alerta_interno_vi).
 *         Quem chama é .github/workflows/vigia.yml, de hora em hora, com X-VC-Token.
 *
 * O estado só é gravado depois do envio dar certo: aviso que falhou tenta de novo na próxima hora.
 * Env: SUPABASE_ANON_KEY (a chave de serviço não alcança a vc_modelos), CASOS_AVISO_WA, META_ACCESS_TOKEN.
 */
import { SB_URL, json } from '../_bling.js';
import { enviarModeloDaLoja } from '../_whatsapp.js';
import { TEMPLATE_ALERTA } from '../_casos.js';
import { PULSO_ID, ESTADO_ID, problemas, decidir } from '../_vigia.js';

const headers = env => {
  const k = env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { apikey: k, Authorization: 'Bearer ' + k };
};

async function ler(env) {
  const ids = [PULSO_ID, ESTADO_ID, 'etiquetas-resultado'].map(i => `"${i}"`).join(',');
  const r = await fetch(`${SB_URL}/rest/v1/vc_modelos?id=in.(${encodeURIComponent(ids)})&select=id,dados`, { headers: headers(env) });
  if (!r.ok) throw new Error('Supabase ' + r.status);
  const porId = Object.fromEntries((await r.json()).map(l => [l.id, l.dados]));
  return { pulso: porId[PULSO_ID], estado: porId[ESTADO_ID], robo: porId['etiquetas-resultado'] };
}

async function gravarEstado(env, dados) {
  const r = await fetch(`${SB_URL}/rest/v1/vc_modelos?on_conflict=id`, {
    method: 'POST',
    headers: { ...headers(env), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: ESTADO_ID, dados }),
  });
  if (!r.ok) throw new Error('Supabase ao gravar estado ' + r.status);
}

export async function onRequestGet({ env }) {
  try {
    const { pulso, robo, estado } = await ler(env);
    return json({ problemas: problemas(pulso, robo, Date.now()), pulso, estado });
  } catch (e) {
    return json({ erro: e.message }, 502);
  }
}

export async function onRequestPost({ env }) {
  try {
    const agora = Date.now();
    const { pulso, robo, estado } = await ler(env);
    const lista = problemas(pulso, robo, agora);
    const d = decidir(lista, estado, agora);
    if (d.enviar) {
      if (!env.CASOS_AVISO_WA) return json({ erro: 'CASOS_AVISO_WA ausente' }, 500);
      const s = await enviarModeloDaLoja(env, env.CASOS_AVISO_WA, TEMPLATE_ALERTA, [d.enviar]);
      if (s.erro) return json({ erro: s.erro, detalhe: s.detalhe }, 502);
    }
    await gravarEstado(env, d.estado);
    return json({ problemas: lista, avisou: d.enviar });
  } catch (e) {
    return json({ erro: e.message }, 502);
  }
}
