/**
 * /api/bling-auth: começa a autorização do app "Vista Conecte NF-e" no Bling.
 *
 * Atrás do login da dona (o _middleware cuida). Gera um `state` assinado que o
 * /api/bling-callback confere, e manda o navegador pra tela "permitir acesso" do Bling.
 * Depois de permitir, o Bling volta pro callback com o `code` e o token fica guardado
 * cifrado no Supabase (ver functions/_bling.js).
 */
import { BLING_AUTHORIZE, clientId, assinarState, json } from '../_bling.js';

export async function onRequestGet({ env }) {
  if (!env.BLING_CLIENT_SECRET) return json({ erro: 'BLING_CLIENT_SECRET ainda não foi gravado no Pages' }, 500);
  const state = await assinarState(env.SESSION_SECRET);
  const url = `${BLING_AUTHORIZE}?response_type=code&client_id=${encodeURIComponent(clientId(env))}&state=${encodeURIComponent(state)}`;
  return Response.redirect(url, 302);
}
