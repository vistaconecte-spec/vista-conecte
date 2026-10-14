/**
 * /api/bling-callback: volta do "permitir acesso" do Bling (link de redirecionamento do app).
 *
 * É PÚBLICO no _middleware pelo mesmo motivo do shopify-callback: é uma navegação vinda de
 * outro site, e o cookie de sessão (SameSite=Strict) não vem junto. Quem garante que foi a
 * dona que começou é o `state` assinado pelo /api/bling-auth; sem ele nada é trocado.
 */
import { stateValido, trocarCodigo } from '../_bling.js';

const pagina = (titulo, texto, status = 200) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${titulo}</title><body style="font-family:system-ui;max-width:520px;margin:48px auto;padding:0 16px">` +
  `<h2>${titulo}</h2><p>${texto}</p><p><a href="/">Voltar ao painel</a></p></body>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
);

export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;
  if (q.get('error')) return pagina('Bling não autorizado', 'O Bling devolveu: ' + String(q.get('error_description') || q.get('error')).replace(/[<>&]/g, ''), 400);
  if (!(await stateValido(q.get('state'), env.SESSION_SECRET))) {
    return pagina('Link vencido ou inválido', 'Abra a autorização de novo pelo painel (/api/bling-auth). O link vale 15 minutos.', 400);
  }
  const code = q.get('code');
  if (!code) return pagina('Faltou o código', 'O Bling não mandou o código de autorização.', 400);
  try {
    await trocarCodigo(env, code);
  } catch (e) {
    return pagina('Erro ao conectar', String(e.message).replace(/[<>&]/g, ''), 502);
  }
  return pagina('Bling conectado', 'O painel já consegue ler os pedidos e as notas do Bling. Pode fechar esta aba.');
}
