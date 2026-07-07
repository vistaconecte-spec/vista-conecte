/**
 * Cloudflare Pages Function: /api/meta-conta-status (somente leitura, diagnóstico)
 * Verifica saúde da conta de anúncios: status, limite de gasto, problema de pagamento.
 */
const API_VERSION = 'v23.0';
const CONTA_PADRAO = 'act_968164338120112';

export async function onRequest(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const token = env.META_ACCESS_TOKEN;
  if (!token) return new Response(JSON.stringify({ erro: 'META_ACCESS_TOKEN não configurado' }), { status: 500, headers });
  const conta = env.META_AD_ACCOUNT_ID || CONTA_PADRAO;

  try {
    const fields = 'account_status,disable_reason,spend_cap,amount_spent,balance,funding_source_details,name';
    const r = await fetch(`https://graph.facebook.com/${API_VERSION}/${conta}?fields=${fields}&access_token=${token}`);
    const d = await r.json();
    return new Response(JSON.stringify(d, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
