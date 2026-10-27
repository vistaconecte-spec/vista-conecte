/**
 * Cloudflare Pages Function: /api/trocas-portal (PÚBLICO, sem sessão)
 *
 * Portal de trocas e devoluções da página /trocas (19/10/2026). A cliente entra com o número do
 * pedido e o e-mail da compra, sem login, escolhe as peças e diz se quer trocar por outro
 * tamanho/cor ou ficar com crédito na loja (dinheiro de volta saiu do portal em 27/10/2026).
 *
 * POST { acao: 'consultar', pedido, email }          → peças, preço pago e prazos
 * POST { acao: 'enviar', pedido, email, itens: [...] } → grava a solicitação
 *
 * Segurança: público como o previsao-pedido, mas só responde a quem acerta número E e-mail, e a
 * resposta é a mesma para "pedido não existe" e "e-mail não confere" (não dá para descobrir
 * pedidos chutando número). Não devolve endereço, telefone nem CPF. No envio, tudo é relido da
 * Shopify: preço, prazo e opções de troca nunca vêm da página.
 *
 * Cada solicitação vira UMA linha `troca-portal:<pedido>-<ts>` no vc_modelos (padrão do
 * cartão barrado): duas clientes enviando ao mesmo tempo não disputam a mesma linha, e as abas
 * TROCA e DEVOLUÇÃO do painel importam essas linhas com a mesclagem por id de sempre.
 * E-mail e telefone NÃO vão para o Supabase (a chave anon é pública): o painel acha o contato
 * pelo número do pedido na Shopify quando for mandar o código.
 */
import { normalizarPedido, normalizarEmail, pedidoPublico, casarAvulso, validarSolicitacao, idDoc, protocolo, PREFIXO_DOC, MOTIVOS } from '../_trocas.js';
import { criarPedidoTroca, gqlDe } from '../_pedido-troca.js';

const API_VERSION = '2026-04';
const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhja3pzYmx3eWFibWh6Ympkamd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNTEyOTIsImV4cCI6MjA5NDcyNzI5Mn0.guif8jtidWmfqykhgDgPJiaRbWLoEEDMp1usTlAs1dQ';
const NAO_ACHOU = 'Não encontramos um pedido com esse número e esse e-mail. Confira os dois (o e-mail é o mesmo usado na compra).';

const QUERY = `query($q: String!) {
  orders(first: 1, query: $q) {
    nodes {
      name email cancelledAt
      customer { firstName }
      shippingAddress { firstName name }
      fulfillments(first: 10) { createdAt deliveredAt status }
      returns(first: 10) {
        nodes {
          status
          returnLineItems(first: 30) { nodes { ... on ReturnLineItem { quantity fulfillmentLineItem { lineItem { id } } } } }
        }
      }
      lineItems(first: 30) {
        nodes {
          id title variantTitle quantity currentQuantity
          image { url(transform: { maxWidth: 200 }) }
          discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
          variant { id }
          product { variants(first: 60) { nodes { id title availableForSale } } }
        }
      }
    }
  }
}`;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

const sbHeaders = (env, extra = {}) => {
  const k = env.SUPABASE_ANON_KEY || SB_ANON;
  return { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', ...extra };
};

const QUERY_PRODUTOS = `query($q: String!) {
  products(first: 15, query: $q) {
    nodes { title status featuredImage { url(transform: { maxWidth: 200 }) } variants(first: 60) { nodes { id title availableForSale } } }
  }
}`;

async function gql(env, query, variables) {
  const r = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error('Shopify ' + r.status);
  const j = await r.json();
  if (j.errors) throw new Error('Shopify GraphQL');
  return j.data;
}

// Item avulso (sem produto): busca pelas duas primeiras palavras e deixa o casarAvulso decidir.
// Falha aqui não derruba o portal, a peça só fica sem a opção de troca, como antes.
async function completarAvulsos(env, order) {
  for (const li of (order.lineItems && order.lineItems.nodes) || []) {
    if (li.product || !li.title) continue;
    const palavras = String(li.title).replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 2);
    if (!palavras.length) continue;
    try {
      const d = await gql(env, QUERY_PRODUTOS, { q: `title:${palavras.join('\\ ')}*` });
      const c = casarAvulso(li.title, d?.products?.nodes);
      if (c) { li.product = c.product; li.variante_atual_id = c.variante_atual_id; li.imagem_casada = c.imagem; }
    } catch (e) {
      console.error('[trocas-portal] avulso', e && e.message);
    }
  }
}

async function lerPedido(env, numero) {
  const d = await gql(env, QUERY, { q: `name:#${numero}` });
  const o = (d?.orders?.nodes || [])[0];
  return o && o.name === '#' + numero ? o : null;
}

async function lerSolicitacoes(env, numero) {
  const r = await fetch(`${SB_URL}/rest/v1/vc_modelos?id=like.${encodeURIComponent(`${PREFIXO_DOC}${numero}-*`)}&select=dados`, { headers: sbHeaders(env) });
  if (!r.ok) throw new Error('Supabase ' + r.status);
  return (await r.json()).map(x => x.dados).filter(Boolean);
}

export async function onRequestPost(context) {
  const { env, request } = context;
  let body;
  try { body = await request.json(); } catch { return json({ erro: 'Pedido inválido.' }, 400); }
  const numero = normalizarPedido(body.pedido);
  const email = normalizarEmail(body.email);
  if (!numero || !email || email.length > 120 || !email.includes('@')) return json({ erro: 'Preencha o número do pedido e o e-mail da compra.' }, 400);

  try {
    const order = await lerPedido(env, numero);
    if (!order || normalizarEmail(order.email) !== email) return json({ erro: NAO_ACHOU }, 404);
    await completarAvulsos(env, order);
    const docs = await lerSolicitacoes(env, numero);
    const pub = pedidoPublico(order, docs);

    if (body.acao === 'consultar') return json({ ...pub, motivos: MOTIVOS });

    if (body.acao === 'enviar') {
      const v = validarSolicitacao(pub, body.itens);
      if (v.erro) return json({ erro: v.erro }, 422);
      const agora = new Date();
      const id = idDoc(numero, agora);
      const doc = {
        id,
        protocolo: protocolo(id),
        origem: 'portal',
        pedido: order.name,
        cliente: (order.shippingAddress && order.shippingAddress.name) || '',
        criado_em: agora.toISOString(),
        itens: v.itens,
      };
      const r = await fetch(`${SB_URL}/rest/v1/vc_modelos`, {
        method: 'POST', headers: sbHeaders(env, { Prefer: 'return=minimal' }),
        body: JSON.stringify({ id, dados: doc }),
      });
      if (!r.ok) throw new Error('Supabase ' + r.status);
      // Troca por outro tamanho/cor: o pedido de R$ 0 da peça nova nasce JÁ, travado até a
      // antiga chegar (fluxo validado em 19/10/2026). Se a Shopify falhar, a solicitação já
      // está gravada: o erro fica na linha e a aba TROCAS mostra "criar pedido de troca".
      if (v.itens.some(i => i.tipo === 'troca')) {
        let extra;
        try {
          const pt = await criarPedidoTroca(gqlDe(env), { numeroOriginal: numero, itens: v.itens, protocolo: doc.protocolo });
          extra = pt ? { pedido_troca: { id: pt.id, name: pt.name, travado: pt.travado !== false, criado_em: new Date().toISOString() } } : {};
        } catch (e) {
          console.error('[trocas-portal] pedido de troca', e && e.message);
          extra = { erro_pedido_troca: String((e && e.message) || e).slice(0, 300) };
        }
        await fetch(`${SB_URL}/rest/v1/vc_modelos?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH', headers: sbHeaders(env, { Prefer: 'return=minimal' }),
          body: JSON.stringify({ dados: { ...doc, ...extra } }),
        }).catch(() => {});
      }
      return json({ ok: true, protocolo: doc.protocolo, itens: v.itens.map(i => ({ titulo: i.titulo, tipo: i.tipo, nova_variante: i.nova_variante })) });
    }
    return json({ erro: 'Ação desconhecida.' }, 400);
  } catch (e) {
    console.error('[trocas-portal]', e && e.message);
    return json({ erro: 'Não conseguimos abrir seu pedido agora. Tente de novo em alguns minutos ou fale com a gente pelo WhatsApp.' }, 502);
  }
}
