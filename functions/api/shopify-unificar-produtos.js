/**
 * Cloudflare Pages Function: /api/shopify-unificar-produtos
 * Mescla um produto-origem (1+ cores) dentro de um produto-destino que JÁ tem opção "Cor"
 * (diferente do /api/shopify-unificar, que junta produtos ainda sem opção Cor nenhuma).
 * Copia preço/estoque de cada variante da origem (casando por tamanho). Depois cria o
 * redirect da URL antiga pra nova e arquiva a origem — nessa ordem, cada passo só roda
 * se o anterior deu certo. Sem isso, unificação já quebrou anúncio antes (não pular o redirect).
 *
 * Dry-run (padrão):
 *   ?idDestino=X&idOrigem=Y&novoTitulo=Nome Unificado
 * Aplica de verdade:
 *   ?idDestino=X&idOrigem=Y&novoTitulo=Nome Unificado&confirmar=1
 */
const API_VERSION = '2024-04';

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });

  const qs = new URL(request.url).searchParams;
  const idDestino = (qs.get('idDestino') || '').trim();
  const idOrigem = (qs.get('idOrigem') || '').trim();
  const novoTitulo = (qs.get('novoTitulo') || '').trim();
  const confirmar = qs.get('confirmar') === '1';
  if (!idDestino || !idOrigem) return new Response(JSON.stringify({ erro: 'informe ?idDestino= e ?idOrigem=' }), { status: 400, headers: H });

  const sh = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  const restApi = (path) => `https://${store}/admin/api/${API_VERSION}/${path}`;
  const gqlApi = () => `https://${store}/admin/api/${API_VERSION}/graphql.json`;
  const gql = async (query, variables) => {
    const r = await fetch(gqlApi(), { method: 'POST', headers: sh, body: JSON.stringify({ query, variables }) });
    return { ok: r.ok, status: r.status, json: await r.json() };
  };

  try {
    const [rDest, rOrig] = await Promise.all([
      fetch(restApi(`products/${idDestino}.json`), { headers: sh }),
      fetch(restApi(`products/${idOrigem}.json`), { headers: sh }),
    ]);
    if (!rDest.ok || !rOrig.ok) return new Response(JSON.stringify({ erro: 'falha ao buscar produtos', destino: rDest.status, origem: rOrig.status }), { status: 502, headers: H });
    const { product: destino } = await rDest.json();
    const { product: origem } = await rOrig.json();

    const corOpDestino = (destino.options || []).find(o => /cor|color/i.test(o.name));
    const tamOpDestino = (destino.options || []).find(o => /tamanho|size/i.test(o.name));
    const corOpOrigem = (origem.options || []).find(o => /cor|color/i.test(o.name));
    if (!corOpDestino) return new Response(JSON.stringify({ erro: 'produto destino não tem opção Cor — usar /api/shopify-adicionar-cor nesse caso' }), { status: 400, headers: H });
    if (!corOpOrigem) return new Response(JSON.stringify({ erro: 'produto origem não tem opção Cor' }), { status: 400, headers: H });

    // Descobre qual posição (option1/2/3) é Cor e qual é Tamanho, em cada produto
    const posDestino = destino.options.indexOf(corOpDestino) + 1;
    const posTamDestino = tamOpDestino ? destino.options.indexOf(tamOpDestino) + 1 : (posDestino === 1 ? 2 : 1);
    const posOrigem = origem.options.indexOf(corOpOrigem) + 1;
    const posTamOrigem = posOrigem === 1 ? 2 : 1;

    const coresNovas = corOpOrigem.values.filter(c => !corOpDestino.values.includes(c));
    const gid = `gid://shopify/Product/${idDestino}`;

    let passoOpcao = null, passoPreco = null, passoTitulo = null, passoRedirect = null, passoArquivar = null;
    let resultado = 'dry-run (nada alterado)';

    // Busca o linkedMetafieldValue de cada cor nova (a opção Cor é vinculada ao metafield
    // shopify.color-pattern — não aceita valor solto em texto, precisa do metaobject).
    // Roda também no dry-run (só leitura) pra dar pra conferir o payload antes de aplicar.
    const QUERY_OPCOES = `
      query($id: ID!) {
        product(id: $id) {
          options { id name optionValues { name linkedMetafieldValue } }
        }
      }`;
    const respOrigemOpcoes = await gql(QUERY_OPCOES, { id: `gid://shopify/Product/${idOrigem}` });
    const corOpOrigemGql = (respOrigemOpcoes.json?.data?.product?.options || []).find(o => o.name === corOpOrigem.name);
    const linkedPorNome = {};
    (corOpOrigemGql?.optionValues || []).forEach(v => { linkedPorNome[v.name] = v.linkedMetafieldValue; });
    const payloadOptionValuesToAdd = coresNovas.map(c => ({ name: c, linkedMetafieldValue: linkedPorNome[c] || null }));

    if (confirmar) {
      if (coresNovas.length > 0) {
        const MUT_OPCAO = `
          mutation AddCores($productId: ID!, $optionId: ID!, $optionValuesToAdd: [OptionValueCreateInput!]!) {
            productOptionUpdate(productId: $productId, option: { id: $optionId }, optionValuesToAdd: $optionValuesToAdd, variantStrategy: MANAGE) {
              product { id variants(first: 100) { nodes { id selectedOptions { name value } } } }
              userErrors { field message }
            }
          }`;
        const respOpcao = await gql(MUT_OPCAO, {
          productId: gid,
          optionId: `gid://shopify/ProductOption/${corOpDestino.id}`,
          optionValuesToAdd: payloadOptionValuesToAdd,
        });
        const dataOpcao = respOpcao.json?.data?.productOptionUpdate;
        const errosOpcao = [...(respOpcao.json?.errors || []), ...(dataOpcao?.userErrors || [])];
        passoOpcao = errosOpcao.length ? `falha: ${JSON.stringify(errosOpcao).slice(0, 400)}` : 'ok';

        if (!errosOpcao.length) {
          // Casa cada variante nova (por cor+tamanho) com a variante equivalente da origem, pra copiar preço/estoque
          const porTamCor = {};
          for (const v of (origem.variants || [])) {
            const cor = posOrigem === 1 ? v.option1 : v.option2;
            const tam = posTamOrigem === 1 ? v.option1 : v.option2;
            porTamCor[`${tam}::${cor}`] = v;
          }
          const variantesNovas = (dataOpcao.product.variants.nodes || []).filter(v =>
            coresNovas.includes((v.selectedOptions.find(o => o.name === corOpDestino.name) || {}).value)
          );
          const updates = variantesNovas.map(v => {
            const cor = (v.selectedOptions.find(o => o.name === corOpDestino.name) || {}).value;
            const tam = (v.selectedOptions.find(o => o.name !== corOpDestino.name) || {}).value;
            const orig = porTamCor[`${tam}::${cor}`];
            return orig ? { id: v.id, price: orig.price } : null;
          }).filter(Boolean);

          const MUT_PRECO = `
            mutation FixPreco($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                productVariants { id price }
                userErrors { field message }
              }
            }`;
          const respPreco = await gql(MUT_PRECO, { productId: gid, variants: updates });
          const dataPreco = respPreco.json?.data?.productVariantsBulkUpdate;
          const errosPreco = [...(respPreco.json?.errors || []), ...(dataPreco?.userErrors || [])];
          passoPreco = errosPreco.length ? `falha: ${JSON.stringify(errosPreco).slice(0, 400)}` : `ok (${updates.length} variantes)`;

          if (novoTitulo && novoTitulo !== destino.title) {
            const putTitulo = await fetch(restApi(`products/${idDestino}.json`), {
              method: 'PUT', headers: sh, body: JSON.stringify({ product: { id: destino.id, title: novoTitulo } }),
            });
            passoTitulo = putTitulo.ok ? 'ok' : `falha ${putTitulo.status}`;
          } else passoTitulo = 'não precisou';

          // Redirect da URL antiga (origem) pra nova (destino) — só depois que a mesclagem deu certo
          const redirectRes = await fetch(restApi('redirects.json'), {
            method: 'POST', headers: sh,
            body: JSON.stringify({ redirect: { path: `/products/${origem.handle}`, target: `/products/${destino.handle}` } }),
          });
          const redirectJson = await redirectRes.json();
          passoRedirect = redirectRes.ok ? 'ok' : `falha ${redirectRes.status}: ${JSON.stringify(redirectJson).slice(0, 300)}`;

          // Só arquiva a origem se o redirect deu certo — senão o link antigo vira 404
          if (redirectRes.ok) {
            const putArquivar = await fetch(restApi(`products/${idOrigem}.json`), {
              method: 'PUT', headers: sh, body: JSON.stringify({ product: { id: origem.id, status: 'archived' } }),
            });
            passoArquivar = putArquivar.ok ? 'ok' : `falha ${putArquivar.status}`;
          } else {
            passoArquivar = 'pulado (redirect falhou — produto origem continua ativo pra não quebrar o link)';
          }

          resultado = (!errosPreco.length && redirectRes.ok) ? 'aplicado' : 'aplicado parcialmente — conferir passos com falha';
        } else {
          resultado = 'falhou ao adicionar cores (nada foi alterado)';
        }
      } else {
        resultado = 'nenhuma cor nova pra adicionar (origem e destino já têm as mesmas cores)';
      }
    }

    return new Response(JSON.stringify({
      destino: { id: idDestino, titulo_atual: destino.title, handle: destino.handle, cores_atuais: corOpDestino.values },
      origem: { id: idOrigem, titulo: origem.title, handle: origem.handle, cores: corOpOrigem.values },
      cores_a_adicionar: coresNovas, novo_titulo: novoTitulo || destino.title,
      debug_payload_optionValuesToAdd: payloadOptionValuesToAdd,
      debug_query_origem_erro: respOrigemOpcoes.json?.errors || null,
      modo: confirmar ? 'APLICAR' : 'dry-run', resultado,
      passo_opcao: passoOpcao, passo_preco: passoPreco, passo_titulo: passoTitulo, passo_redirect: passoRedirect, passo_arquivar: passoArquivar,
    }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
