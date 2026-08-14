// Token de sessão assinado com HMAC-SHA256.
// Formato: base64url(payload).base64url(assinatura) — não é JWT porque não
// precisamos de nada além de {perfil, exp}, e um formato menor é menos coisa
// para errar. Prefixo "_" faz o Pages não tratar o arquivo como rota.

const enc = new TextEncoder();

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const deB64url = s => Uint8Array.from(
  atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)
);

const chave = segredo => crypto.subtle.importKey(
  'raw', enc.encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
);

export async function assinarSessao(perfil, segredo, horas = 12) {
  const payload = b64url(enc.encode(JSON.stringify({ perfil, exp: Date.now() + horas * 3600e3 })));
  const sig = b64url(await crypto.subtle.sign('HMAC', await chave(segredo), enc.encode(payload)));
  return `${payload}.${sig}`;
}

export async function lerSessao(request, segredo) {
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)vc_sessao=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  let ok;
  // crypto.subtle.verify compara em tempo constante — não dá para descobrir a
  // assinatura byte a byte medindo o tempo de resposta.
  try { ok = await crypto.subtle.verify('HMAC', await chave(segredo), deB64url(sig), enc.encode(payload)); }
  catch { return null; }
  if (!ok) return null;
  try {
    const d = JSON.parse(new TextDecoder().decode(deB64url(payload)));
    return d.exp > Date.now() ? d : null;
  } catch { return null; }
}
