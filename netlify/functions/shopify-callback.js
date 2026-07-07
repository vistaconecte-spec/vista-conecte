exports.handler = async (event) => {
  const { code } = event.queryStringParameters || {};
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const shop = '7660e4-dd.myshopify.com';

  if (!code) {
    return { statusCode: 400, body: 'Parâmetro code ausente.' };
  }

  try {
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });

    const data = await res.json();
    const token = data.access_token;

    if (!token) {
      return { statusCode: 500, body: 'Falha ao obter token: ' + JSON.stringify(data) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Token Shopify</title>
<style>body{font-family:sans-serif;padding:40px;background:#f5f5f0}
.box{background:#fff;border:1px solid #ddd;border-radius:8px;padding:24px;max-width:600px}
h2{margin:0 0 16px}code{background:#f0f0e8;padding:12px 16px;display:block;border-radius:4px;word-break:break-all;font-size:14px}
p{color:#666;font-size:13px;margin-top:16px}</style></head>
<body>
<div class="box">
  <h2>✅ Token obtido com sucesso</h2>
  <p><strong>Copie o token abaixo</strong> e adicione como variável de ambiente <code>SHOPIFY_ADMIN_TOKEN</code> no Netlify:</p>
  <code>${token}</code>
  <p>Após salvar no Netlify, aguarde o redeploy e os pedidos em aberto aparecerão automaticamente no sistema.</p>
</div>
</body>
</html>`,
    };
  } catch (err) {
    return { statusCode: 500, body: 'Erro: ' + err.message };
  }
};
