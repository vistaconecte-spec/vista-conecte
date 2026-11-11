/**
 * /api/aviso-interno (exige sessão ou X-VC-Token, como todo /api)
 *
 * POST { texto } → manda um aviso pra Bárbara pelo número da loja (modelo alerta_interno_vi, o mesmo
 * do vigia), no número VIGIA_AVISO_WA. Quem chama é o robô de etiquetas do notebook (11/11/2026):
 * "Preciso receber uma mensagem pedindo saldo na Frenet para pagar todas as reversas", assim que
 * entra reversa nova e o saldo não cobre, e a confirmação quando ele paga.
 */
import { json } from '../_bling.js';
import { enviarModeloDaLoja } from '../_whatsapp.js';
import { TEMPLATE_ALERTA } from '../_casos.js';

export async function onRequestPost({ env, request }) {
  let b = {};
  try { b = await request.json(); } catch { return json({ erro: 'corpo inválido' }, 400); }
  // o WhatsApp não aceita quebra de linha dentro da variável do modelo
  const texto = String(b.texto || '').replace(/\s+/g, ' ').trim().slice(0, 900);
  if (!texto) return json({ erro: 'texto vazio' }, 400);
  if (!env.VIGIA_AVISO_WA) return json({ erro: 'VIGIA_AVISO_WA ausente' }, 500);
  try {
    const s = await enviarModeloDaLoja(env, env.VIGIA_AVISO_WA, TEMPLATE_ALERTA, [texto]);
    if (s.erro) return json({ enviado: false, erro: s.erro, detalhe: s.detalhe }, 502);
    return json({ enviado: true });
  } catch (e) {
    return json({ enviado: false, erro: e.message }, 502);
  }
}
