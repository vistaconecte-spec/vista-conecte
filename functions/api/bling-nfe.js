/**
 * /api/bling-nfe: notas fiscais pelo Bling.
 *
 * GET ?acao=status                    → token guardado? vence quando? escopos
 * GET ?acao=previa&data=2026-10-14    → pedidos do Bling no dia (&ate= pra intervalo) e se a
 *                                       cliente já tem nota emitida a partir da data do pedido
 * GET ?acao=diagnostico&pedido=ID     → roda todas as travas de UM pedido, sem efeito
 *                                       (ID do Bling, ou o número do pedido no Bling)
 * GET ?acao=emitir&pedido=ID&confirmar=1
 *                                     → se as travas passarem: gera a NF-e a partir do pedido
 *                                       e manda pra SEFAZ. Sem confirmar=1 é só o diagnóstico.
 *                                       &refazer=1 só vale quando a tentativa anterior falhou
 *                                       ANTES de criar a nota.
 * GET ?acao=get&caminho=/pedidos/vendas/123
 *                                     → GET cru na API do Bling, pra conferir formato. Só GET.
 *
 * Uma nota por chamada, de propósito: nota autorizada só cancela em 24h, e o lote diário vai
 * chamar isto pedido a pedido, parando no primeiro erro inesperado.
 */
import { bling, tokenValido, statusToken, json, esperar, PAUSA_MS } from '../_bling.js';
import { decidir, idDaResposta, soDigitos, lerTrava, travar, gravarTrava } from '../_bling-nfe.js';

const DATA = /^\d{4}-\d{2}-\d{2}$/;
const SHOPIFY_API = '2024-04';

function hojeSP() {
  return new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
}

async function listarNotas(env, token, desde, ate) {
  const notas = [];
  for (let pagina = 1; pagina <= 3; pagina++) {
    const q = `pagina=${pagina}&limite=100&dataEmissaoInicial=${encodeURIComponent(desde + ' 00:00:00')}&dataEmissaoFinal=${encodeURIComponent(ate + ' 23:59:59')}`;
    const d = await bling(env, `/nfe?${q}`, { token });
    const itens = (d && d.data) || [];
    notas.push(...itens);
    if (itens.length < 100) break;
    await esperar(PAUSA_MS);
  }
  return notas;
}

async function pedidoBling(env, token, ref) {
  ref = String(ref || '').trim();
  if (!/^\d+$/.test(ref)) throw Object.assign(new Error('pedido deve ser o id ou o número do Bling'), { status: 400 });
  if (ref.length >= 10) return (await bling(env, `/pedidos/vendas/${ref}`, { token })).data;
  // Número curto (ex.: 8432): procura nos últimos 45 dias.
  const ate = hojeSP();
  const de = new Date(Date.now() - 45 * 86400e3).toISOString().slice(0, 10);
  for (let pagina = 1; pagina <= 5; pagina++) {
    const d = await bling(env, `/pedidos/vendas?pagina=${pagina}&limite=100&dataInicial=${de}&dataFinal=${ate}`, { token });
    const itens = (d && d.data) || [];
    const achou = itens.find(p => String(p.numero) === ref);
    if (achou) { await esperar(PAUSA_MS); return (await bling(env, `/pedidos/vendas/${achou.id}`, { token })).data; }
    if (itens.length < 100) break;
    await esperar(PAUSA_MS);
  }
  return null;
}

async function pedidoShopify(env, orderId) {
  if (!orderId) return null;
  const fields = 'id,name,total_price,current_total_price,financial_status,cancelled_at,refunds,source_name,shipping_lines';
  const r = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API}/orders/${encodeURIComponent(orderId)}.json?fields=${fields}`, {
    headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Shopify ${r.status}`);
  return (await r.json()).order || null;
}

// Notas da mesma cliente (CPF) emitidas a partir da data do pedido, com o número do pedido
// da loja (que só vem no detalhe da nota).
async function notasDaCliente(env, token, pedido) {
  const doc = soDigitos(pedido.contato && pedido.contato.numeroDocumento);
  if (!doc) return [];
  await esperar(PAUSA_MS);
  const todas = await listarNotas(env, token, pedido.data, hojeSP());
  const dela = todas.filter(n => soDigitos(n.contato && n.contato.numeroDocumento) === doc);
  const out = [];
  for (const n of dela.slice(0, 5)) {
    await esperar(PAUSA_MS);
    let det = null;
    try { det = (await bling(env, `/nfe/${n.id}`, { token })).data; } catch { /* sem detalhe: decide pelo CPF */ }
    out.push({ id: n.id, numero: n.numero, situacao: n.situacao, dataEmissao: n.dataEmissao, numeroPedidoLoja: det ? det.numeroPedidoLoja : null });
  }
  return out;
}

async function diagnosticar(env, token, ref) {
  const pedido = await pedidoBling(env, token, ref);
  if (!pedido) return { pedido: null, decisao: decidir(null) };
  const [order, notas] = await Promise.all([pedidoShopify(env, pedido.numeroLoja), notasDaCliente(env, token, pedido)]);
  return {
    pedido,
    order,
    notas,
    decisao: decidir(pedido, order, notas),
    resumo: {
      id_bling: pedido.id, numero_bling: pedido.numero, shopify: order ? order.name : null,
      data: pedido.data, total: pedido.total, cliente: pedido.contato ? pedido.contato.nome : null,
      itens: (pedido.itens || []).length, notas_da_cliente: notas.map(n => ({ numero: n.numero, situacao: n.situacao, pedido_loja: n.numeroPedidoLoja })),
    },
  };
}

export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;
  const acao = q.get('acao') || 'status';
  try {
    if (acao === 'status') {
      return json({ secret_gravado: !!env.BLING_CLIENT_SECRET, token: await statusToken(env) });
    }

    if (acao === 'get') {
      const caminho = q.get('caminho') || '';
      if (!caminho.startsWith('/') || caminho.includes('://')) return json({ erro: 'caminho deve começar com / (ex.: /pedidos/vendas?limite=5)' }, 400);
      return json(await bling(env, caminho));
    }

    if (acao === 'previa') {
      const de = q.get('data') || hojeSP();
      const ate = q.get('ate') || de;
      if (!DATA.test(de) || !DATA.test(ate)) return json({ erro: 'data no formato AAAA-MM-DD' }, 400);
      const token = await tokenValido(env);
      const lista = [];
      for (let pagina = 1; pagina <= 5; pagina++) {
        const d = await bling(env, `/pedidos/vendas?pagina=${pagina}&limite=100&dataInicial=${de}&dataFinal=${ate}`, { token });
        const itens = (d && d.data) || [];
        lista.push(...itens);
        if (itens.length < 100) break;
        await esperar(PAUSA_MS);
      }
      await esperar(PAUSA_MS);
      const notas = await listarNotas(env, token, de, hojeSP());
      const pedidos = lista.map(p => {
        const doc = soDigitos(p.contato && p.contato.numeroDocumento);
        const nf = notas.filter(n => doc && soDigitos(n.contato && n.contato.numeroDocumento) === doc && n.dataEmissao.slice(0, 10) >= p.data);
        return {
          id: p.id, numero: p.numero, shopify_id: p.numeroLoja, data: p.data, total: p.total,
          cliente: p.contato ? p.contato.nome : null, situacao: p.situacao ? p.situacao.id : null,
          nota_da_cliente: nf.map(n => n.numero),
        };
      });
      return json({
        de, ate, total: pedidos.length,
        cliente_com_nota: pedidos.filter(p => p.nota_da_cliente.length).length,
        sem_nota: pedidos.filter(p => !p.nota_da_cliente.length).length,
        pedidos,
      });
    }

    if (acao === 'diagnostico' || acao === 'emitir') {
      const ref = q.get('pedido');
      if (!ref) return json({ erro: 'falta ?pedido=' }, 400);
      const token = await tokenValido(env);
      const d = await diagnosticar(env, token, ref);
      const saida = { decisao: d.decisao, resumo: d.resumo || null };
      if (acao === 'diagnostico' || q.get('confirmar') !== '1' || !d.decisao.emitir) {
        return json({ ...saida, emitido: false, ...(acao === 'emitir' && d.decisao.emitir ? { aviso: 'travas ok; falta &confirmar=1 pra emitir' } : {}) });
      }

      const idPedido = d.pedido.id;
      const doc = { pedido: idPedido, numero: d.pedido.numero, shopify: d.order.name, total: d.pedido.total, status: 'travado', inicio: new Date().toISOString() };
      if (!(await travar(env, idPedido, doc))) {
        const anterior = await lerTrava(env, idPedido);
        if (!(q.get('refazer') === '1' && anterior && anterior.status === 'falhou-ao-gerar')) {
          return json({ ...saida, emitido: false, erro: 'este pedido já foi processado (ou está sendo agora)', anterior });
        }
        await gravarTrava(env, idPedido, doc);
      }

      let idNota;
      try {
        await esperar(PAUSA_MS);
        idNota = idDaResposta(await bling(env, `/pedidos/vendas/${idPedido}/gerar-nfe`, { method: 'POST', token }));
        if (!idNota) throw new Error('Bling não devolveu o id da nota');
      } catch (e) {
        await gravarTrava(env, idPedido, { ...doc, status: 'falhou-ao-gerar', erro: e.message });
        return json({ ...saida, emitido: false, erro: 'falhou ao gerar a nota: ' + e.message }, 502);
      }

      if (q.get('so_gerar') === '1') {
        // Nota criada no Bling e NÃO enviada: dá pra conferir (natureza, valores, frete) e,
        // se estiver errada, apagar no Bling sem efeito fiscal. Envia com acao=enviar.
        const pend = { ...doc, status: 'gerada-aguardando-envio', nota: idNota };
        await gravarTrava(env, idPedido, pend);
        await esperar(PAUSA_MS);
        let nota = null;
        try { nota = (await bling(env, `/nfe/${idNota}`, { token })).data; } catch { /* confere no Bling */ }
        return json({ ...saida, emitido: false, gerada: true, nota: pend, conferir: nota });
      }

      return json(await enviarNota(env, token, idPedido, idNota, doc, saida));
    }

    if (acao === 'enviar') {
      // Manda pra SEFAZ uma nota gerada com so_gerar=1, depois de conferida.
      const ref = q.get('pedido');
      if (!ref || q.get('confirmar') !== '1') return json({ erro: 'precisa de ?pedido=ID_DO_BLING&confirmar=1' }, 400);
      const anterior = await lerTrava(env, ref);
      if (!anterior || anterior.status !== 'gerada-aguardando-envio' || !anterior.nota) {
        return json({ erro: 'não há nota gerada aguardando envio para este pedido', anterior }, 409);
      }
      const token = await tokenValido(env);
      const nota = (await bling(env, `/nfe/${anterior.nota}`, { token })).data;
      if (!nota || nota.situacao !== 1) return json({ erro: `a nota não está mais pendente no Bling (situação ${nota && nota.situacao})`, anterior }, 409);
      return json(await enviarNota(env, token, ref, anterior.nota, anterior, {}));
    }

    return json({ erro: 'acao desconhecida (status, previa, diagnostico, emitir, enviar, get)' }, 400);
  } catch (e) {
    return json({ erro: e.message, status: e.status || null }, e.status && e.status < 500 ? e.status : 502);
  }
}

async function enviarNota(env, token, idPedido, idNota, doc, saida) {
  try {
    await esperar(PAUSA_MS);
    await bling(env, `/nfe/${idNota}/enviar`, { method: 'POST', token });
  } catch (e) {
    // A nota existe no Bling mas não foi pra SEFAZ: NÃO tentar de novo sozinho, alguém olha.
    await gravarTrava(env, idPedido, { ...doc, status: 'gerada-nao-enviada', nota: idNota, erro: e.message });
    return { ...saida, emitido: false, nota: idNota, erro: 'nota criada mas o envio à SEFAZ falhou: ' + e.message };
  }

  await esperar(PAUSA_MS * 3);
  let nota = null;
  try { nota = (await bling(env, `/nfe/${idNota}`, { token })).data; } catch { /* confere depois */ }
  const fim = {
    ...doc, status: 'enviada', nota: idNota,
    numero_nota: nota ? nota.numero : null, situacao_nota: nota ? nota.situacao : null,
    chave: nota ? nota.chaveAcesso : null, danfe: nota ? nota.linkDanfe : null,
  };
  await gravarTrava(env, idPedido, fim);
  return { ...saida, emitido: true, nota: fim };
}
