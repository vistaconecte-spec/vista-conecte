/**
 * Regras do portal de trocas e devoluções (/trocas, sem login), separadas do endpoint
 * para os testes rodarem em Node sem Shopify nem Supabase.
 *
 * Regras da Bárbara (19/10/2026):
 *  - troca por outro tamanho/cor e crédito na loja: até 30 dias depois de receber;
 *  - dinheiro de volta: só nos 7 dias do direito de arrependimento;
 *  - crédito sem bônus: vale o que a cliente pagou na peça (já com os descontos do pedido);
 *  - troca é gratuita (a loja manda o código dos Correios).
 *
 * A Shopify quase nunca sabe o dia da entrega (deliveredAt vem nulo quando o envio é pela
 * Frenet). Sem ele, conta a partir do envio + TRANSITO_ESTIMADO_DIAS. É de propósito o lado
 * generoso: errar a favor da cliente custa alguns dias; errar contra é recusar quem tem direito.
 */

export const PRAZO_TROCA_DIAS = 30;
export const PRAZO_DEVOLUCAO_DIAS = 7;
export const TRANSITO_ESTIMADO_DIAS = 8;
export const PREFIXO_DOC = 'troca-portal:';
export const TIPOS = ['troca', 'credito', 'devolucao'];
export const MOTIVOS = [
  'Ficou pequeno',
  'Ficou grande',
  'Não gostei do modelo',
  'Cor diferente do esperado',
  'Defeito na peça',
  'Veio peça errada',
  'Outro motivo',
];

const DIA = 86400000;

export function normalizarPedido(v) {
  return String(v || '').replace(/\D/g, '').slice(0, 10);
}

export function normalizarEmail(v) {
  return String(v || '').trim().toLowerCase();
}

// Dia em que a cliente recebeu (ou, sem rastreio de entrega, o envio + trânsito estimado).
// null = nada enviado ainda.
export function dataRecebimento(order) {
  const fs = (order.fulfillments || []).filter(f => f && f.createdAt && f.status !== 'CANCELLED' && f.status !== 'FAILURE');
  if (!fs.length) return null;
  const entregues = fs.map(f => f.deliveredAt).filter(Boolean).sort();
  if (entregues.length) return { em: new Date(entregues[entregues.length - 1]), estimada: false };
  const envio = fs.map(f => f.createdAt).sort().pop();
  return { em: new Date(new Date(envio).getTime() + TRANSITO_ESTIMADO_DIAS * DIA), estimada: true };
}

function fimDoDia(d) {
  // Prazo vale o dia inteiro no horário de Brasília (UTC-3): 23:59 de lá = 02:59Z do dia seguinte.
  const x = new Date(d.getTime());
  x.setUTCHours(26, 59, 59, 999);
  return x;
}

export function prazos(order, agora = new Date()) {
  const rec = dataRecebimento(order);
  if (!rec) return { enviado: false, pode_trocar: false, pode_devolver: false };
  const trocaAte = fimDoDia(new Date(rec.em.getTime() + PRAZO_TROCA_DIAS * DIA));
  const devolucaoAte = fimDoDia(new Date(rec.em.getTime() + PRAZO_DEVOLUCAO_DIAS * DIA));
  return {
    enviado: true,
    recebido_em: rec.em.toISOString(),
    recebimento_estimado: rec.estimada,
    troca_ate: trocaAte.toISOString(),
    devolucao_ate: devolucaoAte.toISOString(),
    pode_trocar: agora <= trocaAte,
    pode_devolver: agora <= devolucaoAte,
  };
}

// Quantas unidades de cada linha já foram pedidas no portal (para não pedir a mesma peça duas vezes)
export function jaSolicitadoPorLinha(docs) {
  const m = {};
  for (const d of docs || []) {
    for (const it of (d && d.itens) || []) {
      if (!it || !it.line_id) continue;
      m[it.line_id] = (m[it.line_id] || 0) + (Number(it.qtd) || 0);
    }
  }
  return m;
}

const valorDe = li => {
  const v = parseFloat(li?.discountedUnitPriceAfterAllDiscountsSet?.shopMoney?.amount);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
};

// Unidades que já estão numa devolução aberta pela conta da cliente na Shopify (o caminho
// antigo, que continua existindo): sem isto ela pediria a mesma peça pelos dois lados.
export function jaDevolvidoNaShopify(order) {
  const m = {};
  for (const r of (order.returns && order.returns.nodes) || []) {
    if (!r || r.status === 'CANCELED' || r.status === 'DECLINED') continue;
    for (const li of (r.returnLineItems && r.returnLineItems.nodes) || []) {
      const id = li && li.fulfillmentLineItem && li.fulfillmentLineItem.lineItem && li.fulfillmentLineItem.lineItem.id;
      if (id) m[id] = (m[id] || 0) + (Number(li.quantity) || 0);
    }
  }
  return m;
}

// O que a página pode ver do pedido. Nada de endereço, telefone, CPF ou e-mail: quem acertou
// número + e-mail só enxerga as peças, o preço pago e o prazo.
export function pedidoPublico(order, docs, agora = new Date()) {
  const p = prazos(order, agora);
  const ja = jaSolicitadoPorLinha(docs);
  const naShopify = jaDevolvidoNaShopify(order);
  const itens = ((order.lineItems && order.lineItems.nodes) || [])
    .filter(li => (li.currentQuantity ?? li.quantity) > 0)
    .map(li => {
      const qtd = li.currentQuantity ?? li.quantity;
      const atual = li.variant && li.variant.id;
      const opcoes = ((li.product && li.product.variants && li.product.variants.nodes) || [])
        .filter(v => v.id !== atual && v.availableForSale !== false)
        .map(v => ({ id: v.id, titulo: v.title }));
      return {
        id: li.id,
        titulo: li.title,
        variante: li.variantTitle || '',
        imagem: (li.image && li.image.url) || '',
        valor_unit: valorDe(li),
        qtd,
        qtd_disponivel: Math.max(0, qtd - (ja[li.id] || 0) - (naShopify[li.id] || 0)),
        opcoes_troca: opcoes,
      };
    });
  const nome = (order.shippingAddress && order.shippingAddress.firstName) || (order.customer && order.customer.firstName) || '';
  return {
    pedido: order.name,
    primeiro_nome: String(nome).trim().split(/\s+/)[0] || '',
    cancelado: !!order.cancelledAt,
    ...p,
    itens,
  };
}

// Confere o que a página mandou contra o pedido REAL (relido da Shopify). Preço, prazo e
// opções de troca nunca vêm da página.
export function validarSolicitacao(pub, pedidos) {
  if (pub.cancelado) return { erro: 'Este pedido foi cancelado. Fale com a gente pelo WhatsApp.' };
  if (!pub.enviado) return { erro: 'Este pedido ainda não foi enviado. Fale com a gente pelo WhatsApp.' };
  if (!Array.isArray(pedidos) || !pedidos.length) return { erro: 'Escolha pelo menos uma peça.' };
  if (pedidos.length > 30) return { erro: 'Pedido inválido.' };
  const porId = Object.fromEntries(pub.itens.map(i => [i.id, i]));
  const usado = {};
  const itens = [];
  for (const s of pedidos) {
    const it = porId[s && s.line_id];
    if (!it) return { erro: 'Uma das peças não é deste pedido.' };
    const tipo = TIPOS.includes(s.tipo) ? s.tipo : null;
    if (!tipo) return { erro: `Escolha o que você prefere para ${it.titulo}.` };
    const qtd = Math.floor(Number(s.qtd) || 1);
    usado[it.id] = (usado[it.id] || 0) + qtd;
    if (qtd < 1 || usado[it.id] > it.qtd_disponivel) return { erro: `${it.titulo} já foi solicitada ou a quantidade passou do que veio no pedido.` };
    if (tipo === 'devolucao' && !pub.pode_devolver) return { erro: 'O prazo de 7 dias para dinheiro de volta já passou. Você ainda pode trocar ou ficar com crédito na loja.' };
    if (tipo !== 'devolucao' && !pub.pode_trocar) return { erro: 'O prazo de 30 dias para troca já passou. Fale com a gente pelo WhatsApp.' };
    const motivo = MOTIVOS.includes(s.motivo) ? s.motivo : null;
    if (!motivo) return { erro: `Conta pra gente o motivo da troca de ${it.titulo}.` };
    let nova = null;
    if (tipo === 'troca') {
      nova = it.opcoes_troca.find(o => o.id === s.nova_variante_id);
      if (!nova) return { erro: `Escolha o tamanho ou a cor nova de ${it.titulo}.` };
    }
    itens.push({
      line_id: it.id,
      titulo: it.titulo,
      variante: it.variante,
      qtd,
      valor_unit: it.valor_unit,
      tipo,
      nova_variante_id: nova ? nova.id : null,
      nova_variante: nova ? nova.titulo : null,
      motivo,
      obs: String(s.obs || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    });
  }
  return { itens };
}

export function idDoc(numero, agora = new Date()) {
  return `${PREFIXO_DOC}${numero}-${agora.getTime().toString(36)}`;
}

// Protocolo curto que a cliente vê e a equipe acha no painel
export function protocolo(id) {
  const [, resto] = id.split(':');
  const [num, ts] = resto.split('-');
  return `TP${num}-${ts.slice(-4).toUpperCase()}`;
}
