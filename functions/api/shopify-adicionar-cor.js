/**
 * Cloudflare Pages Function: /api/shopify-adicionar-cor
 * Adiciona uma cor nova a um produto que ainda NÃO foi unificado (só tem opção "Tamanho").
 * Transforma o produto em Cor+Tamanho, mantendo a cor atual (inferida do título) e criando
 * as variantes da cor nova com o mesmo preço/política de estoque das variantes existentes.
 *
 * Dry-run (padrão):
 *   ?id=8122604191853&cor=Preto&novoTitulo=Conjunto Cozy
 * Aplica de verdade:
 *   ?id=8122604191853&cor=Preto&novoTitulo=Conjunto Cozy&confirmar=1
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });

  const qs = new URL(request.url).searchParams;
  const id = (qs.get('id') || '').trim();
  const corNova = (qs.get('cor') || '').trim();
  const novoTitulo = (qs.get('novoTitulo') || '').trim();
  const confirmar = qs.get('confirmar') === '1' || qs.get('apply') === '1';
  if (!id || !corNova) return new Response(JSON.stringify({ erro: 'informe ?id= e ?cor=' }), { status: 400, headers: H });

  const sh = { 'X-Shopify-Access-Token': token };
  const api = (path) => `https://${store}/admin/api/${API_VERSION}/${path}`;

  try {
    const r = await fetch(api(`products/${id}.json`), { headers: sh });
    if (!r.ok) return new Response(JSON.stringify({ erro: `Shopify ${r.status} ao buscar produto` }), { status: 502, headers: H });
    const { product: p } = await r.json();

    if ((p.options || []).some(o => /cor|color/i.test(o.name))) {
      return new Response(JSON.stringify({ erro: 'produto já unificado (já tem opção Cor) — não é o caso deste endpoint' }), { status: 400, headers: H });
    }
    if ((p.options || []).length !== 1) {
      return new Response(JSON.stringify({ erro: 'produto não tem exatamente 1 opção (Tamanho) — conferir manualmente', opcoes: p.options }), { status: 400, headers: H });
    }

    const tituloAtual = p.title.trim();
    const tituloBase = novoTitulo || tituloAtual;
    const corAtual = tituloAtual.startsWith(tituloBase) ? tituloAtual.slice(tituloBase.length).trim() : '';
    if (!corAtual) {
      return new Response(JSON.stringify({ erro: 'não consegui inferir a cor atual do título — passe ?novoTitulo= com o prefixo exato', tituloAtual }), { status: 400, headers: H });
    }

    // Variantes existentes: option1 (tamanho) vira option2; option1 passa a ser a cor atual.
    const variantesAtualizadas = (p.variants || []).map(v => ({
      id: v.id, option1: corAtual, option2: v.option1,
    }));

    // Variantes novas: mesma faixa de tamanho, mesmo preço/política da 1ª variante existente.
    const modelo = (p.variants || [])[0] || {};
    const variantesNovas = (p.variants || []).map(v => ({
      option1: corNova, option2: v.option1,
      price: v.price, inventory_policy: v.inventory_policy, inventory_management: v.inventory_management,
    }));

    const opcaoExistenteId = p.options[0].id;

    let resultado = 'dry-run (nada alterado)';
    let passo1 = null, passo2 = null;
    if (confirmar) {
      // Passo 1: só renomeia a opção existente (Tamanho→Cor) e atualiza os valores das variantes
      // existentes (option1 passa a ser a cor atual). Sem mexer em mais nada — isolado, sem
      // ambiguidade de nome, pra evitar o erro 422 "name of Option is not unique".
      const put1 = await fetch(api(`products/${id}.json`), {
        method: 'PUT', headers: { ...sh, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product: {
            id: p.id,
            options: [{ id: opcaoExistenteId, name: 'Cor' }],
            variants: variantesAtualizadas.map(v => ({ id: v.id, option1: v.option1 })),
          },
        }),
      });
      const j1 = await put1.json();
      passo1 = put1.ok ? 'ok' : `falha ${put1.status}: ${JSON.stringify(j1).slice(0, 400)}`;

      if (put1.ok) {
        // Passo 2: agora "Tamanho" não existe mais (foi renomeada) — adiciona ela como opção nova
        // (posição 2), reposiciona option2 nas variantes existentes e cria as variantes da cor nova.
        const put2 = await fetch(api(`products/${id}.json`), {
          method: 'PUT', headers: { ...sh, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product: {
              id: p.id,
              title: tituloBase,
              options: [{ id: opcaoExistenteId, name: 'Cor' }, { name: 'Tamanho' }],
              variants: [...variantesAtualizadas, ...variantesNovas],
            },
          }),
        });
        const j2 = await put2.json();
        passo2 = put2.ok ? 'ok' : `falha ${put2.status}: ${JSON.stringify(j2).slice(0, 400)}`;
        resultado = put2.ok ? 'aplicado' : 'falhou no passo 2 (passo 1 já foi feito — produto ficou com só 1 cor, conferir manualmente)';
      } else {
        resultado = 'falhou no passo 1 (nada foi alterado)';
      }
    }

    return new Response(JSON.stringify({
      produto_id: id, titulo_atual: tituloAtual, titulo_novo: tituloBase,
      cor_atual_detectada: corAtual, cor_nova: corNova,
      variantes_existentes: variantesAtualizadas.length, variantes_novas: variantesNovas.length,
      preco_usado: modelo.price, modo: confirmar ? 'APLICAR' : 'dry-run', resultado, passo1, passo2,
    }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
