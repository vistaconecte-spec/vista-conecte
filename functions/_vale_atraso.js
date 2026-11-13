/**
 * Vale de compensação por atraso ou tentativa de cancelamento (demanda da Bárbara, 12/11/2026,
 * caso de referência Ana Cecília #9056: a Vi ofereceu R$ 149 de desconto numa peça nova e a
 * cliente aceitou esperar, mas o link nunca saiu porque dependia da equipe criar à mão).
 *
 * Decisão dela: quando a cliente CONFIRMAR que aceita o crédito oferecido por atraso ou
 * tentativa de cancelamento, o voucher sai AUTOMÁTICO, sem passar pela equipe — mas só em
 * pedidos com total >= R$ 300,00 (abaixo disso continua manual, registrar_caso).
 *
 * Mesma mecânica do _vale.js (cupom de valor fixo, uso único, preso à cliente do pedido), só
 * que o código é por PEDIDO (não por item devolvido, não há peça voltando) e a validade é
 * aberta: "fica valendo pra você usar quando quiser" foi a frase que a própria Vi usou no
 * caso de referência, então não aplicamos os 90 dias do vale de devolução aqui.
 */

export const MINIMO_PEDIDO_ATRASO = 300;
export const DIAS_VALE_ATRASO = 180;

// Código estável por pedido: chamar duas vezes devolve o MESMO cupom, nunca dois.
export function codigoValeAtraso(numeroPedido) {
  const num = String(numeroPedido || '').replace(/\D/g, '');
  let h = 2166136261;
  for (const c of 'atraso-' + num) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const sufixo = h.toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').padStart(4, '7').slice(-4);
  return `DESC${num}${sufixo}`;
}

export function dataValeAtraso(agora = new Date()) {
  return new Date(agora.getTime() + DIAS_VALE_ATRASO * 86400000);
}

const reais = v => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Mensagem para a Vi mandar DIRETO na conversa em andamento (sem "Oi nome": ela já está
// conversando, repetir a saudação é o vício corrigido em 06/11/2026). Estilo da loja: sem
// dois-pontos, sem lista, sem travessão.
export function mensagemValeAtraso({ valor, codigo, ate }) {
  const data = new Date(ate).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  return `O desconto de ${reais(valor)} já está liberado pra você usar quando quiser. É só colocar o código ${codigo} no campo de cupom na hora de fechar a compra da peça nova, com o mesmo e-mail do pedido. Vale até ${data} e é de uso único.`;
}
