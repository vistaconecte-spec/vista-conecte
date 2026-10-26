/**
 * Cloudflare Pages Function: /api/vale-troca (exige sessão, como todo /api)
 *
 * POST { pedido: '#9250', item_id, valor, cliente } → cria na Shopify o cupom do vale-troca da
 * cliente que preferiu crédito na loja (regras em functions/_vale.js) e devolve o código e a
 * mensagem pronta para a Marcelly mandar no WhatsApp.
 *
 * Idempotente: o código sai do item da lista, então clicar duas vezes devolve o cupom que já
 * existe em vez de criar outro. O valor é conferido contra o total pago do pedido.
 *
 * POST { acao: 'credito', pedido, item_id, valor, cliente } (22/10/2026, regra nova da Bárbara):
 * em vez do cupom, lança SALDO no crédito na loja da cliente (functions/_credito.js). Cria o
 * cadastro se ela comprou como visitante, marca o pedido original com uma tag por item (dois
 * cliques = um crédito só), a Shopify manda o e-mail e o WhatsApp sai pela conversa se a cliente
 * falou com a loja nas últimas 24 h; senão a mensagem volta pronta para a Marcelly.
 */
import { codigoVale, validarValor, mensagemVale, inputDesconto, dataVale } from '../_vale.js';
import { tagCredito, validadeCredito, mensagemCredito, nomeCadastro } from '../_credito.js';
import { variantesWa, dentroDaJanela } from './troca-aviso.js';
import { enviarTextoDaLoja } from '../_whatsapp.js';

const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
const Q_PEDIDO_CREDITO = `query($q: String!) {
  orders(first: 1, query: $q) { nodes { id name email phone tags customer { id } shippingAddress { name phone } currentTotalPriceSet { shopMoney { amount } } } }
}`;
const Q_CLIENTE = `query($q: String!) { customers(first: 1, query: $q) { nodes { id email } } }`;
const M_CLIENTE = `mutation($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`;
const M_CREDITO = `mutation($id: ID!, $c: StoreCreditAccountCreditInput!) {
  storeCreditAccountCredit(id: $id, creditInput: $c) {
    storeCreditAccountTransaction { amount { amount } account { id balance { amount } } }
    userErrors { field message code }
  }
}`;
const M_TAG = `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`;

const API_VERSION = '2026-04'; // crédito na loja precisa de versão nova; o cupom antigo funciona igual

const Q_PEDIDO = `query($q: String!) {
  orders(first: 1, query: $q) { nodes { name email customer { id } shippingAddress { name } currentTotalPriceSet { shopMoney { amount } } } }
}`;
const Q_EXISTE = `query($code: String!) {
  codeDiscountNodeByCode(code: $code) { id codeDiscount { ... on DiscountCodeBasic { endsAt status customerGets { value { ... on DiscountAmount { amount { amount } } } } } } }
}`;
const MUTATION = `mutation($d: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $d) {
    codeDiscountNode { id codeDiscount { ... on DiscountCodeBasic { endsAt status codes(first: 1) { nodes { code } } } } }
    userErrors { field message }
  }
}`;

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function onRequestPost({ env, request }) {
  let b = {};
  try { b = await request.json(); } catch { return json({ erro: 'corpo inválido' }, 400); }
  const numero = String(b.pedido || '').replace(/\D/g, '');
  if (!numero || !b.item_id) return json({ erro: 'informe pedido e item_id' }, 400);

  const gql = async (query, variables) => {
    const r = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST', headers: { 'X-Shopify-Access-Token': env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json();
    if (j.errors) throw new Error('Shopify: ' + JSON.stringify(j.errors).slice(0, 200));
    return j.data;
  };

  if (b.acao === 'credito') return lancarCredito(env, gql, b, numero);

  try {
    const o = ((await gql(Q_PEDIDO, { q: `name:#${numero}` })).orders.nodes || [])[0];
    if (!o || o.name !== '#' + numero) return json({ erro: `pedido #${numero} não encontrado na Shopify` }, 404);
    const nome = b.cliente || (o.shippingAddress && o.shippingAddress.name) || '';
    const codigo = codigoVale(numero, b.item_id);

    const existe = (await gql(Q_EXISTE, { code: codigo })).codeDiscountNodeByCode;
    if (existe) {
      const d = existe.codeDiscount || {};
      const valor = Number(d.customerGets?.value?.amount?.amount) || Number(b.valor) || 0;
      return json({ ok: true, ja_existia: true, codigo, valor, ate: d.endsAt, mensagem: mensagemVale({ nome, valor, codigo, ate: d.endsAt }) });
    }

    const v = validarValor(b.valor, o.currentTotalPriceSet?.shopMoney?.amount);
    if (v.erro) return json({ erro: v.erro }, 422);
    const agora = new Date();
    const r = (await gql(MUTATION, { d: inputDesconto({ codigo, valor: v.valor, titulo: `Vale troca #${numero} ${nome}`.trim(), customerId: o.customer && o.customer.id, agora }) })).discountCodeBasicCreate;
    if (r.userErrors && r.userErrors.length) return json({ erro: 'Shopify recusou o cupom: ' + r.userErrors.map(e => e.message).join('; ') }, 400);
    const ate = r.codeDiscountNode?.codeDiscount?.endsAt || dataVale(agora).toISOString();
    return json({ ok: true, codigo, valor: v.valor, ate, preso_a_cliente: !!(o.customer && o.customer.id), mensagem: mensagemVale({ nome, valor: v.valor, codigo, ate }) });
  } catch (e) {
    return json({ erro: e.message }, 502);
  }
}

async function lancarCredito(env, gql, b, numero) {
  try {
    const o = ((await gql(Q_PEDIDO_CREDITO, { q: `name:#${numero}` })).orders.nodes || [])[0];
    if (!o || o.name !== '#' + numero) return json({ erro: `pedido #${numero} não encontrado na Shopify` }, 404);
    const tag = tagCredito(b.item_id);
    if ((o.tags || []).includes(tag)) return json({ ok: true, ja_existia: true, erro_aviso: 'O crédito desta peça já foi lançado antes.' });
    const v = validarValor(b.valor, o.currentTotalPriceSet?.shopMoney?.amount);
    if (v.erro) return json({ erro: v.erro }, 422);
    const nome = b.cliente || (o.shippingAddress && o.shippingAddress.name) || '';

    // Cadastro da cliente: o do pedido, o que já existe com o e-mail, ou um novo (comprou como visitante)
    let clienteId = o.customer && o.customer.id, cadastroCriado = false;
    if (!clienteId) {
      if (!o.email) return json({ erro: 'O pedido não tem e-mail: sem ele não dá para criar o cadastro e guardar o crédito.' }, 422);
      clienteId = (((await gql(Q_CLIENTE, { q: `email:${o.email}` })).customers.nodes) || [])[0]?.id;
      if (!clienteId) {
        const c = (await gql(M_CLIENTE, { input: { email: o.email, ...nomeCadastro(nome) } })).customerCreate;
        if (c.userErrors && c.userErrors.length) return json({ erro: 'Shopify recusou o cadastro: ' + c.userErrors.map(e => e.message).join('; ') }, 400);
        clienteId = c.customer.id; cadastroCriado = true;
      }
    }

    const ate = validadeCredito();
    const r = (await gql(M_CREDITO, { id: clienteId, c: { creditAmount: { amount: String(v.valor), currencyCode: 'BRL' }, expiresAt: ate.toISOString(), notify: true } })).storeCreditAccountCredit;
    if (r.userErrors && r.userErrors.length) return json({ erro: 'Shopify recusou o crédito: ' + r.userErrors.map(e => e.message).join('; ') }, 400);
    await gql(M_TAG, { id: o.id, tags: [tag] }).catch(() => {});
    const saldo = Number(r.storeCreditAccountTransaction?.account?.balance?.amount) || null;
    const mensagem = mensagemCredito({ nome, pedido: o.name, valor: v.valor, ate });
    const whatsapp = await avisarNaConversa(env, { tel: o.shippingAddress?.phone || o.phone, mensagem, msgId: 'credito_' + String(b.item_id).replace(/[^\w:-]/g, ''), pedido: o.name, valor: v.valor });
    return json({ ok: true, valor: v.valor, ate: ate.toISOString(), saldo, cadastro_criado: cadastroCriado, mensagem, whatsapp });
  } catch (e) {
    return json({ erro: e.message }, 502);
  }
}

// Só dentro das 24 h da conversa (texto livre); fora disso a mensagem volta para a Marcelly.
// A Shopify já manda o e-mail do crédito de qualquer jeito (notify: true).
async function avisarNaConversa(env, { tel, mensagem, msgId, pedido, valor }) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !(env.WA_TOKEN || env.META_ACCESS_TOKEN)) return { enviado: false, motivo: 'sem_configuracao' };
  const vars = variantesWa(tel);
  if (!vars.length) return { enviado: false, motivo: 'sem_telefone' };
  const sbH = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
  try {
    const ult = await (await fetch(`${SB_URL}/rest/v1/wati_ia_mensagens?wa_id=in.(${vars.join(',')})&role=eq.user&order=created_at.desc&limit=1&select=wa_id,created_at`, { headers: sbH })).json();
    const ultima = Array.isArray(ult) && ult[0];
    if (!ultima || !dentroDaJanela(ultima.created_at)) return { enviado: false, motivo: 'fora_da_janela' };
    // mensagem da loja pela Meta (26/10/2026; antes pelo Wati): não pausa a Vi
    const s = await enviarTextoDaLoja(env, ultima.wa_id, mensagem);
    if (s.erro) return { enviado: false, motivo: 'meta_recusou' };
    await fetch(`${SB_URL}/rest/v1/wati_ia_mensagens`, {
      method: 'POST', headers: { ...sbH, Prefer: 'return=minimal' },
      body: JSON.stringify({ msg_id: msgId, wa_id: ultima.wa_id, role: 'assistant', texto: `${mensagem}
[contexto interno: crédito na loja de R$ ${valor} lançado na conta dela pelo pedido ${pedido}, depois que a peça chegou e foi conferida. Ele aparece no pagamento quando ela entra com o e-mail da compra.]` }),
    }).catch(() => {});
    return { enviado: true };
  } catch (e) {
    return { enviado: false, motivo: 'erro' };
  }
}
