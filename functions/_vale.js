/**
 * Vale-troca (crédito na loja) de quem devolveu a peça e preferiu ficar com o valor na loja.
 * Regras da Bárbara (19/10/2026): o vale sai QUANDO A PEÇA CHEGA, vale 90 dias, é no valor
 * que a cliente PAGOU (sem bônus) e a Marcelly manda no WhatsApp.
 *
 * Na Shopify ele é um cupom de valor fixo, de UM uso, preso à cliente do pedido. Limitação:
 * cupom de uso único não guarda troco; se ela comprar menos que o vale, a diferença se perde.
 * Por isso a mensagem avisa. (Vale-presente com saldo precisaria do escopo write_gift_cards.)
 */

export const VALE_DIAS = 90;

// Código estável por linha da lista: clicar duas vezes devolve o MESMO cupom, nunca dois.
export function codigoVale(numeroPedido, itemId) {
  const num = String(numeroPedido || '').replace(/\D/g, '');
  let h = 2166136261;
  for (const c of String(itemId || '')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const sufixo = h.toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').padStart(4, '7').slice(-4);
  return `VALE${num}${sufixo}`;
}

export function dataVale(agora = new Date()) {
  return new Date(agora.getTime() + VALE_DIAS * 86400000);
}

// Confere o valor contra o que o pedido realmente pagou (a linha pode ter sido digitada à mão)
export function validarValor(valor, pagoNoPedido) {
  const v = Math.round((Number(valor) || 0) * 100) / 100;
  if (!(v > 0)) return { erro: 'Esta linha está sem valor. Preencha o valor pago antes de gerar o vale.' };
  if (pagoNoPedido != null && v > Number(pagoNoPedido) + 0.01) return { erro: `O valor do vale (R$ ${v.toFixed(2).replace('.', ',')}) passa do que o pedido pagou (R$ ${Number(pagoNoPedido).toFixed(2).replace('.', ',')}).` };
  return { valor: v };
}

const reais = v => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Mensagem que a Marcelly cola no WhatsApp. Estilo da loja: sem dois-pontos, sem lista, sem
// travessão, sem "amor", direto ao fato.
export function mensagemVale({ nome, valor, codigo, ate }) {
  const primeiro = String(nome || '').trim().split(/\s+/)[0] || '';
  const data = new Date(ate).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  return `Oi${primeiro ? ' ' + primeiro : ''}, sua peça chegou aqui e já liberamos seu vale de ${reais(valor)} para usar na loja. ` +
    `É só colocar o código ${codigo} no campo de cupom quando for finalizar a compra, com o mesmo e-mail do pedido. ` +
    `Ele vale até ${data} e é de uso único, então aproveita numa compra de ${reais(valor)} ou mais para não sobrar nada.`;
}

export function inputDesconto({ codigo, valor, titulo, customerId, agora = new Date() }) {
  return {
    title: titulo,
    code: codigo,
    startsAt: agora.toISOString(),
    endsAt: dataVale(agora).toISOString(),
    usageLimit: 1,
    appliesOncePerCustomer: true,
    // `context` e não `customerSelection`: nesta loja a API já não aceita o nome antigo
    // (conferido por introspecção em 19/10/2026).
    context: customerId ? { customers: { add: [customerId] } } : { all: 'ALL' },
    customerGets: { value: { discountAmount: { amount: String(valor), appliesOnEachItem: false } }, items: { all: true } },
    // O vale é dinheiro dela: soma com desconto de produto (combo) e de frete; não soma com
    // outro cupom de pedido, igual aos outros cupons da loja.
    combinesWith: { orderDiscounts: false, productDiscounts: true, shippingDiscounts: true },
  };
}
