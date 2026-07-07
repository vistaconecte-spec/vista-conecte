/**
 * Cloudflare Pages Function: /api/shopify-callback
 * Recebe o código OAuth e troca pelo access token
 */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return new Response(`Erro Shopify: ${error} — ${url.searchParams.get('error_description') || ''}`, {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  if (!code) {
    return new Response('Parâmetro code ausente.', { status: 400 });
  }

  const clientId     = env.SHOPIFY_CLIENT_ID || 'df9f6b2f41b2f6f65758fc9c82ae9eba';
  const clientSecret = env.SHOPIFY_CLIENT_SECRET || 'ff63b2464c9f72cade9152b966df7f11';
  const shop         = env.SHOPIFY_STORE_DOMAIN || '7660e4-dd.myshopify.com';

  try {
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });

    const data = await res.json();
    const token = data.access_token;

    if (!token) {
      return new Response(`Falha ao obter token: ${JSON.stringify(data)}`, { status: 500 });
    }

    return new Response(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Token Shopify — Vista Conecte</title>
<style>
body{font-family:sans-serif;padding:40px;background:#f5f0eb;color:#222}
.box{background:#fff;border:1px solid #ddd;border-radius:10px;padding:28px;max-width:660px;margin:auto}
h2{margin:0 0 18px;color:#111}
.token{background:#f0ede8;border:2px solid #c4a882;border-radius:6px;padding:14px 18px;
       font-family:monospace;font-size:13px;word-break:break-all;color:#333}
.steps{margin-top:20px;font-size:13px;color:#444;line-height:1.8}
.steps ol{padding-left:20px}
code{background:#f0ede8;padding:2px 6px;border-radius:3px;font-size:12px}
</style></head>
<body>
<div class="box">
  <h2>✅ Token Shopify obtido!</h2>
  <p><strong>SHOPIFY_ADMIN_TOKEN:</strong></p>
  <div class="token">${token}</div>
  <div class="steps">
    <strong>Próximos passos para ativar a integração:</strong>
    <ol>
      <li>Acesse <a href="https://dash.cloudflare.com" target="_blank">dash.cloudflare.com</a></li>
      <li>Workers &amp; Pages → <strong>vistaconecte</strong> → Settings → Environment variables</li>
      <li>Adicione: <code>SHOPIFY_ADMIN_TOKEN</code> = <em>(token acima)</em></li>
      <li>Adicione: <code>SHOPIFY_STORE_DOMAIN</code> = <code>7660e4-dd.myshopify.com</code></li>
      <li>Salve e aguarde o redeploy automático</li>
    </ol>
  </div>
</div>
</body>
</html>`, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });

  } catch (err) {
    return new Response(`Erro: ${err.message}`, { status: 500 });
  }
}
