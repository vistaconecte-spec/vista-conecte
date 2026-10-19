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
