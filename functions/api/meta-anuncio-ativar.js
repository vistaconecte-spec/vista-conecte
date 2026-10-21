/**
 * Cloudflare Pages Function: /api/meta-anuncio-ativar (LEITURA + ESCRITA)
 * Liga ou pausa anúncios da conta sem abrir o Gerenciador.
 * Token: env.META_ACCESS_TOKEN (System User, precisa de ads_management).
 *
 * POST { ids: ["120..."], status: "ACTIVE" | "PAUSED", aplicar?: false }
 *
 * Por padrão NÃO grava: devolve o status de agora e o que mudaria. Só com aplicar:true
 * a mudança sai. Só mexe em anúncio desta conta, e devolve o status depois da troca
 * (effective_status + issues_info) pra ver na hora se a Meta aceitou ou segurou.
 * Criado em 21/10/2026: a Meta pausou sozinha o IMG_7678 (Pantalona) em 17/10 por
 * "taxa de invalidação alta" (2490424) e ele ficou 5 dias fora sem ninguém ver.
 */
const API_VERSION = 'v23.0';
const CONTA_PADRAO = 'act_968164338120112';
const G = `https://graph.facebook.com/${API_VERSION}`;
const CAMPOS = 'id,name,account_id,configured_status,effective_status,issues_info';
const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

async function api(url, init) {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok && !d.error, dado: d, erro: d.error || (r.ok ? null : `HTTP ${r.status}`) };
}

export async function onRequestPost({ request, env }) {
  const token = env.META_ACCESS_TOKEN;
  if (!token) return J({ erro: 'META_ACCESS_TOKEN ausente' }, 500);
  const conta = (env.META_AD_ACCOUNT_ID || CONTA_PADRAO).replace('act_', '');
  const body = await request.json().catch(() => ({}));
  const status = body.status;
  if (status !== 'ACTIVE' && status !== 'PAUSED') return J({ erro: 'status precisa ser ACTIVE ou PAUSED' }, 400);
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(s => /^\d+$/.test(s)).slice(0, 10);
  if (!ids.length) return J({ erro: 'passe ids: ["120..."]' }, 400);
  const aplicar = body.aplicar === true;
  const tk = `access_token=${encodeURIComponent(token)}`;

  const resultados = [];
  for (const id of ids) {
    const antes = await api(`${G}/${id}?fields=${CAMPOS}&${tk}`);
    if (!antes.ok) { resultados.push({ id, erro: antes.erro }); continue; }
    const a = antes.dado;
    const passo = { id, nome: a.name, antes: { configurado: a.configured_status, efetivo: a.effective_status, problemas: a.issues_info || null }, novo: status };
    if (String(a.account_id) !== conta) { resultados.push({ ...passo, erro: 'anúncio não é desta conta' }); continue; }
    if (!aplicar) { resultados.push(passo); continue; }

    const r = await api(`${G}/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `status=${status}&${tk}`
    });
    if (!r.ok) { resultados.push({ ...passo, erro: r.erro }); continue; }
    const depois = await api(`${G}/${id}?fields=${CAMPOS}&${tk}`);
    const d = depois.dado || {};
    resultados.push({ ...passo, depois: { configurado: d.configured_status, efetivo: d.effective_status, problemas: d.issues_info || null } });
  }
  return J({ modo: aplicar ? 'aplicado' : 'simulação (nada foi gravado)', resultados });
}
