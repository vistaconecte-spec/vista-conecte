/**
 * Cloudflare Pages Function: /api/shopify-adicionar-cor
 * Adiciona uma cor nova a um produto que ainda NÃO foi unificado (só tem opção "Tamanho").
 * Usa a API GraphQL (productOptionsCreate) — a REST não suporta bem adicionar um eixo de
 * opção novo a um produto já existente (testado: dá erro de nome/variante duplicada).
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

  const sh = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  const restApi = (path) => `https://${store}/admin/api/${API_VERSION}/${path}`;
  const gqlApi = () => `https://${store}/admin/api/${API_VERSION}/graphql.json`;
  const gql = async (query, variables) => {
    const r = await fetch(gqlApi(), { method: 'POST', headers: sh, body: JSON.stringify({ query, variables }) });
    return { ok: r.ok, status: r.status, json: await r.json() };
  };

  try {
    const r = await fetch(restApi(`products/${id}.json`), { headers: sh });
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

    const modelo = (p.variants || [])[0] || {};
    const gid = `gid://shopify/Product/${id}`;

    let resultado = 'dry-run (nada alterado)';
    let passoOpcao = null, passoPreco = null, passoTitulo = null;
    if (confirmar) {
      // Passo 1 — GraphQL productOptionsCreate: adiciona a opção "Cor" (Marsala + Preto).
      // variantStrategy CREATE: as variantes existentes viram "Marsala" (1º valor) e o Shopify
      // cria sozinho as variantes novas de "Preto" pra cada tamanho já existente.
      const MUT_OPCAO = `
        mutation AddCor($productId: ID!, $options: [OptionCreateInput!]!) {
          productOptionsCreate(productId: $productId, options: $options, variantStrategy: CREATE) {
            product {
              id
              options { id name position values }
              variants(first: 50) { nodes { id title price selectedOptions { name value } } }
            }
            userErrors { field message }
          }
        }`;
      const respOpcao = await gql(MUT_OPCAO, {
        productId: gid,
        options: [{ name: 'Cor', values: [{ name: corAtual }, { name: corNova }] }],
      });
      const dataOpcao = respOpcao.json?.data?.productOptionsCreate;
      const errosOpcao = [...(respOpcao.json?.errors || []), ...(dataOpcao?.userErrors || [])];
      passoOpcao = errosOpcao.length ? `falha: ${JSON.stringify(errosOpcao).slice(0, 400)}` : 'ok';

      if (!errosOpcao.length) {
        const variantesNovas = (dataOpcao.product.variants.nodes || [])
          .filter(v => v.selectedOptions.some(o => o.name === 'Cor' && o.value === corNova));

        // Passo 2 — ajusta preço/política das variantes novas (Preto) pra igualar as existentes
        // (o Shopify não copia preço/estoque automaticamente ao criar via variantStrategy CREATE).
        const MUT_PRECO = `
          mutation FixPreco($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              productVariants { id price }
              userErrors { field message }
            }
          }`;
        const respPreco = await gql(MUT_PRECO, {
          productId: gid,
          variants: variantesNovas.map(v => ({ id: v.id, price: modelo.price })),
        });
        const dataPreco = respPreco.json?.data?.productVariantsBulkUpdate;
        const errosPreco = [...(respPreco.json?.errors || []), ...(dataPreco?.userErrors || [])];
        passoPreco = errosPreco.length ? `falha: ${JSON.stringify(errosPreco).slice(0, 400)}` : `ok (${variantesNovas.length} variantes)`;

        // Passo 3 — renomeia o título (REST, simples, sem mexer em variantes/opções).
        if (tituloBase !== tituloAtual) {
          const putTitulo = await fetch(restApi(`products/${id}.json`), {
            method: 'PUT', headers: sh, body: JSON.stringify({ product: { id: p.id, title: tituloBase } }),
          });
          passoTitulo = putTitulo.ok ? 'ok' : `falha ${putTitulo.status}`;
        } else passoTitulo = 'não precisou (título igual)';

        resultado = (!errosPreco.length) ? 'aplicado' : 'opção criada, mas preço das variantes novas falhou — conferir manualmente';
      } else {
        resultado = 'falhou ao criar a opção (nada foi alterado)';
      }
    }

    return new Response(JSON.stringify({
      produto_id: id, titulo_atual: tituloAtual, titulo_novo: tituloBase,
      cor_atual_detectada: corAtual, cor_nova: corNova,
      preco_usado: modelo.price, modo: confirmar ? 'APLICAR' : 'dry-run', resultado,
      passo_opcao: passoOpcao, passo_preco: passoPreco, passo_titulo: passoTitulo,
    }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
