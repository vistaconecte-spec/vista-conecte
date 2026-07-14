/**
 * Cloudflare Pages Function: /api/shopify-devolucoes-pendentes (somente leitura)
 * Lista as devoluções com status "solicitada" (ainda não processadas) de toda a loja.
 * Separa TROCA (tem exchangeLineItems — cliente quer outra peça) de DEVOLUÇÃO (reembolso
 * puro, sem exchangeLineItems) — usado pra alimentar automaticamente as abas Troca e
 * Devolução do Atendimento.
 */
const API_VERSION = '2024-04';

const MOTIVOS = {
  SIZE_TOO_SMALL: 'Tamanho pequeno',
  SIZE_TOO_LARGE: 'Muito grande',
  UNWANTED: 'Não quis mais',
  NOT_AS_DESCRIBED: 'Item diferente da descrição',
  WRONG_ITEM: 'Item errado',
  DEFECTIVE: 'Defeito',
  STYLE: 'Estilo não agradou',
  COLOR: 'Cor não agradou',
  OTHER: 'Outro',
  UNKNOWN: 'Não informado',
};

export async function onRequest(context) {
  const { env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });

  try {
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query {
          orders(first: 50, query: "return_status:RETURN_REQUESTED", sortKey: CREATED_AT, reverse: true) {
            nodes {
              name
              shippingAddress { name }
              returns(first: 10) {
                nodes {
                  id name status createdAt
                  returnLineItems(first: 20) {
                    nodes {
                      ... on ReturnLineItem {
                        id quantity returnReason returnReasonNote
                        withCodeDiscountedTotalPriceSet { presentmentMoney { amount currencyCode } }
                        fulfillmentLineItem { lineItem { title variantTitle } }
                      }
                    }
                  }
                  exchangeLineItems(first: 20) {
                    nodes { quantity lineItems { title variantTitle } }
                  }
                }
              }
            }
          }
        }`,
      }),
    });
    const j = await r.json();
    if (j.errors) return new Response(JSON.stringify({ erro: 'Shopify GraphQL', detalhe: j.errors }), { status: 502, headers: H });

    const devolucoes = [];
    const trocas = [];
    for (const o of (j.data?.orders?.nodes || [])) {
      for (const ret of (o.returns?.nodes || [])) {
        if (ret.status !== 'REQUESTED') continue; // já processada — não repete aqui
        const itensDevolvidos = (ret.returnLineItems?.nodes || []).map(li => ({
          qtd: li.quantity,
          titulo: li.fulfillmentLineItem?.lineItem?.title || '?',
          variante: li.fulfillmentLineItem?.lineItem?.variantTitle || null,
          motivo: MOTIVOS[li.returnReason] || li.returnReason,
          motivo_nota: li.returnReasonNote || null,
          valor: li.withCodeDiscountedTotalPriceSet?.presentmentMoney ? parseFloat(li.withCodeDiscountedTotalPriceSet.presentmentMoney.amount) : null,
        }));
        const itensTroca = (ret.exchangeLineItems?.nodes || []).flatMap(ex =>
          (ex.lineItems || []).map(li => ({ qtd: ex.quantity, titulo: li.title, variante: li.variantTitle || null }))
        );
        const cliente = o.shippingAddress?.name || null;
        const fmtPeca = it => `${it.qtd}× ${it.titulo}${it.variante ? ' (' + it.variante + ')' : ''}`;

        if (itensTroca.length > 0) {
          // TROCA: cliente quer outra peça em vez do dinheiro de volta
          trocas.push({
            id: ret.id, // gid://shopify/Return/... — chave única, evita duplicar
            pedido: o.name,
            cliente,
            produtos: itensDevolvidos.map(fmtPeca).join(', '),
            troca_por: itensTroca.map(fmtPeca).join(', '),
            motivo: itensDevolvidos.map(i => i.motivo).filter((v, i2, a) => a.indexOf(v) === i2).join(', '),
            codigo_devolucao: ret.name,
            data: ret.createdAt,
          });
        } else {
          // DEVOLUÇÃO: reembolso puro, uma linha por peça (mantém granularidade de valor)
          const itensComId = (ret.returnLineItems?.nodes || []);
          itensDevolvidos.forEach((it, idx) => {
            devolucoes.push({
              id: itensComId[idx]?.id || `${ret.id}-${idx}`,
              pedido: o.name,
              cliente,
              peca: fmtPeca(it),
              valor: it.valor,
              motivo: it.motivo,
              motivo_nota: it.motivo_nota,
              codigo_devolucao: ret.name,
              data: ret.createdAt,
            });
          });
        }
      }
    }
    return new Response(JSON.stringify({
      total_devolucoes: devolucoes.length, devolucoes,
      total_trocas: trocas.length, trocas,
    }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
