/**
 * Cloudflare Pages Function: /api/shopify-cupom-uso (somente leitura)
 *
 * Tudo o que um cupom fez: quantos pedidos, quantas peças, quanto faturou e quanto de
 * desconto deu — separando o que foi PAGO do que não foi.
 *   ?codigo=tiktok            (casa por trecho, sem diferenciar maiúscula/acento)
 *   &desde=2024-01-01         (opcional, padrão 2024-01-01)
 *
 * POR QUE ISTO EXISTE: dava para responder isso varrendo mês a mês em outro endpoint, mas
 * aquele conta SÓ pedido pago e SÓ pedidos (não peças) — dois jeitos fáceis de dar um
 * número menor do que a pessoa esperava. Aqui vem tudo separado, sem precisar interpretar.
 *
 * A API da Shopify não filtra pedido por código de cupom no REST, então a varredura é
 * feita aqui: pagina tudo desde a data e compara os códigos de cada pedido.
 */
const API_VERSION = '2024-04';

const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

export async function onRequest(context) {
  const { request, env } = context;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });

  const qs = new URL(request.url).searchParams;
  const codigo = (qs.get('codigo') || '').trim();
  if (!codigo) return new Response(JSON.stringify({ erro: 'informe ?codigo=' }), { status: 400, headers: H });
  const desde = (qs.get('desde') || '2024-01-01') + 'T00:00:00-03:00';
  const alvo = semAcento(codigo);

  const PAGOS = new Set(['paid', 'partially_refunded']);
  const num = v => parseFloat(v || 0) || 0;

  try {
    const fields = 'id,name,created_at,financial_status,cancelled_at,discount_codes,line_items,current_total_price,total_discounts';
    let url = `https://${store}/admin/api/${API_VERSION}/orders.json`
      + `?status=any&created_at_min=${encodeURIComponent(new Date(desde).toISOString())}&limit=250&fields=${fields}`;

    const pedidos = [];
    let varridos = 0, paginas = 0;
    while (url && paginas < 60) { // teto de segurança: 15 mil pedidos
      const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}` }), { status: 502, headers: H });
      const data = await res.json();
      paginas++;
      for (const o of data.orders || []) {
        varridos++;
        const codes = (o.discount_codes || []).map(c => c.code || '').filter(Boolean);
        const bateu = codes.filter(c => semAcento(c).includes(alvo));
        if (!bateu.length) continue;
        pedidos.push({
          numero: o.name,
          data: o.created_at,
          cupons: bateu,
          status: o.cancelled_at ? 'cancelado' : (o.financial_status || 'sem status'),
          pago: !o.cancelled_at && PAGOS.has(o.financial_status),
          pecas: (o.line_items || []).reduce((s, i) => s + (i.quantity || 0), 0),
          total: num(o.current_total_price),
          desconto: num(o.total_discounts),
        });
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    const pagos = pedidos.filter(p => p.pago);
    const resumo = arr => ({
      pedidos: arr.length,
      pecas: arr.reduce((s, p) => s + p.pecas, 0),
      faturamento: +arr.reduce((s, p) => s + p.total, 0).toFixed(2),
      desconto: +arr.reduce((s, p) => s + p.desconto, 0).toFixed(2),
    });
    const porStatus = {};
    for (const p of pedidos) porStatus[p.status] = (porStatus[p.status] || 0) + 1;
    const variantes = {};
    for (const p of pedidos) for (const c of p.cupons) variantes[c] = (variantes[c] || 0) + 1;

    pedidos.sort((a, b) => String(a.data).localeCompare(String(b.data)));
    return new Response(JSON.stringify({
      codigo, desde, pedidos_varridos: varridos, paginas,
      pago: resumo(pagos),
      todos: resumo(pedidos),
      por_status: porStatus,
      variantes_do_codigo: variantes,
      primeiro: (pedidos[0] || {}).data || null,
      ultimo: pedidos.length ? pedidos[pedidos.length - 1].data : null,
      lista: pedidos,
    }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e && e.message || e) }), { status: 500, headers: H });
  }
}
