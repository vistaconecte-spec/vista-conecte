/**
 * Cloudflare Pages Function: /api/shopify-desc-prazo
 * Inspeciona/edita a frase de PRAZO dentro da descrição (body_html) dos produtos.
 * GET  ?contem=dias úteis   -> lista produtos cujo body_html contém o termo, com o trecho ao redor
 * POST { de, para, confirmar } -> troca a string "de" por "para" no body_html de quem tiver "de"
 *        confirmar:false (padrão) = dry-run (mostra quantos e quais, NÃO grava)
 *        confirmar:true           = grava
 * Requer write_products.
 */
const API_VERSION = '2024-04';

export async function onRequest({ request, env }) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  const token = env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN;
  const shop = env.SHOPIFY_STORE_DOMAIN;
  if (!token || !shop) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  const sh = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  const fetchAll = async () => {
    const acc = [];
    let url = `https://${shop}/admin/api/${API_VERSION}/products.json?status=active&published_status=any&limit=250&fields=id,title,body_html`;
    while (url) {
      const r = await fetch(url, { headers: sh });
      if (!r.ok) throw new Error(`Shopify ${r.status}`);
      const d = await r.json();
      acc.push(...(d.products || []));
      const link = r.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
    return acc;
  };

  try {
    if (request.method === 'GET') {
      const sp = new URL(request.url).searchParams;
      const contem = (sp.get('contem') || 'dias úteis');
      const raw = sp.get('raw');
      const prods = await fetchAll();
      if (raw) {
        const p = prods.find(x => (x.body_html || '').toLowerCase().includes(contem.toLowerCase()));
        return new Response(JSON.stringify({ termo: contem, achou: !!p, titulo: p && p.title, html_cru: p ? p.body_html : null }, null, 2), { headers });
      }
      const achados = [];
      for (const p of prods) {
        const html = p.body_html || '';
        const idx = html.toLowerCase().indexOf(contem.toLowerCase());
        if (idx === -1) continue;
        const trecho = html.slice(Math.max(0, idx - 70), idx + contem.length + 30).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        achados.push({ id: p.id, titulo: p.title, trecho });
      }
      // agrupa trechos iguais pra ver as variações de redação
      const variacoes = {};
      achados.forEach(a => { variacoes[a.trecho] = (variacoes[a.trecho] || 0) + 1; });
      return new Response(JSON.stringify({ termo: contem, total_produtos: prods.length, com_o_termo: achados.length, variacoes, exemplos: achados.slice(0, 8) }, null, 2), { headers });
    }

    // POST = troca por string literal {de,para} OU por {regex,flags,para}
    const b = await request.json();
    if (typeof b.para !== 'string') return new Response(JSON.stringify({ erro: 'campo "para" obrigatório' }), { status: 400, headers });
    const useRe = typeof b.regex === 'string' && b.regex.length > 0;
    if (!useRe && !(typeof b.de === 'string' && b.de)) return new Response(JSON.stringify({ erro: 'informe "de" (literal) ou "regex"' }), { status: 400, headers });
    const makeRe = () => { let f = (b.flags || 'g'); if (f.indexOf('g') < 0) f += 'g'; return new RegExp(b.regex, f); };
    const testa = (h) => useRe ? makeRe().test(h) : h.includes(b.de);
    const troca = (h) => useRe ? h.replace(makeRe(), b.para) : h.split(b.de).join(b.para);

    const prods = await fetchAll();
    const alvo = prods.filter(p => testa(p.body_html || ''));
    if (b.confirmar !== true) {
      let amostra = null;
      if (alvo[0]) {
        const antes = alvo[0].body_html || '';
        const depois = troca(antes);
        const i = antes.toLowerCase().indexOf('condi');
        amostra = {
          produto: alvo[0].title, mudou: depois !== antes,
          tam_antes: antes.length, tam_depois: depois.length,
          antes_trecho: i >= 0 ? antes.slice(Math.max(0, i - 30), i + 320) : antes.slice(0, 300),
          depois_trecho: i >= 0 ? depois.slice(Math.max(0, i - 30), i + 120) : depois.slice(0, 200),
        };
      }
      return new Response(JSON.stringify({ modo: 'dry-run (nada gravado)', metodo: useRe ? 'regex' : 'literal', encontrados: alvo.length, exemplos: alvo.slice(0, 8).map(p => p.title), amostra, dica: 'reenvie com confirmar:true' }, null, 2), { headers });
    }
    // Processa em LOTE (free tier da Cloudflare ~50 subrequisições/invocação)
    const max = Math.max(1, Math.min(45, parseInt(b.max || 40, 10)));
    const lote = alvo.slice(0, max);
    let ok = 0; const erros = [];
    for (const p of lote) {
      const novo = troca(p.body_html || '');
      const w = await fetch(`https://${shop}/admin/api/${API_VERSION}/products/${p.id}.json`, {
        method: 'PUT', headers: sh, body: JSON.stringify({ product: { id: p.id, body_html: novo } }),
      });
      if (w.ok) ok++; else erros.push({ id: p.id, titulo: p.title, status: w.status });
    }
    return new Response(JSON.stringify({ ok: true, atualizados: ok, restantes: alvo.length - ok, falhas: erros.length, erros }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
