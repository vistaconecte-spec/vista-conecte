/**
 * Cloudflare Pages Function: /api/shopify-vendas-cor (somente leitura)
 * Conta unidades vendidas por COR de um modelo (pelo prefixo do título).
 *   ?base=Macaquinho Amplo&dias=365
 * Soma os produtos antigos (cor no título) + o unificado (cor na variante "Cor / Tamanho").
 */
const API_VERSION = '2024-04';
const SIZES = ['PP', 'P', 'M', 'G', 'GG'];
const COLOR_NORM = { offwhite: 'Off White', 'off white': 'Off White', off: 'Off White', branca: 'Off White', branco: 'Off White', preta: 'Preto', petroleo: 'Petróleo', 'petr�leo': 'Petróleo' };
function normCor(c) { const k = (c || '').toLowerCase().trim(); return COLOR_NORM[k] || c.trim(); }
function cleanTitle(t) { return (t || '').replace(/\s+preço unitário\s*/i, '').replace(/\s+unit price\s*/i, '').trim(); }

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });
  const qs = new URL(request.url).searchParams;
  const base = (qs.get('base') || '').trim();
  if (!base) return new Response(JSON.stringify({ erro: 'informe ?base=' }), { status: 400, headers: H });
  const dias = parseInt(qs.get('dias') || '365', 10);
  const baseL = base.toLowerCase();
  const desde = new Date(Date.now() - dias * 86400000).toISOString();
  const sh = { 'X-Shopify-Access-Token': token };

  const corDaVariante = (vt) => {
    const raw = (vt || '').trim();
    if (raw.includes(' / ')) {
      const parts = raw.split(' / ').map(p => p.trim());
      const semTam = parts.filter(p => !SIZES.includes(p.toUpperCase()));
      return semTam.length ? semTam.join(' / ') : null;
    }
    return null;
  };

  try {
    const contagem = {}; let pedidosVistos = 0, itensContados = 0;
    let url = `https://${store}/admin/api/${API_VERSION}/orders.json?status=any&financial_status=paid&created_at_min=${encodeURIComponent(desde)}&limit=250&fields=line_items,created_at`;
    let guard = 0;
    while (url && guard < 30) {
      guard++;
      const res = await fetch(url, { headers: sh });
      if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}`, detalhe: (await res.text()).slice(0, 200) }), { status: 502, headers: H });
      const data = await res.json();
      for (const o of (data.orders || [])) {
        pedidosVistos++;
        for (const it of (o.line_items || [])) {
          const t = cleanTitle(it.title);
          if (!t.toLowerCase().startsWith(baseL)) continue;
          let cor = t.slice(base.length).trim();
          if (!cor) cor = corDaVariante(it.variant_title) || '(sem cor)';
          // remove tamanho que às vezes vem no fim do título
          cor = cor.replace(new RegExp('\\s+(' + SIZES.join('|') + ')$', 'i'), '').trim() || cor;
          const c = normCor(cor);
          const qtd = it.quantity || 0;
          contagem[c] = (contagem[c] || 0) + qtd;
          itensContados += qtd;
        }
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
    const ranking = Object.entries(contagem).map(([cor, qtd]) => ({ cor, unidades: qtd })).sort((a, b) => b.unidades - a.unidades);
    return new Response(JSON.stringify({ base, janela_dias: dias, pedidos_vistos: pedidosVistos, itens_contados: itensContados, ranking }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
