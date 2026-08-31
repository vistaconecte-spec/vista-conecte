// POST /api/login { senha } -> cookie de sessão HttpOnly
// Os hashes ficam em secret do Cloudflare, e não no repo: o repositório é
// público, e SHA-256 sem sal de senha curta cai numa wordlist.
import { assinarSessao } from '../_sessao.js';

const J = (o, s = 200, h = {}) => new Response(JSON.stringify(o), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...h }
});

const sha256hex = async txt => {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
};

export async function onRequestPost({ request, env }) {
  if (!env.SESSION_SECRET || !env.SENHA_DONA_HASH) {
    return J({ erro: 'Login não configurado no projeto Cloudflare' }, 500);
  }
  const { senha } = await request.json().catch(() => ({}));
  if (!senha) return J({ erro: 'Senha ausente' }, 400);

  const hex = await sha256hex(senha);
  const perfil = hex === env.SENHA_DONA_HASH      ? 'dona'
               : hex === env.SENHA_CORTE_HASH     ? 'corte'
               : hex === env.SENHA_COSTURA_HASH   ? 'costura'
               : hex === env.SENHA_MODELAGEM_HASH ? 'modelagem'
               : null;
  if (!perfil) return J({ erro: 'Senha incorreta' }, 401);

  const token = await assinarSessao(perfil, env.SESSION_SECRET);
  return J({ perfil }, 200, {
    'Set-Cookie': `vc_sessao=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`
  });
}
