// API v3 do Bling: OAuth, token guardado e chamadas (14/10/2026).
//
// Pra que serve: emitir a NF-e de cada pedido da loja pelo painel, todo dia antes do envio,
// em vez de alguém clicar "gerar nota" um por um dentro do Bling.
//
// App PRIVADO "Vista Conecte NF-e" (id 404364 na Área do Integrador do Bling), escopos:
// Clientes e Fornecedores, Notas Fiscais, Emissão de NF-e, Pedidos de Venda e Gerenciar
// Pedidos de Venda. Nenhum escopo de exclusão.
//
// O TOKEN NÃO PODE FICAR LEGÍVEL NO SUPABASE: a vc_modelos é lida e gravada com a chave anon,
// que é pública (está no main.js). Quem tivesse o refresh_token emitiria nota em nome da
// empresa. Por isso o documento `bling:token` guarda só o token cifrado com AES-GCM, e a chave
// sai do BLING_CLIENT_SECRET (secret do Pages). Trocar o secret no Bling = autorizar de novo,
// que é o que o Bling exige de qualquer forma.

export const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
export const BLING_API = 'https://api.bling.com.br/Api/v3';
export const BLING_AUTHORIZE = 'https://www.bling.com.br/Api/v3/oauth/authorize';
// Não é segredo: aparece na URL de autorização que o navegador abre.
export const BLING_CLIENT_ID_PADRAO = '2881e6a1616ae95db825c3079fea7203dbd37e2a';
const DOC_TOKEN = 'bling:token';
// Renova um pouco antes de vencer: o access_token dura 6h e uma chamada no limite falharia.
const MARGEM_RENOVA_MS = 5 * 60e3;

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export function clientId(env) { return env.BLING_CLIENT_ID || BLING_CLIENT_ID_PADRAO; }

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ── state do OAuth ──────────────────────────────────────────────────────────
// O callback é público (o redirect vem de outro site e o cookie SameSite=Strict não vai
// junto). O que impede alguém de mandar um `code` da conta DELE pra cá e fazer o painel
// emitir nota em outra empresa é este state: só o /api/bling-auth, atrás do login da dona,
// sabe assinar, e ele vence em 15 minutos.

async function chaveHmac(segredo) {
  return crypto.subtle.importKey('raw', enc.encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function assinarState(segredo, agora = Date.now()) {
  const payload = b64url(enc.encode(JSON.stringify({ b: 'bling', exp: agora + 15 * 60e3 })));
  const sig = b64url(await crypto.subtle.sign('HMAC', await chaveHmac(segredo), enc.encode(payload)));
  return `${payload}.${sig}`;
}

export async function stateValido(state, segredo, agora = Date.now()) {
  const [payload, sig] = String(state || '').split('.');
  if (!payload || !sig || !segredo) return false;
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await chaveHmac(segredo), deB64url(sig), enc.encode(payload)); }
  catch { return false; }
  if (!ok) return false;
  try {
    const d = JSON.parse(dec.decode(deB64url(payload)));
    return d.b === 'bling' && d.exp > agora;
  } catch { return false; }
}

// ── cifra do token ──────────────────────────────────────────────────────────

async function chaveAes(segredo) {
  const bruto = await crypto.subtle.digest('SHA-256', enc.encode('bling-token:' + segredo));
  return crypto.subtle.importKey('raw', bruto, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function cifrar(obj, segredo) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await chaveAes(segredo), enc.encode(JSON.stringify(obj)));
  return `${b64url(iv)}.${b64url(c)}`;
}

export async function decifrar(texto, segredo) {
  const [iv, c] = String(texto || '').split('.');
  if (!iv || !c) return null;
  try {
    const p = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: deB64url(iv) }, await chaveAes(segredo), deB64url(c));
    return JSON.parse(dec.decode(p));
  } catch { return null; }
}

// ── Supabase ────────────────────────────────────────────────────────────────

function sbHeaders(env, extra) {
  const k = env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json', ...(extra || {}) };
}

async function lerDocToken(env) {
  const r = await fetch(`${SB_URL}/rest/v1/vc_modelos?id=eq.${encodeURIComponent(DOC_TOKEN)}&select=dados,updated_at`, { headers: sbHeaders(env) });
  if (!r.ok) throw new Error(`Supabase get ${r.status}`);
  const rows = await r.json();
  return rows[0] || null;
}

async function gravarDocToken(env, dados) {
  const r = await fetch(`${SB_URL}/rest/v1/vc_modelos?on_conflict=id`, {
    method: 'POST',
    headers: sbHeaders(env, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ id: DOC_TOKEN, dados }),
  });
  if (!r.ok) throw new Error(`Supabase upsert ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// ── OAuth ───────────────────────────────────────────────────────────────────

async function pedirToken(env, corpo) {
  if (!env.BLING_CLIENT_SECRET) throw new Error('BLING_CLIENT_SECRET ausente no Pages');
  const r = await fetch(`${BLING_API}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: '1.0',
      Authorization: 'Basic ' + btoa(`${clientId(env)}:${env.BLING_CLIENT_SECRET}`),
    },
    body: new URLSearchParams(corpo).toString(),
  });
  const txt = await r.text();
  let d = null; try { d = JSON.parse(txt); } catch { /* corpo não-JSON vira erro abaixo */ }
  if (!r.ok || !d || !d.access_token) {
    const msg = d && d.error ? (d.error.description || d.error.message || d.error.type || JSON.stringify(d.error)) : txt.slice(0, 200);
    throw new Error(`Bling oauth ${r.status}: ${msg}`);
  }
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expira_em: Date.now() + (parseInt(d.expires_in, 10) || 21600) * 1000,
    escopo: d.scope || null,
  };
}

export async function salvarToken(env, tok, origem) {
  const cifrado = await cifrar(tok, env.BLING_CLIENT_SECRET);
  await gravarDocToken(env, { cifrado, expira_em: new Date(tok.expira_em).toISOString(), origem, gravado_em: new Date().toISOString() });
}

export async function trocarCodigo(env, code) {
  const tok = await pedirToken(env, { grant_type: 'authorization_code', code });
  await salvarToken(env, tok, 'autorizacao');
  return tok;
}

// Devolve um access_token válido, renovando quando precisa. O refresh_token do Bling GIRA a
// cada renovação: o velho deixa de valer. Se duas chamadas renovarem ao mesmo tempo, a que
// gravar por último pode deixar no banco um refresh que o Bling já invalidou, e aí só
// autorizando de novo. Por isso só o fluxo de emissão (um por vez) deve chamar isto em lote.
export async function tokenValido(env, { forcarRenovacao = false } = {}) {
  const row = await lerDocToken(env);
  if (!row || !row.dados || !row.dados.cifrado) throw new Error('Bling não autorizado: abrir /api/bling-auth');
  const tok = await decifrar(row.dados.cifrado, env.BLING_CLIENT_SECRET);
  if (!tok) throw new Error('token do Bling ilegível (BLING_CLIENT_SECRET mudou?): autorizar de novo em /api/bling-auth');
  if (!forcarRenovacao && tok.expira_em - MARGEM_RENOVA_MS > Date.now()) return tok.access_token;
  const novo = await pedirToken(env, { grant_type: 'refresh_token', refresh_token: tok.refresh_token });
  await salvarToken(env, novo, 'renovacao');
  return novo.access_token;
}

export async function statusToken(env) {
  const row = await lerDocToken(env);
  if (!row || !row.dados || !row.dados.cifrado) return { autorizado: false };
  const tok = await decifrar(row.dados.cifrado, env.BLING_CLIENT_SECRET);
  return {
    autorizado: !!tok,
    legivel: !!tok,
    expira_em: row.dados.expira_em,
    origem: row.dados.origem,
    gravado_em: row.dados.gravado_em,
    escopo: tok ? tok.escopo : null,
  };
}

// ── chamadas ────────────────────────────────────────────────────────────────

// O Bling limita a 3 requisições por segundo por conta. Quem chama em sequência espera isto
// entre uma e outra.
export const PAUSA_MS = 350;
export const esperar = ms => new Promise(r => setTimeout(r, ms));

export async function bling(env, caminho, { method = 'GET', body, token } = {}) {
  let t = token || await tokenValido(env);
  const fazer = tk => fetch(`${BLING_API}${caminho}`, {
    method,
    headers: { Authorization: 'Bearer ' + tk, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let r = await fazer(t);
  if (r.status === 401 && !token) {
    t = await tokenValido(env, { forcarRenovacao: true });
    r = await fazer(t);
  }
  const txt = await r.text();
  let d = null; try { d = txt ? JSON.parse(txt) : {}; } catch { d = { bruto: txt.slice(0, 300) }; }
  if (!r.ok) {
    const e = d && d.error ? d.error : d;
    // Erro de validação vem com a lista do que está errado em `fields`; sem ela a mensagem
    // é só "não pode ser gerada devido a erros de validação".
    const campos = e && Array.isArray(e.fields) ? ' [' + e.fields.map(f => [f.element, f.msg || f.message].filter(Boolean).join(': ')).join(' | ') + ']' : '';
    const err = new Error(`Bling ${method} ${caminho} ${r.status}: ${(e && (e.description || e.message)) || JSON.stringify(e).slice(0, 300)}${campos}`);
    err.status = r.status; err.corpo = d;
    throw err;
  }
  return d;
}
