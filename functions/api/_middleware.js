// Cadeado único de /api/*. O Cloudflare Pages roda este middleware antes de
// QUALQUER function em functions/api/, então os 85 endpoints ficam cobertos sem
// editar nenhum deles — e um endpoint novo já nasce protegido.
import { lerSessao } from '../_sessao.js';

// Rotas que precisam responder sem sessão:
//   login/logout/sessao  → são o próprio jeito de obter a sessão.
//   shopify-callback     → quem chama é o redirect da Shopify depois do OAuth,
//                          uma navegação de OUTRO site; com SameSite=Strict o
//                          cookie não vai junto e a troca de token morreria em
//                          401. Sem o `code` assinado pela Shopify o endpoint
//                          não faz nada, e o token que ele devolve é o da loja
//                          de quem autorizou — não vaza o nosso.
const PUBLICO = new Set(['/api/login', '/api/logout', '/api/sessao', '/api/shopify-callback']);

// Os perfis de oficina ('corte' e 'costura') abrem UMA aba cada — CORTE e COSTURA —,
// montadas com o que já veio do Supabase, e não chamam /api nenhuma vez. Por isso a
// lista do que eles podem é VAZIA, e não uma lista do que não podem: com denylist,
// todo endpoint novo nasceria liberado pra oficina sem ninguém notar.
const OFICINA = new Set(['corte', 'costura']);
const OFICINA_LIBERA = new Set([]);

const nega = (erro, status) => new Response(JSON.stringify({ erro }), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

// Comparação em tempo constante: sem isto dá para descobrir o token byte a byte
// medindo quanto o servidor demora para dizer não.
function igual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const { pathname } = new URL(request.url);

  if (request.method === 'OPTIONS') return next();
  if (PUBLICO.has(pathname)) return next();

  // Falha fechada de propósito: sem o segredo, ninguém entra. O contrário
  // deixaria a API aberta em silêncio se o secret sumisse do projeto.
  if (!env.SESSION_SECRET) return nega('SESSION_SECRET ausente no projeto Cloudflare', 500);

  // Rotinas automáticas (vigia da campanha, alerta de conversão, lembrete de
  // extrato) chamam a API por curl, fora do navegador — não têm cookie. Elas
  // entram por este header. O token é secret do Cloudflare, nunca do repo.
  if (env.API_TOKEN && igual(request.headers.get('X-VC-Token') || '', env.API_TOKEN)) return next();

  const sessao = await lerSessao(request, env.SESSION_SECRET);
  if (!sessao) return nega('Sessão ausente ou expirada', 401);
  if (OFICINA.has(sessao.perfil) && !OFICINA_LIBERA.has(pathname)) {
    return nega('Perfil sem acesso a esta rota', 403);
  }
  return next();
}
