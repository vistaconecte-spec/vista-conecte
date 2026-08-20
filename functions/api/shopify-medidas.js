/**
 * Cloudflare Pages Function: /api/shopify-medidas
 * Leva a tabela MEDIDAS DA PEÇA (aba Modelagem) para a descrição do produto na loja.
 *
 *   GET  ?q=texto   → produtos cujo título contém `q` (id, title, status, temTabela),
 *                     para escolher a que produto o modelo corresponde.
 *   POST { produtoIds:[id], linhas:[{nome,valores:{PP..}}], tamanhos:[...] } [?apply=1]
 *                   → dry-run por padrão: devolve o body_html que FICARIA em cada produto.
 *                     Com ?apply=1 grava.
 *
 * A descrição é reescrita inteira pela API da Shopify (não existe PATCH de pedaço), então
 * este endpoint SEMPRE lê o body_html atual antes e devolve o texto de venda intacto — a
 * tabela entra como um bloco delimitado por comentário HTML. Sem esse cuidado, publicar
 * medidas apagaria a descrição escrita à mão.
 *
 * O bloco legado (3 produtos da Calça Flare, publicados à mão em 2026) abre com o mesmo
 * comentário mas não tem marca de fim: por isso a remoção também aceita "até o </table>".
 */
const API_VERSION = '2024-04';

export const MARCA_INI = '<!-- tabela-medidas-vc -->';
export const MARCA_FIM = '<!-- /tabela-medidas-vc -->';

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Colunas que valem a pena imprimir: tamanho sem nenhum valor não vira coluna vazia na loja. */
export function tamanhosUsados(linhas, tamanhos) {
  return (tamanhos || []).filter(t => (linhas || []).some(l => ((l.valores || {})[t] || '').toString().trim()));
}

/** Só linhas com nome e com pelo menos um valor — o resto é linha em branco da planilha. */
export function linhasValidas(linhas) {
  return (linhas || []).filter(l => (l.nome || '').toString().trim()
    && Object.values(l.valores || {}).some(v => (v || '').toString().trim()));
}

/** O bloco HTML que vai para a descrição, já com as marcas de início e fim. */
export function montarTabelaHtml(linhas, tamanhos) {
  const ls = linhasValidas(linhas);
  const ts = tamanhosUsados(ls, tamanhos);
  if (!ls.length || !ts.length) return '';
  const cab = ts.map(t => `<th>${esc(t)}</th>`).join('');
  const corpo = ls.map(l => {
    const cels = ts.map(t => `<td>${esc(((l.valores || {})[t] || '').toString().trim() || '-')}</td>`).join('');
    return `<tr><td>${esc(l.nome.trim())}</td>${cels}</tr>`;
  }).join('\n');
  return `${MARCA_INI}
<p><strong>Tabela de medidas (peça pronta, em cm)</strong></p>
<table>
<thead><tr><th>Medida</th>${cab}</tr></thead>
<tbody>
${corpo}
</tbody>
</table>
${MARCA_FIM}`;
}

const rx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Tira o bloco de medidas antigo (novo formato ou legado) e devolve só o texto de venda. */
export function semBlocoMedidas(bodyHtml) {
  let resto = String(bodyHtml || '');
  const comFim = new RegExp(`${rx(MARCA_INI)}[\\s\\S]*?${rx(MARCA_FIM)}\\s*`, 'i');
  const legado = new RegExp(`${rx(MARCA_INI)}[\\s\\S]*?<\\/table>\\s*`, 'i');
  if (comFim.test(resto)) resto = resto.replace(comFim, '');
  else if (legado.test(resto)) resto = resto.replace(legado, '');
  return resto.replace(/^\s+/, '');
}

/** Descrição final: tabela no topo (mesmo lugar em que já estava nos produtos publicados). */
export function aplicarBloco(bodyHtml, bloco) {
  const resto = semBlocoMedidas(bodyHtml);
  if (!bloco) return resto;
  return resto ? `${bloco}\n${resto}` : bloco;
}

export function temBlocoMedidas(bodyHtml) {
  return String(bodyHtml || '').includes(MARCA_INI);
}

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });
  const sh = { 'X-Shopify-Access-Token': token };

  try {
    if (request.method === 'GET') {
      const q = (new URL(request.url).searchParams.get('q') || '').toLowerCase().trim();
      if (!q) return new Response(JSON.stringify({ erro: 'informe ?q=' }), { status: 400, headers: H });
      const achados = [];
      // sem filtro de status: os produtos antigos por cor continuam ativos e também
      // precisam da tabela, e rascunho em preparação idem.
      let url = `https://${store}/admin/api/${API_VERSION}/products.json?limit=250&fields=id,title,status,body_html`;
      while (url) {
        const res = await fetch(url, { headers: sh });
        if (!res.ok) return new Response(JSON.stringify({ erro: `Shopify ${res.status}`, detalhe: (await res.text()).slice(0, 200) }), { status: 502, headers: H });
        const { products } = await res.json();
        for (const p of products) {
          if ((p.title || '').toLowerCase().includes(q)) {
            achados.push({ id: p.id, title: p.title, status: p.status, temTabela: temBlocoMedidas(p.body_html) });
          }
        }
        const link = res.headers.get('link') || '';
        const prox = link.split(',').find(s => s.includes('rel="next"'));
        url = prox ? prox.slice(prox.indexOf('<') + 1, prox.indexOf('>')) : null;
      }
      achados.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
      return new Response(JSON.stringify({ produtos: achados }), { headers: H });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ erro: 'use GET ?q= ou POST { produtoIds, linhas, tamanhos }' }), { status: 405, headers: H });
    }

    const apply = new URL(request.url).searchParams.get('apply') === '1';
    let body;
    try { body = await request.json(); } catch (_) { return new Response(JSON.stringify({ erro: 'JSON inválido' }), { status: 400, headers: H }); }
    const produtoIds = Array.isArray(body.produtoIds) ? body.produtoIds.filter(Boolean) : [];
    const bloco = montarTabelaHtml(body.linhas, body.tamanhos);
    if (!produtoIds.length) return new Response(JSON.stringify({ erro: 'informe produtoIds' }), { status: 400, headers: H });
    // Sem medida preenchida o bloco sai vazio: publicar isso APAGARIA a tabela que está no ar.
    if (!bloco) return new Response(JSON.stringify({ erro: 'modelo sem medidas preenchidas' }), { status: 400, headers: H });

    const resultados = [];
    for (const id of produtoIds) {
      const base = `https://${store}/admin/api/${API_VERSION}/products/${id}.json`;
      const get = await fetch(base + '?fields=id,title,body_html', { headers: sh });
      if (!get.ok) { resultados.push({ id, erro: `Shopify ${get.status}` }); continue; }
      const p = (await get.json()).product;
      const novo = aplicarBloco(p.body_html, bloco);
      const item = {
        id: p.id, title: p.title,
        acao: temBlocoMedidas(p.body_html) ? 'substitui tabela existente' : 'adiciona tabela',
        chars_antes: (p.body_html || '').length, chars_depois: novo.length,
        resultado: 'dry-run (nada escrito)',
      };
      if (apply) {
        const put = await fetch(base, {
          method: 'PUT', headers: { ...sh, 'Content-Type': 'application/json' },
          body: JSON.stringify({ product: { id: Number(id), body_html: novo } }),
        });
        item.resultado = put.ok ? 'aplicado' : `falha ${put.status}: ${(await put.text()).slice(0, 200)}`;
      } else {
        item.html_novo = novo;
      }
      resultados.push(item);
    }

    return new Response(JSON.stringify({ modo: apply ? 'APLICAR' : 'dry-run', bloco, resultados }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
