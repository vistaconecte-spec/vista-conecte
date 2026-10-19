/**
 * WhatsApp oficial direto na Meta (Cloud API), sem o Wati no meio.
 *
 * ETAPA 1 (19/10/2026): só RECEBER. O app Meta "claude" (1007187805378924, portfólio CONECTE)
 * fica inscrito na WABA 838934162193647 em paralelo com o Wati, e cada aviso da Meta é gravado
 * em wa_mensagens / wa_eventos (sql/wa-mensagens.sql). Ninguém responde por aqui ainda: a Vi e
 * a equipe continuam no Wati até a gente conferir que chega tudo igual.
 *
 * O número é da loja (dono da WABA = CONECTE, platform_type CLOUD_API), então dois apps podem
 * ouvir o mesmo número ao mesmo tempo. Só que a Meta NÃO manda eco do que o outro app envia:
 * do que o Wati/Vi mandam, aqui só aparece o status (sent/delivered/read), sem o texto.
 */
import { SB_URL } from './_bling.js';

export const WABA_ID = '838934162193647';
export const PHONE_NUMBER_ID = '910542668806764';

const RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

export function igual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const quando = ts => (ts ? new Date(Number(ts) * 1000).toISOString() : null);

// Texto legível de qualquer tipo de mensagem: o que a equipe veria no balão.
export function textoDa(m) {
  const t = m.type;
  if (t === 'text') return (m.text && m.text.body) || '';
  if (['image', 'video', 'document', 'audio', 'sticker'].includes(t)) {
    const x = m[t] || {};
    return x.caption || x.filename || null;
  }
  if (t === 'button') return (m.button && (m.button.text || m.button.payload)) || null;
  if (t === 'interactive') {
    const i = m.interactive || {};
    const r = i.button_reply || i.list_reply || i.nfm_reply;
    return (r && (r.title || r.body)) || null;
  }
  if (t === 'reaction') return (m.reaction && m.reaction.emoji) || null;
  if (t === 'location') {
    const l = m.location || {};
    return [l.name, l.address, `${l.latitude},${l.longitude}`].filter(Boolean).join(' | ');
  }
  if (t === 'contacts') return (m.contacts || []).map(c => (c.name && c.name.formatted_name) || '').filter(Boolean).join(', ') || null;
  if (t === 'order') return `pedido do catálogo (${((m.order && m.order.product_items) || []).length} itens)`;
  if (t === 'system') return (m.system && m.system.body) || null;
  return null;
}

// Corpo do webhook → linhas para gravar. Ignora o que não é do nosso número.
export function extrair(corpo) {
  const mensagens = [], status = [];
  if (!corpo || corpo.object !== 'whatsapp_business_account') return { mensagens, status };
  for (const entry of corpo.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (ch.field !== 'messages') continue;
      if (v.metadata && String(v.metadata.phone_number_id) !== PHONE_NUMBER_ID) continue;
      const nomes = {};
      for (const c of v.contacts || []) nomes[c.wa_id] = c.profile && c.profile.name;
      for (const m of v.messages || []) {
        const midia = m[m.type] && m[m.type].id ? m[m.type] : null;
        mensagens.push({
          wamid: m.id,
          telefone: String(m.from || '').replace(/\D/g, ''),
          direcao: 'entrada',
          tipo: m.type || null,
          texto: textoDa(m),
          midia_id: midia ? String(midia.id) : null,
          midia_mime: midia ? midia.mime_type || null : null,
          nome_contato: nomes[m.from] || null,
          resposta_a: (m.context && m.context.id) || (m.reaction && m.reaction.message_id) || null,
          enviada_em: quando(m.timestamp),
          bruto: m,
        });
      }
      for (const s of v.statuses || []) {
        status.push({
          wamid: s.id,
          telefone: String(s.recipient_id || '').replace(/\D/g, ''),
          status: s.status,
          status_rank: RANK[s.status] || 0,
          status_em: quando(s.timestamp),
          erro: s.errors && s.errors.length ? s.errors : null,
          bruto: s,
        });
      }
    }
  }
  return { mensagens, status };
}

// HMAC-SHA256 do corpo com o segredo do app (header X-Hub-Signature-256: sha256=<hex>).
export async function assinaturaValida(segredo, corpoTexto, header) {
  if (!header || !header.startsWith('sha256=')) return false;
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(corpoTexto));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return igual(hex, header.slice(7));
}

// ── Supabase (service_role: as tabelas wa_* não abrem para a chave anon) ─────

function sb(env, extra) {
  const k = env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json', ...(extra || {}) };
}

async function ok(r, onde) {
  if (r.ok) return r;
  throw new Error(`${onde}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}

export async function gravarEvento(env, corpo) {
  await ok(await fetch(`${SB_URL}/rest/v1/wa_eventos`, {
    method: 'POST', headers: sb(env, { Prefer: 'return=minimal' }), body: JSON.stringify({ corpo }),
  }), 'wa_eventos');
}

// Mesma mensagem pode chegar duas vezes (a Meta reenvia se a gente demorar): ignora a repetida.
export async function gravarMensagens(env, linhas) {
  if (!linhas.length) return;
  await ok(await fetch(`${SB_URL}/rest/v1/wa_mensagens?on_conflict=wamid`, {
    method: 'POST', headers: sb(env, { Prefer: 'resolution=ignore-duplicates,return=minimal' }), body: JSON.stringify(linhas),
  }), 'wa_mensagens');
}

// Status só anda pra frente (read que chega antes do delivered não volta). Se a mensagem não
// existe aqui (foi o Wati que mandou), nasce uma linha de saída só com o status.
export async function gravarStatus(env, s) {
  const campos = { status: s.status, status_rank: s.status_rank, status_em: s.status_em, erro: s.erro };
  const r = await ok(await fetch(`${SB_URL}/rest/v1/wa_mensagens?wamid=eq.${encodeURIComponent(s.wamid)}&status_rank=lt.${s.status_rank}`, {
    method: 'PATCH', headers: sb(env, { Prefer: 'return=representation' }), body: JSON.stringify(campos),
  }), 'wa_mensagens status');
  const mudou = await r.json().catch(() => []);
  if (Array.isArray(mudou) && mudou.length) return;
  await ok(await fetch(`${SB_URL}/rest/v1/wa_mensagens?on_conflict=wamid`, {
    method: 'POST', headers: sb(env, { Prefer: 'resolution=ignore-duplicates,return=minimal' }),
    body: JSON.stringify([{ wamid: s.wamid, telefone: s.telefone, direcao: 'saida', ...campos, enviada_em: s.status_em, bruto: s.bruto }]),
  }), 'wa_mensagens status novo');
}

// ── Etapa 2: caixa de entrada da equipe (sub-aba WhatsApp do ATENDIMENTO) ────
//
// Enquanto o Wati estiver ligado, a conversa vem de DUAS fontes: wa_mensagens (o que chega
// direto da Meta e o que a equipe manda por aqui) e wati_ia_mensagens (o histórico da Vi:
// cliente, Vi e equipe pelo Wati). A mesma cliente pode estar com e sem o 9.

const GRAPH = 'https://graph.facebook.com/v23.0';
export const JANELA_MS = 24 * 3600e3;
export const PAUSA_VI_MS = 24 * 3600e3; // igual ao PAUSA_HUMANO_MS do worker da Vi

// Mesma regra da wa_chave() do banco (sql/wa-conversas.sql).
export function chave(t) {
  t = String(t || '').replace(/\D/g, '');
  return (t.length === 13 && t.startsWith('55') && t[4] === '9') ? t.slice(0, 4) + t.slice(5) : t;
}
// As duas grafias do mesmo celular brasileiro (sem e com o 9).
export function variantes(t) {
  const c = chave(t);
  return (c.length === 12 && c.startsWith('55') && /[6-9]/.test(c[4])) ? [c, c.slice(0, 4) + '9' + c.slice(4)] : [c];
}

const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// Junta as duas fontes numa conversa só, sem repetir o que veio pelas duas.
//  wa: linhas de wa_mensagens   vi: linhas de wati_ia_mensagens
export function mesclar(wa, vi) {
  const out = [];
  const entradas = [];
  const daVi = [];       // o que a Vi mandou direto pela Meta (etapa 3): o histórico dela tem o mesmo texto
  const templates = [];  // templates que saíram pela Meta: a nota "[contexto interno" do mesmo envio fica escondida
  const nossos = new Set();
  for (const m of wa || []) {
    const quando = m.enviada_em || m.recebida_em;
    if (m.direcao === 'entrada') {
      entradas.push({ t: Date.parse(quando), texto: norm(m.texto), midia: !!m.midia_id });
      out.push({ id: m.wamid, quando, lado: 'cliente', texto: m.texto, tipo: m.tipo, midia_id: m.midia_id, mime: m.midia_mime, resposta_a: m.resposta_a });
    } else if (m.texto) {
      nossos.add('op_' + m.wamid);
      const lado = m.origem === 'vi' ? 'vi' : m.origem === 'template' ? 'auto' : 'equipe';
      if (lado === 'vi') daVi.push({ t: Date.parse(quando), texto: norm(m.texto) });
      if (lado === 'auto') templates.push(Date.parse(quando));
      out.push({ id: m.wamid, quando, lado, texto: m.texto, tipo: m.tipo, status: m.status, erro: m.erro });
    }
  }
  for (const m of vi || []) {
    if (nossos.has(m.msg_id)) continue;
    const texto = m.texto || '';
    const t = Date.parse(m.created_at);
    if (m.role === 'user') {
      const repetida = entradas.some(e => Math.abs(e.t - t) < 120e3 && (e.texto === norm(texto) || (e.midia && texto.startsWith('['))));
      if (repetida) continue;
      out.push({ id: m.msg_id, quando: m.created_at, lado: 'cliente', texto, tipo: 'text' });
    } else if (m.role === 'operador') {
      out.push({ id: m.msg_id, quando: m.created_at, lado: 'equipe', texto, tipo: 'text' });
    } else if (texto.startsWith('[contexto interno')) {
      if (templates.some(x => Math.abs(x - t) < 10 * 60e3)) continue;
      out.push({ id: m.msg_id, quando: m.created_at, lado: 'auto', texto, tipo: 'text' });
    } else {
      if (daVi.some(e => Math.abs(e.t - t) < 120e3 && e.texto === norm(texto))) continue;
      out.push({ id: m.msg_id, quando: m.created_at, lado: 'vi', texto, tipo: 'text' });
    }
  }
  return out.sort((a, b) => Date.parse(a.quando) - Date.parse(b.quando));
}

export function janelaAberta(ultimaEntrada, agora = Date.now()) {
  return !!ultimaEntrada && agora - Date.parse(ultimaEntrada) < JANELA_MS;
}

async function sbGet(env, caminho) {
  const r = await ok(await fetch(`${SB_URL}/rest/v1/${caminho}`, { headers: sb(env) }), caminho.split('?')[0]);
  return r.json();
}

export async function listarConversas(env, { desde, busca, filtro, limite = 60 } = {}) {
  const p = new URLSearchParams({ select: 'chave,telefone,ultima_em,ultima_direcao,ultimo_texto,ultimo_tipo,nome,pausada_ate,ultima_entrada_em,pendentes', order: 'ultima_em.desc', limit: String(Math.min(Number(limite) || 60, 200)) });
  if (desde) p.set('ultima_em', 'gt.' + desde);
  if (filtro === 'aguardando') p.set('ultima_direcao', 'eq.entrada');
  else if (filtro === 'pausada') p.set('pausada_ate', 'gt.' + new Date().toISOString());
  const b = String(busca || '').trim();
  if (b) {
    const dig = b.replace(/\D/g, '');
    if (dig.length >= 4) p.set('chave', 'like.*' + chave(dig).slice(-8) + '*');
    else p.set('nome', 'ilike.*' + b.replace(/[*,()]/g, ' ') + '*');
  }
  return sbGet(env, 'wa_conversas?' + p);
}

export async function lerConversa(env, tel, { desde, limite = 200 } = {}) {
  const vs = variantes(tel).join(',');
  const lim = String(Math.min(Number(limite) || 200, 500));
  const pWa = new URLSearchParams({ select: 'wamid,telefone,direcao,tipo,texto,midia_id,midia_mime,resposta_a,status,erro,enviada_em,recebida_em,origem', telefone: `in.(${vs})`, order: 'recebida_em.desc', limit: lim });
  const pVi = new URLSearchParams({ select: 'msg_id,role,texto,created_at', wa_id: `in.(${vs})`, order: 'created_at.desc', limit: lim });
  if (desde) { pWa.set('or', `(recebida_em.gt.${desde},status_em.gt.${desde})`); pVi.set('created_at', 'gt.' + desde); }
  const [wa, vi, conv] = await Promise.all([
    sbGet(env, 'wa_mensagens?' + pWa),
    sbGet(env, 'wati_ia_mensagens?' + pVi),
    sbGet(env, `wa_conversas?chave=eq.${chave(tel)}&select=chave,telefone,nome,pausada_ate,ultima_entrada_em`),
  ]);
  return { conversa: conv[0] || null, mensagens: mesclar(wa, vi) };
}

// Envia texto pela Cloud API, grava, e faz a Vi parar 24 h nesta conversa (o mesmo que acontece
// quando alguém da equipe responde pelo Wati: handleOperatorMsg do worker).
// Envio pelo painel só com WA_ENVIO_PAINEL=1 no Cloudflare. Desligado em 19/10/2026: no teste a Meta aceitou os
// envios do nosso app (200 + wamid) mas não entregou nenhum e não mandou status; resposta da equipe por aqui
// sumiria sem ninguém saber. Ligar de novo só depois de um teste que chegue no celular.
export const envioLiberado = env => env.WA_ENVIO_PAINEL === '1';
export const AVISO_ENVIO = 'O envio direto pela Meta ainda está em teste e não está chegando nas clientes. Por enquanto, responda pelo Wati.';

export async function enviarTexto(env, tel, texto, agora = Date.now()) {
  if (!envioLiberado(env)) return { status: 503, erro: 'envio desligado', detalhe: AVISO_ENVIO };
  texto = String(texto || '').trim();
  if (!texto) return { status: 400, erro: 'mensagem vazia' };
  if (texto.length > 4000) return { status: 400, erro: 'mensagem com mais de 4000 caracteres' };
  const token = env.WA_TOKEN || env.META_ACCESS_TOKEN;
  if (!token) return { status: 500, erro: 'META_ACCESS_TOKEN ausente' };
  const conv = (await sbGet(env, `wa_conversas?chave=eq.${chave(tel)}&select=telefone,ultima_entrada_em`))[0];
  if (!conv) return { status: 404, erro: 'conversa não encontrada' };
  if (!janelaAberta(conv.ultima_entrada_em, agora)) return { status: 409, erro: 'janela', detalhe: 'A cliente não escreve há mais de 24 horas. Pela regra do WhatsApp, só dá para mandar um template aprovado.' };

  const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: conv.telefone, type: 'text', text: { preview_url: true, body: texto } }),
  });
  const d = await r.json().catch(() => ({}));
  const wamid = d.messages && d.messages[0] && d.messages[0].id;
  if (!r.ok || !wamid) return { status: 502, erro: 'a Meta recusou', detalhe: (d.error && (d.error.error_user_msg || d.error.message)) || ('HTTP ' + r.status) };

  const quando = new Date(agora).toISOString();
  // merge (e não ignore): o status da Meta pode chegar antes e já ter criado a linha sem texto
  await ok(await fetch(`${SB_URL}/rest/v1/wa_mensagens?on_conflict=wamid`, {
    method: 'POST', headers: sb(env, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify([{ wamid, telefone: conv.telefone, direcao: 'saida', tipo: 'text', texto, origem: 'painel', enviada_em: quando }]),
  }), 'wa_mensagens envio');

  // A Vi conhece a cliente pelo wa_id do Wati, que pode ser a outra grafia: pausa as que ela
  // tem e grava a fala no histórico dela na grafia que ela já usa.
  const vs = variantes(conv.telefone);
  const sess = await sbGet(env, `wati_ia_sessions?wa_id=in.(${vs.join(',')})&select=wa_id&order=updated_at.desc.nullslast`);
  const waVi = (sess[0] && sess[0].wa_id) || conv.telefone;
  const ate = new Date(agora + PAUSA_VI_MS).toISOString();
  await ok(await fetch(`${SB_URL}/rest/v1/wati_ia_sessions?on_conflict=wa_id`, {
    method: 'POST', headers: sb(env, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify([...new Set([waVi, ...sess.map(s => s.wa_id)])].map(w => ({ wa_id: w, pausada_ate: ate, updated_at: quando }))),
  }), 'pausa da Vi');
  await ok(await fetch(`${SB_URL}/rest/v1/wati_ia_mensagens?on_conflict=msg_id`, {
    method: 'POST', headers: sb(env, { Prefer: 'resolution=ignore-duplicates,return=minimal' }),
    body: JSON.stringify({ msg_id: 'op_' + wamid, wa_id: waVi, role: 'operador', texto }),
  }), 'histórico da Vi');
  return { status: 200, ok: true, wamid, vi_pausada_ate: ate };
}

// Foto, áudio ou documento da cliente: a URL da Meta pede o token, então o painel busca por aqui.
export async function baixarMidia(env, id) {
  const token = env.WA_TOKEN || env.META_ACCESS_TOKEN;
  if (!/^\d{5,25}$/.test(String(id || ''))) return json({ erro: 'id inválido' }, 400);
  const info = await fetch(`${GRAPH}/${id}?phone_number_id=${PHONE_NUMBER_ID}`, { headers: { Authorization: 'Bearer ' + token } });
  const meta = await info.json().catch(() => ({}));
  if (!info.ok || !meta.url) return json({ erro: 'mídia indisponível', detalhe: meta.error && meta.error.message }, 404);
  const arq = await fetch(meta.url, { headers: { Authorization: 'Bearer ' + token } });
  if (!arq.ok) return json({ erro: 'mídia indisponível' }, 404);
  return new Response(arq.body, { headers: { 'Content-Type': meta.mime_type || arq.headers.get('Content-Type') || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' } });
}
