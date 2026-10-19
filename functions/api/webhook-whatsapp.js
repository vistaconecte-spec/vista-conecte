/**
 * Cloudflare Pages Function: /api/webhook-whatsapp  (PÚBLICA — quem chama é a Meta)
 * Webhook do WhatsApp oficial (Cloud API), etapa 1 do atendimento próprio: só grava.
 * Ver functions/_whatsapp.js.
 *
 * GET  = verificação da Meta na hora de inscrever (hub.verify_token = WEBHOOK_KEY).
 * POST = avisos (mensagens e status). A URL inscrita leva ?k=WEBHOOK_KEY; com WA_APP_SECRET no
 *        projeto, a assinatura X-Hub-Signature-256 também é exigida.
 *
 * Erro ao gravar devolve 500 de propósito: a Meta reenvia por até 7 dias, e a mensagem
 * repetida é ignorada pelo wamid.
 */
import { igual, json, extrair, assinaturaValida, gravarEvento, gravarMensagens, gravarStatus } from '../_whatsapp.js';

export async function repassarParaVi(env, mensagens) {
  try {
    const r = await fetch(env.VI_META_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mensagens: mensagens.map(m => ({ wamid: m.wamid, telefone: m.telefone, nome_contato: m.nome_contato, bruto: m.bruto })) }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (e) {
    // fica no wa_eventos para dar para achar e reprocessar
    try { await gravarEvento(env, { erro_repasse_vi: String(e.message || e), wamids: mensagens.map(m => m.wamid) }); } catch (e2) {}
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!env.WEBHOOK_KEY) return json({ erro: 'WEBHOOK_KEY ausente' }, 500);

  if (request.method === 'GET') {
    const modo = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token') || '';
    if (modo === 'subscribe' && igual(token, env.WEBHOOK_KEY)) {
      return new Response(url.searchParams.get('hub.challenge') || '', { headers: { 'Content-Type': 'text/plain' } });
    }
    return json({ erro: 'não autorizado' }, 403);
  }
  if (request.method !== 'POST') return json({ erro: 'método' }, 405);
  if (!igual(url.searchParams.get('k') || '', env.WEBHOOK_KEY)) return json({ erro: 'não autorizado' }, 401);

  const texto = await request.text();
  if (env.WA_APP_SECRET && !(await assinaturaValida(env.WA_APP_SECRET, texto, request.headers.get('X-Hub-Signature-256')))) {
    return json({ erro: 'assinatura' }, 401);
  }
  let corpo;
  try { corpo = JSON.parse(texto); } catch (e) { return json({ erro: 'json' }, 400); }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ erro: 'SUPABASE_SERVICE_ROLE_KEY ausente' }, 500);

  const { mensagens, status } = extrair(corpo);
  try {
    await gravarEvento(env, corpo);
    await gravarMensagens(env, mensagens);
    for (const s of status) await gravarStatus(env, s);
  } catch (e) {
    return json({ erro: String(e.message || e) }, 500);
  }
  // Etapa 3: a mensagem da cliente segue para a Vi (vista-wati-ia /webhook/meta). Quem decide se ela responde por
  // este caminho ou pelo Wati é a própria Vi (wati_ia_config.canal_whatsapp). Depois de gravar, para a Meta já
  // ter o 200 garantido; repetida não é problema, a Vi descarta pelo wamid.
  if (env.VI_META_URL && mensagens.length && context.waitUntil) context.waitUntil(repassarParaVi(env, mensagens));
  return json({ ok: true, mensagens: mensagens.length, status: status.length });
}
