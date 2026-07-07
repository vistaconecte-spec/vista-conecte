// GET /api/pagarme-saldo — saldo disponível na conta Pagar.me API v4 (Cloudflare Pages Function)
// Secret necessária no projeto Cloudflare: PAGARME_SECRET_KEY (sk_... do recebedor padrão)
// Retorna: { disponivel, a_liberar, atualizado, bruto }
// Obs: Pagar.me faz antecipação automática D+2 e transfere pra Stone — o saldo aqui costuma
// ser baixo (o dinheiro de cartão já migrou pra conta bancária). Ver memória vista-conecte-gestao.
const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

export async function onRequestGet({ env }) {
  const sk = env.PAGARME_SECRET_KEY;
  if (!sk) return J({ erro: 'PAGARME_SECRET_KEY ausente no projeto Cloudflare', disponivel: null }, 500);
  try {
    const r = await fetch('https://api.pagar.me/1/balance?api_key=' + encodeURIComponent(sk));
    const b = await r.json();
    // valores em centavos. API v4 aninha em available/waiting_funds; aceita achatado (v5) como fallback.
    const cents = v => (typeof v === 'number' ? v / 100 : null);
    return J({
      disponivel: cents(b.available?.amount ?? b.available_amount),
      a_liberar: cents(b.waiting_funds?.amount ?? b.waiting_funds_amount),
      atualizado: new Date().toISOString(),
      bruto: b
    });
  } catch (e) {
    return J({ erro: String(e), disponivel: null }, 502);
  }
}
