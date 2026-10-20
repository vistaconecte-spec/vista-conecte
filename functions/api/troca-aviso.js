/**
 * Cloudflare Pages Function: /api/troca-aviso (exige sessão ou X-VC-Token, como todo /api)
 *
 * Manda no WhatsApp da cliente o código de postagem da reversa da troca (etapa 4 do fluxo de
 * trocas, validada com a Bárbara em 20/10/2026). Quem chama é o robô do notebook, logo depois de
 * gerar o código, só das 8h às 21h.
 *
 * O modelo de mensagem da Meta foi recusado 4 vezes como "categoria incorreta" (ela pede revisão
 * no Gerenciador do WhatsApp). Até aprovar:
 *  - cliente que falou com a loja nas últimas 24 h recebe como mensagem comum de conversa (o
 *    WhatsApp permite texto livre nessa janela), com o texto que ela aprovou;
 *  - fora da janela, se o modelo `troca_autorizacao_postagem_v1` já estiver aprovado, vai por ele;
 *  - senão devolve { enviado:false, motivo:'fora_da_janela', mensagem } e o cartão mostra a
 *    mensagem pronta para a Marcelly.
 * Sai pelo token de API do sistema, que a Vi reconhece e NÃO trata como atendente (não pausa).
 * Grava no histórico da Vi (wati_ia_mensagens) para ela saber o que foi mandado e nunca mandar duas.
 *
 * POST { pedido: '#9250', codigo, validade (ISO), item_id }
 */
const API_VERSION = '2026-04';
const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
const WATI_V1 = 'https://live-mt-server.wati.io/1061955/api/v1';
export const TEMPLATE_TROCA = 'troca_autorizacao_postagem_v1';
const JANELA_MS = 24 * 3600e3 - 15 * 60e3; // margem de 15 min antes de fechar

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export function textoConversa({ nome, pedido, codigo, validade }) {
  const primeiro = String(nome || '').trim().split(/\s+/)[0] || '';
  const dia = validade ? new Date(validade).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';
  return `Oi${primeiro ? ' ' + primeiro : ''}, sua troca do pedido ${pedido} está liberada. O código de postagem dos Correios é ${codigo}`
    + (dia ? ` e vale até ${dia}` : '')
    + '. É só levar a peça embalada a uma agência e informar esse código, não precisa imprimir etiqueta nem pagar frete.';
}

// O mesmo número aparece com e sem o 9 nas conversas antigas do Wati
export function variantesWa(tel) {
  let d = String(tel || '').replace(/\D/g, '');
  if (!d) return [];
  if (!d.startsWith('55')) d = '55' + d;
  const v = new Set([d]);
  if (d.length === 13) v.add(d.slice(0, 4) + d.slice(5));
  if (d.length === 12) v.add(d.slice(0, 4) + '9' + d.slice(4));
  return [...v];
}

export function dentroDaJanela(ultimaDaCliente, agora = Date.now()) {
  return !!ultimaDaCliente && agora - new Date(ultimaDaCliente).getTime() < JANELA_MS;
}

export async function onRequestPost({ env, request }) {
  let b = {};
  try { b = await request.json(); } catch { return json({ erro: 'corpo inválido' }, 400); }
  const num = String(b.pedido || '').replace(/\D/g, '');
  const codigo = String(b.codigo || '').trim();
  if (!num || !codigo || !b.item_id) return json({ erro: 'informe pedido, codigo e item_id' }, 400);
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.WATI_TOKEN) return json({ erro: 'faltam SUPABASE_SERVICE_ROLE_KEY ou WATI_TOKEN' }, 500);
  const sbH = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
  const msgId = 'troca_codigo_' + String(b.item_id).replace(/[^\w:-]/g, '');

  try {
    const ja = await (await fetch(`${SB_URL}/rest/v1/wati_ia_mensagens?msg_id=eq.${encodeURIComponent(msgId)}&select=msg_id,created_at`, { headers: sbH })).json();
    if (Array.isArray(ja) && ja.length) return json({ enviado: true, ja_enviado: true, em: ja[0].created_at });

    const r = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST', headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `query($q:String!){ orders(first:1, query:$q){ nodes{ name phone shippingAddress{ firstName name phone } customer{ firstName defaultPhoneNumber{ phoneNumber } } } } }`, variables: { q: `name:#${num}` } }),
    });
    const o = ((await r.json()).data?.orders?.nodes || [])[0];
    if (!o || o.name !== '#' + num) return json({ enviado: false, motivo: 'pedido_nao_encontrado' });
    const tel = o.shippingAddress?.phone || o.phone || o.customer?.defaultPhoneNumber?.phoneNumber;
    const vars = variantesWa(tel);
    if (!vars.length) return json({ enviado: false, motivo: 'sem_telefone' });
    const nome = o.shippingAddress?.firstName || o.customer?.firstName || (o.shippingAddress?.name || '').split(' ')[0];
    const texto = textoConversa({ nome, pedido: o.name, codigo, validade: b.validade });

    const ult = await (await fetch(`${SB_URL}/rest/v1/wati_ia_mensagens?wa_id=in.(${vars.join(',')})&role=eq.user&order=created_at.desc&limit=1&select=wa_id,created_at`, { headers: sbH })).json();
    const ultima = Array.isArray(ult) && ult[0];
    const wa = (ultima && ultima.wa_id) || vars[0];
    let via = null;

    if (ultima && dentroDaJanela(ultima.created_at)) {
      const s = await fetch(`${WATI_V1}/sendSessionMessage/${wa}?messageText=${encodeURIComponent(texto)}`, { method: 'POST', headers: { Authorization: 'Bearer ' + env.WATI_TOKEN } });
      const j = await s.json().catch(() => ({}));
      if (!s.ok || j.result === false || j.ok === false) return json({ enviado: false, motivo: 'wati_recusou', detalhe: JSON.stringify(j).slice(0, 200), mensagem: texto });
      via = 'conversa';
    } else {
      // Fora das 24 h: só pelo modelo aprovado
      const lt = await (await fetch(`${WATI_V1}/getMessageTemplates?pageSize=100`, { headers: { Authorization: 'Bearer ' + env.WATI_TOKEN } })).json().catch(() => ({}));
      const t = (lt.messageTemplates || []).find(x => x.elementName === TEMPLATE_TROCA);
      if (!t || t.status !== 'APPROVED') return json({ enviado: false, motivo: 'fora_da_janela', mensagem: texto });
      const dia = b.validade ? new Date(b.validade).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';
      const params = [{ name: 'nome', value: nome || '' }, { name: 'pedido', value: num }, { name: 'autorizacao', value: codigo }, { name: 'validade', value: dia }];
      const parameters = [...params, ...params.map((p, i) => ({ name: String(i + 1), value: p.value }))];
      const s = await fetch(`${WATI_V1}/sendTemplateMessage?whatsappNumber=${wa}`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + env.WATI_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_name: TEMPLATE_TROCA, broadcast_name: 'troca_' + num + '_' + Date.now(), parameters }),
      });
      const j = await s.json().catch(() => ({}));
      if (!s.ok || j.result !== true) return json({ enviado: false, motivo: 'wati_recusou', detalhe: JSON.stringify(j).slice(0, 200), mensagem: texto });
      via = 'modelo';
    }

    await fetch(`${SB_URL}/rest/v1/wati_ia_mensagens`, {
      method: 'POST', headers: { ...sbH, Prefer: 'return=minimal' },
      body: JSON.stringify({ msg_id: msgId, wa_id: wa, role: 'assistant', texto: `${texto}\n[contexto interno: mensagem automática da troca do pedido ${o.name}, código de postagem ${codigo}. Se ela perguntar, o código também foi para o e-mail da compra, mandado pelos Correios.]` }),
    }).catch(() => {});
    return json({ enviado: true, via, mensagem: texto });
  } catch (e) {
    return json({ enviado: false, motivo: 'erro', detalhe: e.message }, 502);
  }
}
