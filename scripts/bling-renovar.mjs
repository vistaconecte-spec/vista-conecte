// Renova o acesso do Bling FORA da Cloudflare (23/11/2026).
//
// A Cloudflare do Bling barra com 429 "error code: 1015" o endereço de saída do painel (Cloudflare Pages,
// compartilhado com milhares de sites). Aconteceu em 06/11 e de 21 a 23/11/2026: o token de 6 h venceu,
// a renovação do painel batia no bloqueio e nenhuma nota saiu, então nenhuma etiqueta saiu.
//
// Aqui o GitHub Actions (ou o notebook) pega o refresh_token no painel, pede o par novo direto ao Bling,
// de outro endereço, e devolve para o painel cifrar e gravar. O client secret vem do secret
// BLING_CLIENT_SECRET do repositório e nunca é impresso.
//
//   VC_API_TOKEN=... BLING_CLIENT_SECRET=... node scripts/bling-renovar.mjs [--forcar]

const BASE = 'https://vistaconecte.pages.dev';
const BLING = ['https://api.bling.com.br/Api/v3', 'https://www.bling.com.br/Api/v3'];
const MARGEM_MS = 90 * 60e3; // renova se faltar menos de 1h30 (a rodada de notas leva até 20 min)

export async function renovar({ token, segredo, forcar = false }) {
  const r = await fetch(`${BASE}/api/bling-renovacao`, { headers: { 'X-VC-Token': token } });
  const atual = await r.json().catch(() => ({}));
  if (!r.ok || !atual.refresh_token) return { renovado: false, erro: 'painel: ' + (atual.erro || r.status) };
  const falta = new Date(atual.expira_em).getTime() - Date.now();
  if (!forcar && falta > MARGEM_MS) return { renovado: false, motivo: `token ainda vale até ${atual.expira_em}` };

  let ultimo = '';
  for (const base of BLING) {
    const resp = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: '1.0',
        Authorization: 'Basic ' + Buffer.from(`${atual.client_id}:${segredo}`).toString('base64'),
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: atual.refresh_token }).toString(),
    });
    const txt = await resp.text();
    let d = null; try { d = JSON.parse(txt); } catch { /* erro abaixo */ }
    if (resp.ok && d && d.access_token) {
      // O refresh antigo morreu neste momento: gravar já, senão só autorizando de novo.
      const g = await fetch(`${BASE}/api/bling-renovacao`, {
        method: 'POST', headers: { 'X-VC-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: d.access_token, refresh_token: d.refresh_token, expires_in: d.expires_in, scope: d.scope }),
      });
      const gj = await g.json().catch(() => ({}));
      if (!g.ok || !gj.ok) return { renovado: false, erro: 'Bling renovou mas o painel não gravou: ' + (gj.erro || g.status) };
      return { renovado: true, via: base, expira_em: gj.expira_em };
    }
    ultimo = `${base} ${resp.status}: ${(d && d.error && (d.error.description || d.error.message || d.error.type)) || txt.slice(0, 120)}`;
    if (resp.status !== 429) break; // só o bloqueio por endereço vale tentar no outro domínio
  }
  return { renovado: false, erro: 'Bling: ' + ultimo };
}

if (process.argv[1] && process.argv[1].endsWith('bling-renovar.mjs')) {
  const token = process.env.VC_API_TOKEN, segredo = process.env.BLING_CLIENT_SECRET;
  if (!token || !segredo) { console.error('falta VC_API_TOKEN ou BLING_CLIENT_SECRET'); process.exit(1); }
  const r = await renovar({ token, segredo, forcar: process.argv.includes('--forcar') });
  console.log(JSON.stringify(r));
  if (r.erro) process.exit(1);
}
