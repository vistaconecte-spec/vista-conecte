/**
 * Cloudflare Pages Function: /api/meta-cobrancas (SÓ LEITURA)
 * Histórico de cobranças da conta de anúncios (cartão VISA *9121, fora do Mercado Pago),
 * lido do registro de atividades da conta (event_type ad_account_billing_charge).
 * GET ?dias=30 (máx 90). Devolve também o saldo acumulado agora (sem imposto).
 * Criado em 18/11/2026: a página de cobrança do Gerenciador pede login/chave de acesso.
 */
const API_VERSION = 'v23.0';
const CONTA_PADRAO = 'act_968164338120112';
const G = `https://graph.facebook.com/${API_VERSION}`;
const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

export async function onRequestGet({ request, env }) {
  const token = env.META_ACCESS_TOKEN;
  if (!token) return J({ erro: 'META_ACCESS_TOKEN ausente' }, 500);
  const conta = 'act_' + (env.META_AD_ACCOUNT_ID || CONTA_PADRAO).replace('act_', '');
  const u = new URL(request.url);
  const dias = Math.min(90, Math.max(1, Number(u.searchParams.get('dias')) || 30));
  const desde = Math.floor(Date.now() / 1000) - dias * 86400;
  const tk = `access_token=${encodeURIComponent(token)}`;

  const eventos = [];
  let url = `${G}/${conta}/activities?fields=event_type,event_time,extra_data,translated_event_type&since=${desde}&limit=200&${tk}`;
  for (let i = 0; url && i < 10; i++) {
    const r = await fetch(url);
    const d = await r.json().catch(() => ({}));
    if (d.error) return J({ erro: d.error.message }, 502);
    for (const e of d.data || []) {
      if (!/billing|charge|payment/i.test(e.event_type || '')) continue;
      let extra = e.extra_data;
      try { extra = JSON.parse(extra); } catch (_) {}
      const centavos = extra && (extra.new_value ?? extra.amount);
      eventos.push({
        quando: e.event_time,
        tipo: e.event_type,
        descricao: e.translated_event_type,
        valor: typeof centavos === 'number' ? centavos / 100 : null,
        moeda: extra && extra.currency,
        detalhe: extra
      });
    }
    url = d.paging && d.paging.next;
  }

  const c = await fetch(`${G}/${conta}?fields=balance,amount_spent,funding_source_details{display_string}&${tk}`).then(r => r.json()).catch(() => ({}));
  return J({
    conta,
    cartao: c.funding_source_details && c.funding_source_details.display_string,
    saldo_acumulado_agora: c.balance ? Number(c.balance) / 100 : null,
    cobrancas: eventos
  });
}
