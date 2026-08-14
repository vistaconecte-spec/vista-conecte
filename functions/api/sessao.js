// GET /api/sessao -> { perfil } ou 401. O boot do app chama isto para saber se
// a sessão ainda vale: o localStorage deixa de ser a fonte da verdade (ele
// dizia "já entrou" para sempre, mesmo com a sessão vencida no servidor).
import { lerSessao } from '../_sessao.js';

export async function onRequestGet({ request, env }) {
  const s = env.SESSION_SECRET ? await lerSessao(request, env.SESSION_SECRET) : null;
  return new Response(JSON.stringify(s ? { perfil: s.perfil } : { erro: 'sem sessão' }), {
    status: s ? 200 : 401,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
