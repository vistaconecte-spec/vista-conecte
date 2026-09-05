/**
 * Cloudflare Pages Function: /api/meta-token-scopes (somente leitura)
 * Diz o que o token da Meta pode fazer: escopos, validade e conta ligada.
 * Serve pra saber se dá pra EDITAR anúncio (ads_management) ou só ler (ads_read),
 * sem precisar tentar a escrita e descobrir pelo erro.
 * O token em si nunca sai daqui — só a lista de permissões.
 */
const API_VERSION = 'v23.0';

export async function onRequest(context) {
  const { env } = context;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const token = env.META_ACCESS_TOKEN;
  if (!token) return new Response(JSON.stringify({ erro: 'META_ACCESS_TOKEN não configurado' }), { status: 500, headers: H });

  try {
    const url = `https://graph.facebook.com/${API_VERSION}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.error) return new Response(JSON.stringify({ erro: 'Meta API', detalhe: d.error }, null, 2), { status: 502, headers: H });
    const info = d.data || {};
    const escopos = info.scopes || [];
    return new Response(JSON.stringify({
      valido: !!info.is_valid,
      tipo: info.type || null,
      app_id: info.app_id || null,
      // 0 (ou ausente) = não expira, que é o caso do token de System User.
      expira_em: info.expires_at ? new Date(info.expires_at * 1000).toISOString() : 'nunca',
      escopos,
      pode_editar_anuncio: escopos.includes('ads_management'),
      pode_ler_anuncio: escopos.includes('ads_read') || escopos.includes('ads_management'),
    }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e) }), { status: 500, headers: H });
  }
}
