/**
 * Cloudflare Pages Function: /api/whatsapp  (exige sessão, como toda /api)
 * Caixa de entrada da sub-aba WhatsApp do ATENDIMENTO (etapa 2 do atendimento próprio,
 * 19/10/2026). Regras e fontes em functions/_whatsapp.js.
 *
 * GET  ?acao=conversas[&desde=ISO][&busca=][&filtro=aguardando|pausada]
 *                                             lista (desde = só o que mudou depois)
 * GET  ?acao=conversa&tel=[&desde=ISO]        mensagens de uma conversa
 * GET  ?acao=midia&id=                        foto/áudio/documento da cliente
 * GET  ?acao=modelos                          templates que a equipe pode mandar (aprovados na conta 925)
 * POST {acao:'enviar', tel, texto}            manda texto e pausa a Vi 24 h na conversa
 * POST {acao:'enviar-modelo', tel, modelo, valores}  manda template (com ou sem a janela de 24 h)
 * POST ?acao=enviar-midia&tel=&nome=&legenda= com o arquivo cru no corpo (Content-Type = tipo do arquivo):
 *                                             manda foto ou documento e pausa a Vi 24 h
 *
 * Env: SUPABASE_SERVICE_ROLE_KEY, META_ACCESS_TOKEN (System User api-vista, tem
 * whatsapp_business_messaging) ou WA_TOKEN.
 */
import { json, listarConversas, lerConversa, enviarTexto, enviarMidia, enviarModelo, listarModelos, baixarMidia, envioLiberado, AVISO_ENVIO } from '../_whatsapp.js';

const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/;

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ erro: 'SUPABASE_SERVICE_ROLE_KEY ausente' }, 500);
  const url = new URL(request.url);
  const q = url.searchParams;
  const desde = ISO.test(q.get('desde') || '') ? q.get('desde') : null;
  try {
    if (request.method === 'GET') {
      const acao = q.get('acao');
      if (acao === 'conversas') return json({ conversas: await listarConversas(env, { desde, busca: q.get('busca'), filtro: q.get('filtro'), limite: q.get('limite') }), agora: new Date().toISOString(), envio: envioLiberado(env), aviso_envio: envioLiberado(env) ? null : AVISO_ENVIO });
      if (acao === 'conversa') {
        if (!q.get('tel')) return json({ erro: 'sem telefone' }, 400);
        return json({ ...(await lerConversa(env, q.get('tel'), { desde })), agora: new Date().toISOString() });
      }
      if (acao === 'midia') return baixarMidia(env, q.get('id'));
      if (acao === 'modelos') return json({ modelos: await listarModelos(env) });
      return json({ erro: 'ação desconhecida' }, 400);
    }
    if (request.method === 'POST' && q.get('acao') === 'enviar-midia') {
      const { status, ...resto } = await enviarMidia(env, { tel: q.get('tel'), nome: q.get('nome'), legenda: q.get('legenda'), mime: request.headers.get('Content-Type'), corpo: request.body });
      return json(resto, status);
    }
    if (request.method === 'POST') {
      const b = await request.json().catch(() => ({}));
      if (b.acao !== 'enviar' && b.acao !== 'enviar-modelo') return json({ erro: 'ação desconhecida' }, 400);
      const r = b.acao === 'enviar-modelo' ? await enviarModelo(env, b.tel, b.modelo, b.valores) : await enviarTexto(env, b.tel, b.texto);
      const { status, ...resto } = r;
      return json(resto, status);
    }
    return json({ erro: 'método' }, 405);
  } catch (e) {
    return json({ erro: String(e.message || e) }, 500);
  }
}
