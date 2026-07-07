// GET /api/mp-saldo — saldo disponível na conta Mercado Pago (Cloudflare Pages Function)
// Secret necessária no projeto Cloudflare: MP_ACCESS_TOKEN (access_token da conta MP da Vista Conecte)
// Retorna: { disponivel: <número em R$>, atualizado: <ISO>, bruto: <payload MP p/ debug> }
const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

export async function onRequestGet({ env }) {
  const token = env.MP_ACCESS_TOKEN;
  if (!token) return J({ erro: 'MP_ACCESS_TOKEN ausente no projeto Cloudflare', disponivel: null }, 500);
  const H = { Authorization: 'Bearer ' + token };
  try {
    // 1) descobrir o user_id da conta
    const meR = await fetch('https://api.mercadopago.com/users/me', { headers: H });
    const me = await meR.json();
    if (!me || !me.id) return J({ erro: 'falha ao obter user_id MP', bruto: me, disponivel: null }, 502);

    // 2) saldo da conta Mercado Pago
    const balR = await fetch(`https://api.mercadopago.com/users/${me.id}/mercadopago_account/balance`, { headers: H });
    const b = await balR.json();
    // O endpoint retorna available_balance / unavailable_balance / total_amount
    const disponivel = (typeof b.available_balance === 'number') ? b.available_balance
      : (typeof b.total_amount === 'number') ? b.total_amount : null;
    return J({ disponivel, atualizado: new Date().toISOString(), bruto: b });
  } catch (e) {
    return J({ erro: String(e), disponivel: null }, 502);
  }
}
