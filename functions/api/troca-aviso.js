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
 *  - 11/11/2026 (Bárbara: "isso já precisaria estar automático"): fora da janela e sem o modelo da
 *    troca, manda UMA vez por pedido o modelo aprovado continuidade_solicitacao_v1 ("é só responder
 *    esta mensagem"). Quando ela responde a janela abre e o robô, que repete de 15 em 15 min, manda o
 *    código. A Meta recusou na hora mais dois textos do código (troca_codigo_postagem_v2 e
 *    pedido_autorizacao_postagem_v3), sempre como "categoria incorreta".
 * Sai pela Meta como mensagem da loja (_whatsapp.js, desde 26/10/2026; antes pelo token de API do
 * Wati): a Vi NÃO trata como atendente (não pausa).
 * Grava no histórico da Vi (wati_ia_mensagens) para ela saber o que foi mandado e nunca mandar duas.
 *
 * POST { pedido: '#9250', codigo, validade (ISO), item_id }
 */
import { enviarTextoDaLoja, enviarModeloDaLoja, enviarArquivoDaLoja } from '../_whatsapp.js';

const API_VERSION = '2026-04';
const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
export const TEMPLATE_TROCA = 'troca_autorizacao_postagem_v1';
export const TEMPLATE_ABRIR = 'continuidade_solicitacao_v1'; // params nome, assunto (aprovado, utility)
const JANELA_MS = 24 * 3600e3 - 15 * 60e3; // margem de 15 min antes de fechar

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// tipo (22/10/2026): a Karina #9185 pediu crédito e recebeu "sua troca está liberada"
const ASSUNTO = {
  troca: p => `sua troca do pedido ${p} está liberada`,
  credito: p => `a devolução do pedido ${p}, que vai virar crédito na loja, está liberada`,
  devolucao: p => `sua devolução do pedido ${p} está liberada`,
};
// comum (13/11/2026): etiqueta comum de devolução, quando a Frenet trava a reversa. Vai com o PDF na mesma
// mensagem e a cliente imprime. renovado: o código anterior venceu sem postagem e o robô gerou outro, o último.
export function textoConversa({ nome, pedido, codigo, validade, tipo = 'troca', comum = false, renovado = false }) {
  const primeiro = String(nome || '').trim().split(/\s+/)[0] || '';
  const dia = validade ? new Date(validade).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';
  return `Oi${primeiro ? ' ' + primeiro : ''}, ${(ASSUNTO[tipo] || ASSUNTO.troca)(pedido)}. O código de postagem dos Correios é ${codigo}`
    + (dia ? ` e vale até ${dia}` : '')
    + (comum
      ? '. A etiqueta está neste PDF, é só imprimir, colar no pacote e levar a uma agência dos Correios. O frete já está pago.'
      : '. É só levar a peça embalada a uma agência e informar esse código, não precisa imprimir etiqueta nem pagar frete.')
    + (dia ? ' Depois dessa data o código é cancelado.' : '')
    + (renovado ? ' Esse código é novo, porque o anterior venceu sem a postagem, e é o último que conseguimos gerar para essa troca.' : '');
}

// Prazo de 7 dias para postar (Bárbara, 13/11/2026: "elas têm 7 dias, depois disso precisamos automaticamente cancelar")
export function textoCancelado({ nome, pedido, codigo }) {
  const primeiro = String(nome || '').trim().split(/\s+/)[0] || '';
  return `Oi${primeiro ? ' ' + primeiro : ''}, o prazo de 7 dias pra postar a devolução do pedido ${pedido} terminou e o código ${codigo} foi cancelado. Se você ainda quiser devolver, é só me chamar por aqui.`;
}
export async function quandoEnviado(env, codigo) {
  const c = String(codigo || '').replace(/[^\w]/g, '');
  if (!c || !env.SUPABASE_SERVICE_ROLE_KEY) return { enviado_em: null };
  const h = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY };
  const [a, w] = await Promise.all([
    fetch(`${SB_URL}/rest/v1/wati_ia_mensagens?role=in.(assistant,operador)&texto=like.*${c}*&select=created_at&order=created_at.asc&limit=1`, { headers: h }).then(r => r.json()).catch(() => []),
    fetch(`${SB_URL}/rest/v1/wa_mensagens?direcao=eq.saida&texto=like.*${c}*&select=recebida_em&order=recebida_em.asc&limit=1`, { headers: h }).then(r => r.json()).catch(() => []),
  ]);
  const datas = [Array.isArray(a) && a[0] && a[0].created_at, Array.isArray(w) && w[0] && w[0].recebida_em].filter(Boolean).sort();
  return { enviado_em: datas[0] || null };
}
// Etiqueta feita à mão: o pedido mais recente cuja entrega está no nome exato da remetente
async function pedidoPeloNome(env, nome) {
  const norm = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const r = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST', headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `query($q:String!){ orders(first:10, query:$q, sortKey:CREATED_AT, reverse:true){ nodes{ name totalPriceSet{ shopMoney{ amount } } shippingAddress{ name } } } }`, variables: { q: String(nome) } }),
  });
  const ns = ((await r.json()).data?.orders?.nodes || []).filter(o => norm(o.shippingAddress?.name) === norm(nome) && Number(o.totalPriceSet?.shopMoney?.amount) > 0);
  return ns.length ? ns[0].name.replace(/\D/g, '') : '';
}

// Modelo de continuidade (13/11/2026, Bárbara: "não pode depender de ninguém"): antes ia uma vez só e, se a
// cliente não respondesse, o código nunca chegava. Agora repete a cada 3 dias, até 3 vezes, enquanto o código vale.
export const ABRIR_INTERVALO_MS = 3 * 86400e3, ABRIR_MAX = 3;
export function proximaAbertura(base, anteriores, agora = Date.now()) {
  const minhas = (anteriores || []).filter(x => x && new RegExp('^' + base + '(_\\d+)?$').test(x.msg_id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (minhas.length >= ABRIR_MAX) return null;
  if (minhas.length && agora - new Date(minhas[0].created_at).getTime() < ABRIR_INTERVALO_MS) return null;
  return minhas.length ? `${base}_${minhas.length + 1}` : base;
}

function pdfDoCorpo(b64, nome) {
  if (!b64) return null;
  const bin = atob(String(b64));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], nome, { type: 'application/pdf' });
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
  // Quando o código chegou à cliente (13/11/2026): o prazo de 7 dias para postar conta daí, não da criação da etiqueta
  if (b.quando_enviado) return json(await quandoEnviado(env, String(b.quando_enviado)));
  let num = String(b.pedido || '').replace(/\D/g, '');
  const codigo = String(b.codigo || '').trim();
  // cancelado (13/11/2026): o prazo de 7 dias para postar passou e o robô cancelou a etiqueta. Etiqueta feita à mão
  // não tem pedido ligado: vem o nome da remetente e o pedido é achado na Shopify pelo nome.
  const cancelado = !!b.cancelado;
  if (!codigo || (!cancelado && (!num || !b.item_id)) || (cancelado && !num && !b.nome)) return json({ erro: 'informe pedido (ou nome), codigo e item_id' }, 400);
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !(env.WA_TOKEN || env.META_ACCESS_TOKEN)) return json({ erro: 'faltam SUPABASE_SERVICE_ROLE_KEY ou META_ACCESS_TOKEN' }, 500);
  const sbH = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
  // código renovado (o anterior venceu) é outro aviso do mesmo item: id próprio para não cair no "já mandado"
  const msgId = cancelado ? 'troca_cancelado_' + codigo.replace(/[^\w-]/g, '')
    : 'troca_codigo_' + String(b.item_id).replace(/[^\w:-]/g, '') + (b.renovado ? '_renovado' : '');

  try {
    const ja = await (await fetch(`${SB_URL}/rest/v1/wati_ia_mensagens?msg_id=eq.${encodeURIComponent(msgId)}&select=msg_id,created_at`, { headers: sbH })).json();
    if (Array.isArray(ja) && ja.length) return json({ enviado: true, ja_enviado: true, em: ja[0].created_at });
    // Duas peças da mesma troca saem na mesma reversa, com um código só: o aviso vai uma vez por código, não por
    // peça (Taís #9015 recebeu a mesma mensagem duas vezes em 28/10/2026)
    const codigoUrl = encodeURIComponent(codigo.replace(/[^\w-]/g, ''));
    const mesmoCodigo = cancelado ? [] : await (await fetch(`${SB_URL}/rest/v1/wati_ia_mensagens?msg_id=like.troca_codigo_*&texto=like.*${codigoUrl}*&select=msg_id,created_at&limit=1`, { headers: sbH })).json();
    if (Array.isArray(mesmoCodigo) && mesmoCodigo.length) return json({ enviado: true, ja_enviado: true, em: mesmoCodigo[0].created_at });
    if (!num && b.nome) num = await pedidoPeloNome(env, b.nome);
    if (!num) return json({ enviado: false, motivo: 'pedido_nao_encontrado' });

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
    const comum = !cancelado && !!b.comum;
    const texto = cancelado ? textoCancelado({ nome, pedido: o.name, codigo })
      : textoConversa({ nome, pedido: o.name, codigo, validade: b.validade, tipo: await tipoDoItem(b), comum, renovado: !!b.renovado });
    const pdf = comum ? pdfDoCorpo(b.pdf_b64, `etiqueta-devolucao-${num}.pdf`) : null;
    if (comum && !pdf) return json({ enviado: false, motivo: 'sem_pdf', mensagem: texto });

    const ult = await (await fetch(`${SB_URL}/rest/v1/wati_ia_mensagens?wa_id=in.(${vars.join(',')})&role=eq.user&order=created_at.desc&limit=1&select=wa_id,created_at`, { headers: sbH })).json();
    const ultima = Array.isArray(ult) && ult[0];
    const wa = (ultima && ultima.wa_id) || vars[0];
    let via = null;

    if (ultima && dentroDaJanela(ultima.created_at)) {
      // etiqueta comum: o PDF com o texto como legenda, numa mensagem só
      const s = pdf ? await enviarArquivoDaLoja(env, wa, pdf, texto) : await enviarTextoDaLoja(env, wa, texto);
      if (s.erro) return json({ enviado: false, motivo: 'meta_recusou', detalhe: s.detalhe || s.erro, mensagem: texto });
      via = 'conversa';
    } else {
      // Fora das 24 h: só pelo modelo aprovado (variáveis: nome, pedido, autorização, validade)
      const dia = b.validade ? new Date(b.validade).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';
      // A etiqueta comum precisa do PDF, que modelo não leva: sempre abre a conversa primeiro
      const s = (comum || cancelado) ? { erro: 'modelo' } : await enviarModeloDaLoja(env, wa, TEMPLATE_TROCA, [nome || 'cliente', num, codigo, dia]);
      if (s.erro === 'modelo') {
        const aberta = await abrirConversa(env, sbH, wa, nome, o.name);
        return json({ enviado: false, motivo: 'fora_da_janela', conversa_aberta: aberta, mensagem: texto });
      }
      if (s.erro) return json({ enviado: false, motivo: 'meta_recusou', detalhe: s.detalhe || s.erro, mensagem: texto });
      via = 'modelo';
    }

    await fetch(`${SB_URL}/rest/v1/wati_ia_mensagens`, {
      method: 'POST', headers: { ...sbH, Prefer: 'return=minimal' },
      body: JSON.stringify({ msg_id: msgId, wa_id: wa, role: 'assistant', texto: cancelado ? `${texto}\n[contexto interno: o robô cancelou o código ${codigo} do pedido ${o.name} porque ela não postou em 7 dias (regra da Bárbara). Se ela quiser devolver, registre o caso para a equipe; não gere nem prometa código novo.]` : `${texto}\n[contexto interno: mensagem automática da troca do pedido ${o.name}, código de postagem ${codigo}. Se ela perguntar, o código também foi para o e-mail da compra, mandado pelos Correios.]` }),
    }).catch(() => {});
    return json({ enviado: true, via, mensagem: texto });
  } catch (e) {
    return json({ enviado: false, motivo: 'erro', detalhe: e.message }, 502);
  }
}

// O modelo aprovado de continuidade, para a cliente responder e a janela abrir: a cada 3 dias, até 3 vezes por pedido.
// Devolve true (mandou agora), 'ja_pedida' (mandou há menos de 3 dias ou já foram 3) ou false (a Meta não aceitou).
async function abrirConversa(env, sbH, wa, nome, pedido) {
  const base = 'troca_abrir_' + String(pedido).replace(/\D/g, '');
  const ant = await (await fetch(`${SB_URL}/rest/v1/wati_ia_mensagens?msg_id=like.${base}*&select=msg_id,created_at&limit=20`, { headers: sbH })).json();
  const id = proximaAbertura(base, Array.isArray(ant) ? ant : []);
  if (!id) return 'ja_pedida';
  const s = await enviarModeloDaLoja(env, wa, TEMPLATE_ABRIR, [nome || 'cliente', `troca do pedido ${pedido}`]);
  if (s.erro) return false;
  await fetch(`${SB_URL}/rest/v1/wati_ia_mensagens`, {
    method: 'POST', headers: { ...sbH, Prefer: 'return=minimal' },
    body: JSON.stringify({ msg_id: id, wa_id: wa, role: 'assistant', texto: `${s.texto || ''}\n[contexto interno: mensagem automática para reabrir a conversa, porque o código de postagem da troca do pedido ${pedido} já saiu e o WhatsApp não deixa mandar fora das 24 h. Quando ela responder, o código chega sozinho em poucos minutos numa mensagem da loja. Não invente nem repita código.]` }),
  }).catch(() => {});
  return true;
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
