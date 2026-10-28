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
 * Sai pela Meta como mensagem da loja (_whatsapp.js, desde 26/10/2026; antes pelo token de API do
 * Wati): a Vi NÃO trata como atendente (não pausa).
 * Grava no histórico da Vi (wati_ia_mensagens) para ela saber o que foi mandado e nunca mandar duas.
 *
 * POST { pedido: '#9250', codigo, validade (ISO), item_id }
 */
import { enviarTextoDaLoja, enviarModeloDaLoja } from '../_whatsapp.js';

const API_VERSION = '2026-04';
const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
export const TEMPLATE_TROCA = 'troca_autorizacao_postagem_v1';
const JANELA_MS = 24 * 3600e3 - 15 * 60e3; // margem de 15 min antes de fechar

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// tipo (22/10/2026): a Karina #9185 pediu crédito e recebeu "sua troca está liberada"
const ASSUNTO = {
  troca: p => `sua troca do pedido ${p} está liberada`,
  credito: p => `a devolução do pedido ${p}, que vai virar crédito na loja, está liberada`,
  devolucao: p => `sua devolução do pedido ${p} está liberada`,
};
export function textoConversa({ nome, pedido, codigo, validade, tipo = 'troca' }) {
  const primeiro = String(nome || '').trim().split(/\s+/)[0] || '';
  const dia = validade ? new Date(validade).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';
  return `Oi${primeiro ? ' ' + primeiro : ''}, ${(ASSUNTO[tipo] || ASSUNTO.troca)(pedido)}. O código de postagem dos Correios é ${codigo}`
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
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !(env.WA_TOKEN || env.META_ACCESS_TOKEN)) return json({ erro: 'faltam SUPABASE_SERVICE_ROLE_KEY ou META_ACCESS_TOKEN' }, 500);
  const sbH = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
  const msgId = 'troca_codigo_' + String(b.item_id).replace(/[^\w:-]/g, '');

  try {
    const ja = await (await fetch(`${SB_URL}/rest/v1/wati_ia_mensagens?msg_id=eq.${encodeURIComponent(msgId)}&select=msg_id,created_at`, { headers: sbH })).json();
    if (Array.isArray(ja) && ja.length) return json({ enviado: true, ja_enviado: true, em: ja[0].created_at });
    // Duas peças da mesma troca saem na mesma reversa, com um código só: o aviso vai uma vez por código, não por
    // peça (Taís #9015 recebeu a mesma mensagem duas vezes em 28/10/2026)
    const codigoUrl = encodeURIComponent(codigo.replace(/[^\w-]/g, ''));
    const mesmoCodigo = await (await fetch(`${SB_URL}/rest/v1/wati_ia_mensagens?msg_id=like.troca_codigo_*&texto=like.*${codigoUrl}*&select=msg_id,created_at&limit=1`, { headers: sbH })).json();
    if (Array.isArray(mesmoCodigo) && mesmoCodigo.length) return json({ enviado: true, ja_enviado: true, em: mesmoCodigo[0].created_at });

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
    const texto = textoConversa({ nome, pedido: o.name, codigo, validade: b.validade, tipo: await tipoDoItem(b) });

    const ult = await (await fetch(`${SB_URL}/rest/v1/wati_ia_mensagens?wa_id=in.(${vars.join(',')})&role=eq.user&order=created_at.desc&limit=1&select=wa_id,created_at`, { headers: sbH })).json();
    const ultima = Array.isArray(ult) && ult[0];
    const wa = (ultima && ultima.wa_id) || vars[0];
    let via = null;

    if (ultima && dentroDaJanela(ultima.created_at)) {
      const s = await enviarTextoDaLoja(env, wa, texto);
      if (s.erro) return json({ enviado: false, motivo: 'meta_recusou', detalhe: s.detalhe || s.erro, mensagem: texto });
      via = 'conversa';
    } else {
      // Fora das 24 h: só pelo modelo aprovado (variáveis: nome, pedido, autorização, validade)
      const dia = b.validade ? new Date(b.validade).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';
      const s = await enviarModeloDaLoja(env, wa, TEMPLATE_TROCA, [nome || 'cliente', num, codigo, dia]);
      if (s.erro === 'modelo') return json({ enviado: false, motivo: 'fora_da_janela', mensagem: texto });
      if (s.erro) return json({ enviado: false, motivo: 'meta_recusou', detalhe: s.detalhe || s.erro, mensagem: texto });
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

// Troca (lista retorno) ou devolução (lista estorno: crédito ou dinheiro), pelo item da reversa
export async function tipoDoItem(b) {
  if (b.tipo && ['troca', 'credito', 'devolucao'].includes(b.tipo)) return b.tipo;
  const [lista, id] = String(b.item_id || '').split(':');
  if (lista !== 'estorno') return 'troca';
  try {
    const anon = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhja3pzYmx3eWFibWh6Ympkamd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNTEyOTIsImV4cCI6MjA5NDcyNzI5Mn0.guif8jtidWmfqykhgDgPJiaRbWLoEEDMp1usTlAs1dQ';
    const r = await fetch(`${SB_URL}/rest/v1/vc_modelos?id=eq.estorno&select=dados`, { headers: { apikey: anon, Authorization: 'Bearer ' + anon } });
    const t = ((((await r.json())[0] || {}).dados || {}).itens || []).find(x => x && x.id === id);
    return t && (t.forma === 'credito' || /^cr[ée]dito na loja/i.test(String(t.motivo || ''))) ? 'credito' : 'devolucao';
  } catch (e) { return 'devolucao'; }
}
