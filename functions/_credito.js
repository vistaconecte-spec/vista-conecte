/**
 * Crédito na loja de quem devolveu a peça e preferiu ficar com o valor (22/10/2026).
 * Substitui o cupom de uso único do _vale.js: a Bárbara quer que a cliente ganhe SALDO, que ela
 * gasta em quantas compras quiser até acabar, sem perder o troco.
 *
 * Na Shopify é o "crédito na loja" (storeCreditAccountCredit), preso ao cadastro da cliente. Quem
 * comprou como visitante ganha o cadastro com o e-mail do pedido. Regras de sempre: sai quando a
 * peça chega E a equipe confere (botão "conferido, lançar crédito"), vale 90 dias, no valor que
 * ela PAGOU (sem bônus). A Shopify manda o e-mail do crédito; o WhatsApp sai pela conversa.
 */

export const CREDITO_DIAS = 90;

// Marca no pedido original (tag) para o mesmo item nunca virar crédito duas vezes
export function tagCredito(itemId) {
  let h = 2166136261;
  for (const c of String(itemId || '')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return 'credito-' + h.toString(36);
}

export function validadeCredito(agora = new Date()) {
  return new Date(agora.getTime() + CREDITO_DIAS * 86400000);
}

const reais = v => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Estilo da loja: sem dois-pontos, sem lista, sem travessão, sem "amor", direto ao fato.
export function mensagemCredito({ nome, pedido, valor, ate }) {
  const primeiro = String(nome || '').trim().split(/\s+/)[0] || '';
  const data = new Date(ate).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  return `Oi${primeiro ? ' ' + primeiro : ''}, sua peça do pedido ${pedido} chegou e já conferimos. ` +
    `O crédito de ${reais(valor)} está na sua conta da Vista Conecte e vale até ${data}. ` +
    `Pra usar, entra no site e clica no ícone de pessoa lá em cima, coloca o e-mail da compra e digita o código que chega no seu e-mail. ` +
    `Depois é só escolher as peças, o saldo aparece no pagamento e dá pra usar em mais de uma compra até acabar.`;
}

// Nome do cadastro novo a partir do pedido (visitante): primeiro nome e o resto como sobrenome
export function nomeCadastro(nome) {
  const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: partes[0] || '', lastName: partes.slice(1).join(' ') };
}
