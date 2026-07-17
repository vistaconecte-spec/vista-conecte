/**
 * Cloudflare Pages Function: /api/modelagem-storage
 * GET ?key=... → gera uma signed URL (1h) do Supabase Storage (bucket privado "modelagem") e redireciona.
 */
const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
const BUCKET = 'modelagem';

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ erro: 'SUPABASE_SERVICE_ROLE_KEY não configurada' }), { status: 500, headers });
  }
  const key = new URL(request.url).searchParams.get('key');
  if (!key) return new Response(JSON.stringify({ erro: 'informe ?key=' }), { status: 400, headers });

  try {
    const r = await fetch(`${SB_URL}/storage/v1/object/sign/${BUCKET}/${encodeURI(key)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    if (!r.ok) {
      return new Response(JSON.stringify({ erro: 'falha ao assinar URL', detalhe: await r.text() }), { status: 502, headers });
    }
    const { signedURL } = await r.json();
    if (!signedURL) return new Response(JSON.stringify({ erro: 'signed URL vazia' }), { status: 502, headers });
    return Response.redirect(`${SB_URL}/storage/v1${signedURL}`, 307);
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
