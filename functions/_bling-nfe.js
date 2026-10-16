// Emissão de NF-e a partir do pedido de venda do Bling (14/10/2026).
//
// NOTA AUTORIZADA SÓ CANCELA EM 24H. Errar aqui é imposto sobre venda que não existiu, nota
// em dobro pra mesma cliente, ou valor diferente do que ela pagou. Por isso a decisão de
// emitir (decidir) é uma função pura, testada em tests/bling-nfe.test.mjs, e só diz "pode"
// quando TODAS as travas passam:
//
//  1. o pedido do Bling veio da loja Shopify e ainda está "em aberto";
//  2. o Bling não tem nota ligada a ele (notaFiscal.id);
//  3. não existe nota pra mesma cliente (CPF) emitida a partir da data do pedido. As notas
//     feitas à mão NÃO ficam ligadas ao pedido no Bling (achado de 14/10/2026), então o
//     vínculo do item 2 sozinho deixaria passar duplicata;
//  4. na Shopify o pedido existe, está pago, não foi cancelado nem reembolsado, é da loja
//     online (não é rascunho da Marcelly nem TikTok) e não é retirada na loja;
//  5. o total do Bling bate com o da Shopify (diferença de até 1 centavo).
//
// Qualquer dúvida vira "não emitir" com o motivo, pra alguém olhar. Nunca o contrário.

import { SB_URL } from './_bling.js';

export const LOJA_SHOPIFY_BLING = 205004799;
export const SITUACAO_EM_ABERTO = 6;
// Nota que não conta como "já existe": cancelada (2) e denegada (9). Rejeitada (4) conta,
// porque está pendente de correção e uma nova duplicaria quando a velha fosse corrigida.
const NOTA_NAO_CONTA = new Set([2, 9]);

export const soDigitos = s => String(s || '').replace(/\D/g, '');

const centavos = v => Math.round(parseFloat(v || 0) * 100);

const ehRetirada = order => (order.shipping_lines || []).some(l => /loja conecte|retirada|retirar/i.test(`${l.title || ''} ${l.code || ''}`));

/**
 * @param pedido  detalhe do pedido de venda no Bling (GET /pedidos/vendas/{id} .data)
 * @param order   pedido da Shopify (REST) ou null se não achou
 * @param notasCliente  notas do Bling da mesma cliente emitidas a partir da data do pedido,
 *                      cada uma { id, numero, situacao, dataEmissao, numeroPedidoLoja? }
 * @returns { emitir: boolean, motivos: string[] }
 */
export function decidir(pedido, order, notasCliente = []) {
  const motivos = [];
  if (!pedido) return { emitir: false, motivos: ['pedido não encontrado no Bling'] };

  if (!pedido.loja || pedido.loja.id !== LOJA_SHOPIFY_BLING) motivos.push('pedido não veio da loja Shopify');
  const sit = pedido.situacao && pedido.situacao.id;
  if (sit !== SITUACAO_EM_ABERTO) motivos.push(`pedido não está em aberto no Bling (situação ${sit})`);
  if (pedido.notaFiscal && pedido.notaFiscal.id) motivos.push(`Bling já tem nota ligada a este pedido (id ${pedido.notaFiscal.id})`);
  if (!(centavos(pedido.total) > 0)) motivos.push('total do pedido é zero');
  if (!soDigitos(pedido.contato && pedido.contato.numeroDocumento)) motivos.push('cliente sem CPF/CNPJ no Bling');

  const valendo = notasCliente.filter(n => !NOTA_NAO_CONTA.has(n.situacao));
  const mesmaLoja = valendo.filter(n => n.numeroPedidoLoja && String(n.numeroPedidoLoja) === String(pedido.numeroLoja));
  if (mesmaLoja.length) motivos.push(`já existe nota deste pedido: ${mesmaLoja.map(n => n.numero).join(', ')}`);
  else if (valendo.length) motivos.push(`já existe nota pra esta cliente depois da data do pedido: ${valendo.map(n => n.numero).join(', ')} (conferir à mão)`);

  if (!order) {
    motivos.push('pedido não encontrado na Shopify');
  } else {
    if (String(order.id) !== String(pedido.numeroLoja)) motivos.push('pedido da Shopify não é o mesmo do Bling');
    if (order.cancelled_at) motivos.push('pedido cancelado na Shopify');
    if (order.financial_status !== 'paid') motivos.push(`Shopify não está como pago (${order.financial_status})`);
    if ((order.refunds || []).length) motivos.push('pedido tem reembolso na Shopify');
    if (order.source_name && order.source_name !== 'web') motivos.push(`pedido não é da loja online (${order.source_name})`);
    if (ehRetirada(order)) motivos.push('retirada na loja');
    const diff = Math.abs(centavos(order.current_total_price ?? order.total_price) - centavos(pedido.total));
    if (diff > 1) motivos.push(`total diferente: Bling ${pedido.total} x Shopify ${order.current_total_price ?? order.total_price}`);
  }

  return { emitir: motivos.length === 0, motivos };
}

// ── NCM pelo nome da peça ───────────────────────────────────────────────────
// Tabela fechada com ela em 14/10/2026 (tudo malha, cap. 61; viscolycra e viscose são fibra
// artificial, moletom e camiseta são algodão, canelado e sherpa são poliéster; conjunto de
// tecidos misturados fica com a fibra que predomina, 6104.22.00). É a mesma regra que gravou
// o NCM nos produtos; aqui ela cobre o item que chega sem produto ligado no Bling (variação
// nova criada pela Shopify, ex. Macacão Amplo Marsala G no #9349, 16/10/2026).
// null = não sei o tecido: a nota NÃO sai, alguém decide.
const semAcento = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function ncmPorNome(nome) {
  const n = semAcento(nome);
  const tem = (...ws) => ws.some(w => n.includes(w));
  if (tem('embalagem', 'reenvio', 'reembolso', 'bojo')) return null;
  if (tem('coturno', 'bota', 'sandalia', 'flat')) return null;
  if (tem('top ') || n.startsWith('top')) return null;
  if (tem('wide', 'conjunto longo', 'conjunto amplo longo', 'vestido midi', 'vestido aiga', 'forrado', 'xadrez', 'cropped frente unica', 'cropped meia manga')) return null;
  let conj = n.startsWith('conjunto') || n.includes(' + ') || (n.includes(' com ') && tem('saia', 'cropped', 'moletom', 'blusa') && !n.startsWith('blusa'));
  if (n.startsWith('blusa com punho') || n.startsWith('blusa gola')) conj = false;
  if (conj) {
    if (tem('peace', 'boho')) return '6104.29.00';
    const algodao = tem('moletom', 'moletinho', 'jogger', 'cozy', 'dream', 'lazy', 'mood', 'chill', 'canguru', 'oversized', 'camiseta', 'regata', 'bolso frontal', 'pantalona com blusa', 'pantalona + blusa', 'cropped vermelho');
    const canelado = tem('canelad', 'flare', 'mini saia', 'saia midi', 'gola efeito', 'punho dedinho');
    if (algodao) return '6104.22.00';
    if (canelado && !tem('pantalona')) return '6104.23.00';
    return null;
  }
  if (tem('macacao', 'macaquinho amplo')) return '6114.30.00';
  if (tem('macaquinho ruel')) return '6114.20.00';
  if (tem('vestido amplo', 'vestido frente unica')) return '6104.44.00';
  if (tem('saia')) return '6104.53.00';
  if (tem('flare')) return '6104.63.00';
  if (tem('moletom', 'bolso frontal', 'saruel', 'short')) {
    if (tem('calca', 'pantalona', 'short', 'saruel')) return '6104.62.00';
    return '6110.20.00';
  }
  if (tem('canguru')) return '6110.20.00';
  if (tem('peace') && tem('calca')) return '6104.69.00';
  if (tem('pantalona')) return '6104.69.00';
  if (tem('blusa', 'cropped canelado')) return '6106.20.00';
  if (tem('carneirinho', 'sherpa', 'casaco bear', 'pelego')) {
    if (tem('pelego') && tem('moletom')) return '6110.20.00';
    return '6102.30.00';
  }
  if (tem('oversized', 'camiseta', 'regata')) return '6109.10.00';
  return null;
}

// Itens da nota sem NCM recebem o da tabela. Devolve { itens, faltando } sem mexer no original.
export function completarNcmItens(itens) {
  const faltando = [];
  const novos = (itens || []).map(it => {
    if (it.classificacaoFiscal) return it;
    const ncm = ncmPorNome(it.descricao);
    if (!ncm) { faltando.push(it.descricao); return it; }
    return { ...it, classificacaoFiscal: ncm };
  });
  return { itens: novos, faltando };
}

// O Bling às vezes responde { data: { id } }, às vezes { data: [{ id }] }.
export function idDaResposta(r) {
  const d = r && r.data;
  if (!d) return null;
  if (Array.isArray(d)) return d[0] && d[0].id ? d[0].id : null;
  return d.id || d.idNotaFiscal || null;
}

// ── trava por pedido no Supabase ────────────────────────────────────────────
// Insert sem merge: o segundo clique (ou a rotina rodando junto com alguém) leva 409 e
// desiste. Só quem ganhou a trava chama o gerar-nfe.

const docId = idPedido => `bling-nfe:${idPedido}`;

function sbHeaders(env, extra) {
  const k = env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json', ...(extra || {}) };
}

export async function lerTrava(env, idPedido) {
  const r = await fetch(`${SB_URL}/rest/v1/vc_modelos?id=eq.${encodeURIComponent(docId(idPedido))}&select=dados`, { headers: sbHeaders(env) });
  if (!r.ok) throw new Error(`Supabase get ${r.status}`);
  const rows = await r.json();
  return rows[0] ? rows[0].dados : null;
}

export async function travar(env, idPedido, dados) {
  const r = await fetch(`${SB_URL}/rest/v1/vc_modelos`, {
    method: 'POST', headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ id: docId(idPedido), dados }),
  });
  if (r.status === 409) return false;
  if (!r.ok) throw new Error(`Supabase insert ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return true;
}

// Quais destes pedidos já têm doc de emissão (uma consulta só, em vez de uma por pedido).
export async function travasExistentes(env, ids) {
  if (!ids.length) return new Set();
  const lista = ids.map(id => `"${docId(id)}"`).join(',');
  const r = await fetch(`${SB_URL}/rest/v1/vc_modelos?id=in.(${encodeURIComponent(lista)})&select=id`, { headers: sbHeaders(env) });
  if (!r.ok) throw new Error(`Supabase list ${r.status}`);
  return new Set((await r.json()).map(x => x.id.replace('bling-nfe:', '')));
}

// Resumo de cada rodada do agendador: doc bling-nfe-rodada:<AAAA-MM-DD> com a lista do dia.
export async function gravarRodada(env, dia, rodada) {
  const id = `bling-nfe-rodada:${dia}`;
  const r0 = await fetch(`${SB_URL}/rest/v1/vc_modelos?id=eq.${encodeURIComponent(id)}&select=dados`, { headers: sbHeaders(env) });
  const rows = r0.ok ? await r0.json() : [];
  const atual = rows[0] ? rows[0].dados : { dia, rodadas: [] };
  atual.rodadas = [...(atual.rodadas || []), rodada].slice(-10);
  const r = await fetch(`${SB_URL}/rest/v1/vc_modelos?on_conflict=id`, {
    method: 'POST', headers: sbHeaders(env, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ id, dados: atual }),
  });
  if (!r.ok) throw new Error(`Supabase upsert ${r.status}`);
}

export async function lerRodadas(env, dias = 7) {
  const r = await fetch(`${SB_URL}/rest/v1/vc_modelos?id=like.${encodeURIComponent('bling-nfe-rodada:*')}&select=dados&order=id.desc&limit=${dias}`, { headers: sbHeaders(env) });
  if (!r.ok) throw new Error(`Supabase list ${r.status}`);
  return (await r.json()).map(x => x.dados);
}

export async function gravarTrava(env, idPedido, dados) {
  const r = await fetch(`${SB_URL}/rest/v1/vc_modelos?id=eq.${encodeURIComponent(docId(idPedido))}`, {
    method: 'PATCH', headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ dados: { ...dados, atualizado: new Date().toISOString() } }),
  });
  if (!r.ok) throw new Error(`Supabase patch ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
