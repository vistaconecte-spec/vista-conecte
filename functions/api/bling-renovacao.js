// Renovação do acesso do Bling feita FORA da Cloudflare (23/11/2026), por scripts/bling-renovar.mjs no
// GitHub Actions. A Cloudflare do Bling barra o endereço de saída do Pages com 429 "error code: 1015" e
// sem renovar nenhuma nota sai. Endpoint separado do /api/bling-nfe, que de propósito não aceita POST.
//
//   GET  → { refresh_token, expira_em, client_id }
//   POST { access_token, refresh_token, expires_in, scope } → cifra e grava o par novo
//
// Só com o X-VC-Token (nunca pela sessão do navegador), porque devolve o refresh_token.
import { json, refreshAtual, gravarRenovacaoExterna } from '../_bling.js';

function soTokenApi(request, env) {
  const t = request.headers.get('X-VC-Token') || '';
  return !!env.API_TOKEN && t.length === env.API_TOKEN.length && t === env.API_TOKEN;
}

export async function onRequestGet({ request, env }) {
  if (!soTokenApi(request, env)) return json({ erro: 'só com X-VC-Token' }, 403);
  try { return json(await refreshAtual(env)); } catch (e) { return json({ erro: e.message }, 500); }
}

export async function onRequestPost({ request, env }) {
  if (!soTokenApi(request, env)) return json({ erro: 'só com X-VC-Token' }, 403);
  try {
    return json({ ok: true, ...(await gravarRenovacaoExterna(env, await request.json())) });
  } catch (e) {
    return json({ erro: e.message }, 400);
  }
}
