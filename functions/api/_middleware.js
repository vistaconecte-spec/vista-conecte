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
// montadas com o que já veio do Supabase. O que eles alcançam é uma ALLOWLIST, e não uma
// lista do que não podem: com denylist, todo endpoint novo nasceria liberado pra oficina
// sem ninguém notar. Cada entrada diz também QUAIS MÉTODOS — sem isso, abrir uma rota de
// leitura abriria junto o POST que ela por acaso também atende.
//
// Só o molde está aqui (29/08/2026): a modelista mandava o molde atualizado no WhatsApp
// peça por peça, e agora o cortador pega o arquivo e imprime direto da aba CORTE.
//   /api/molde             → recorte só-leitura da MODELAGEM, SEM o valor pago à modelista
//   /api/modelagem-storage → baixa o arquivo/imagem cuja chave veio do /api/molde
// Pedido, cliente e preço continuam fora do alcance dos dois perfis.
const OFICINA_LIBERA = new Map([
  ['/api/molde', new Set(['GET'])],
  ['/api/modelagem-storage', new Set(['GET', 'HEAD'])],
]);

// A modelista (perfil 'modelagem', 31/08/2026) entra pela mesma porta e cai direto na aba
// MODELAGEM: ela cria o modelo, sobe croqui/.adsx/foto, preenche medidas e consumo e anota
// alterações e pendências. É a MESMA allowlist por método — o que está fora daqui (pedido,
// estoque, cliente, financeiro, Shopify) responde 403 pra ela como responde pra oficina.
const MODELAGEM_LIBERA = new Map([
  ['/api/modelagem-list', new Set(['GET'])],
  ['/api/modelagem-projeto', new Set(['GET', 'POST'])],
  ['/api/modelagem-upload', new Set(['POST'])],
  ['/api/modelagem-storage', new Set(['GET', 'HEAD'])],
  ['/api/molde', new Set(['GET'])],
]);

// Perfis que só enxergam um pedaço do sistema. Quem não está aqui (hoje só a dona) passa direto.
const RESTRITOS = new Map([
  ['corte', OFICINA_LIBERA],
  ['costura', OFICINA_LIBERA],
  ['modelagem', MODELAGEM_LIBERA],
]);

// `/api/modelagem-projeto` é um endpoint só com várias ações no corpo, e uma delas apaga o
// modelo inteiro (tabelas filhas + arquivos do Storage). Liberar o POST liberaria junto o
// apagar, então a ação destrutiva fica de fora na mão: excluir modelo é da dona.
const MODELAGEM_NEGA_ACOES = new Set(['projeto-excluir']);

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
  const libera = RESTRITOS.get(sessao.perfil);
  if (libera) {
    const metodos = libera.get(pathname);
    if (!metodos || !metodos.has(request.method)) return nega('Perfil sem acesso a esta rota', 403);
    if (sessao.perfil === 'modelagem' && pathname === '/api/modelagem-projeto' && request.method === 'POST') {
      // clone() porque o corpo só pode ser lido uma vez — a function precisa dele inteiro depois.
      const acao = await request.clone().json().then(b => b && b.acao).catch(() => null);
      if (MODELAGEM_NEGA_ACOES.has(acao)) return nega('Perfil sem acesso a esta ação', 403);
    }
  }
  return next();
}
