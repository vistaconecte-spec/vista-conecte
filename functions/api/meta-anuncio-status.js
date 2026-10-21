// GET /api/meta-anuncio-status?ids=ID1,ID2
// Diz POR QUE um anúncio está "com problema" (effective_status WITH_ISSUES / DISAPPROVED):
// devolve issues_info, ad_review_feedback e recomendações da Meta, mais o texto e o link do
// criativo, pra decidir o que fazer sem abrir o Gerenciador. Só leitura, até 10 ids.
// Criado 2026-10-21 (IMG_7678 Pantalona parado desde 16/10). Secret: META_ACCESS_TOKEN.
const API_VERSION = 'v23.0';
const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

const CAMPOS = [
  'id', 'name', 'status', 'configured_status', 'effective_status', 'created_time', 'updated_time',
  'issues_info', 'ad_review_feedback', 'recommendations',
  'adset{id,name,effective_status,issues_info}', 'campaign{id,name,effective_status}',
  'creative{id,name,status,body,title,link_url,call_to_action_type,effective_object_story_id,object_story_spec,asset_feed_spec}'
].join(',');

export async function onRequestGet({ request, env }) {
  const token = env.META_ACCESS_TOKEN;
  if (!token) return J({ erro: 'META_ACCESS_TOKEN ausente' }, 500);
  const ids = (new URL(request.url).searchParams.get('ids') || '')
    .split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)).slice(0, 10);
  if (!ids.length) return J({ erro: 'passe ?ids=ID1,ID2 (ids numéricos de anúncio)' }, 400);

  const api = `https://graph.facebook.com/${API_VERSION}/?ids=${ids.join(',')}&fields=${encodeURIComponent(CAMPOS)}&access_token=${encodeURIComponent(token)}`;
  const r = await fetch(api);
  const d = await r.json();
  if (d.error) return J({ erro: d.error.message, codigo: d.error.code, subcodigo: d.error.error_subcode }, 502);
  return J({ anuncios: ids.map(id => d[id] || { id, erro: 'não encontrado' }) });
}
