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
 *                                       ANTES de criar a nota. ATENÇÃO: o Bling desta conta
 *                                       transmite à SEFAZ sozinho ao gerar; confirmar=1 é
 *                                       emissão de verdade.
 * GET ?acao=get&caminho=/pedidos/vendas/123
 *                                     → GET cru na API do Bling, pra conferir formato. Só GET.
 *
 * Uma nota por chamada, de propósito: nota autorizada só cancela em 24h, e o lote diário vai
 * chamar isto pedido a pedido, parando no primeiro erro inesperado.
 */
import { bling, tokenValido, statusToken, json, esperar, PAUSA_MS } from '../_bling.js';
import { decidir, idDaResposta, soDigitos, lerTrava, travar, gravarTrava, travasExistentes, completarNcmItens, pedidosComNotaRecentes, LOJA_SHOPIFY_BLING, SITUACAO_EM_ABERTO } from '../_bling-nfe.js';

const DATA = /^\d{4}-\d{2}-\d{2}$/;
const semAcentoLower = t => String(t || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const INICIO_AUTOMATICO = '2026-10-16';
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
  const fields = 'id,name,total_price,current_total_price,financial_status,cancelled_at,refunds,source_name,shipping_lines,line_items';
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

    if (acao === 'pendentes') {
      // Lista pro agendador (workers/bling-cron): pedidos em aberto da loja nos últimos
      // `dias`, com total > 0, que ainda não passaram pela emissão (sem doc bling-nfe:<id>).
      // A decisão de verdade é do acao=emitir, pedido a pedido; isto só evita bater no Bling
      // à toa com o que já foi feito.
      const dias = Math.min(parseInt(q.get('dias') || '2', 10) || 2, 15);
      const ate = hojeSP();
      // Pedido "em aberto" no Bling não quer dizer "não enviado": a maioria fica em aberto
      // depois de despachada. O automático só pega do dia em que foi ligado pra frente; os
      // atrasados (enviados sem nota) são decisão fiscal à parte, não do agendador.
      const calc = new Date(Date.now() - 3 * 3600e3 - (dias - 1) * 86400e3).toISOString().slice(0, 10);
      const de = calc < INICIO_AUTOMATICO ? INICIO_AUTOMATICO : calc;
      const token = await tokenValido(env);
      const lista = [];
      for (let pagina = 1; pagina <= 5; pagina++) {
        const d = await bling(env, `/pedidos/vendas?pagina=${pagina}&limite=100&dataInicial=${de}&dataFinal=${ate}`, { token });
        const itens = (d && d.data) || [];
        lista.push(...itens);
        if (itens.length < 100) break;
        await esperar(PAUSA_MS);
      }
      const candidatos = lista.filter(p => p.situacao && p.situacao.id === SITUACAO_EM_ABERTO && p.loja && p.loja.id === LOJA_SHOPIFY_BLING && Number(p.total) > 0);
      const feitos = await travasExistentes(env, candidatos.map(p => p.id));
      return json({
        de, ate,
        pedidos: candidatos.filter(p => !feitos.has(String(p.id))).map(p => ({ id: p.id, numero: p.numero, data: p.data, total: p.total })),
        ja_processados: candidatos.filter(p => feitos.has(String(p.id))).length,
      });
    }

    if (acao === 'reabrir') {
      // A integração do Bling ARQUIVA o pedido na Shopify quando a nota sai (16/10/2026: os 7
      // primeiros pedidos com nota sumiram da lista de abertos). Ela não quer pedido arquivado,
      // então isto reabre os que o automático emitiu e que estão arquivados SEM ter sido enviados
      // nem cancelados. Pedido enviado e arquivado pela equipe não é tocado.
      const nossos = await pedidosComNotaRecentes(env, 4);
      const desde = new Date(Date.now() - 6 * 86400e3).toISOString();
      const sh = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API}`;
      const H = { 'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' };
      const r = await fetch(`${sh}/orders.json?status=closed&fulfillment_status=unfulfilled&created_at_min=${encodeURIComponent(desde)}&limit=250&fields=id,name,closed_at,cancelled_at,fulfillment_status`, { headers: H });
      if (!r.ok) throw new Error(`Shopify ${r.status}`);
      const arquivados = ((await r.json()).orders || []).filter(o => nossos.has(o.name) && !o.cancelled_at && !o.fulfillment_status);
      const reabertos = [];
      for (const o of arquivados) {
        if (q.get('confirmar') !== '1') { reabertos.push({ pedido: o.name, previa: true }); continue; }
        const x = await fetch(`${sh}/orders/${o.id}/open.json`, { method: 'POST', headers: H, body: '{}' });
        reabertos.push({ pedido: o.name, ok: x.ok, status: x.status });
      }
      return json({ com_nota: nossos.size, arquivados: arquivados.length, reabertos });
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
        // O Bling CRIA a nota (pendente) e mesmo assim responde 400 "erros de validação"
        // quando falta dado fiscal, ex. NCM do produto (nota 007620, 14/10/2026). Então erro
        // aqui não quer dizer "nada foi criado": relê o pedido antes de liberar outra tentativa.
        let criada = null;
        try { await esperar(PAUSA_MS * 2); const p = (await bling(env, `/pedidos/vendas/${idPedido}`, { token })).data; criada = p && p.notaFiscal && p.notaFiscal.id ? p.notaFiscal.id : null; } catch { criada = 'desconhecido'; }
        if (criada && criada !== 'desconhecido') {
          // Quase sempre é item sem NCM (produto sem NCM ou item sem produto ligado no Bling):
          // completa pela tabela e manda. Se o item não está na tabela, fica pendente.
          await gravarTrava(env, idPedido, { ...doc, status: 'gerada-com-erro', nota: criada, erro: e.message });
          return json(await completarEEnviar(env, token, idPedido, criada, { ...doc, status: 'gerada-com-erro' }, saida, d.order));
        }
        if (criada) {
          await gravarTrava(env, idPedido, { ...doc, status: 'gerada-com-erro', nota: null, erro: e.message });
          return json({ ...saida, emitido: false, erro: 'o Bling recusou e não deu pra saber se criou a nota (conferir no Bling): ' + e.message }, 502);
        }
        await gravarTrava(env, idPedido, { ...doc, status: 'falhou-ao-gerar', erro: e.message });
        return json({ ...saida, emitido: false, erro: 'falhou ao gerar a nota: ' + e.message }, 502);
      }

      // A conta do Bling TRANSMITE SOZINHA toda nota que passa na validação: o gerar-nfe já
      // devolve a nota autorizada (007626, #9345, 16/10/2026). Não existe "gerar sem enviar"
      // por aqui. Só chama o /enviar quando a nota ficou pendente (situação 1).
      await esperar(PAUSA_MS * 2);
      let nota = null;
      try { nota = (await bling(env, `/nfe/${idNota}`, { token })).data; } catch { /* confere abaixo */ }
      if (nota && nota.situacao === 1) return json(await completarEEnviar(env, token, idPedido, idNota, doc, saida, d.order));
      return json(await registrarNota(env, idPedido, idNota, doc, saida, nota));
    }

    if (acao === 'enviar') {
      // Manda pra SEFAZ uma nota que ficou PENDENTE no Bling (ex.: criada sem NCM e corrigida
      // à mão depois). Só aceita nota ainda pendente.
      const ref = q.get('pedido');
      if (!ref || q.get('confirmar') !== '1') return json({ erro: 'precisa de ?pedido=ID_DO_BLING&confirmar=1' }, 400);
      const anterior = await lerTrava(env, ref);
      if (!anterior || !anterior.nota || !['gerada-aguardando-envio', 'gerada-com-erro'].includes(anterior.status)) {
        return json({ erro: 'não há nota pendente registrada para este pedido', anterior }, 409);
      }
      const token = await tokenValido(env);
      const pedido = (await bling(env, `/pedidos/vendas/${ref}`, { token })).data;
      const order = await pedidoShopify(env, pedido && pedido.numeroLoja);
      return json(await completarEEnviar(env, token, ref, anterior.nota, anterior, {}, order));
    }

    return json({ erro: 'acao desconhecida (status, previa, diagnostico, emitir, enviar, get)' }, 400);
  } catch (e) {
    return json({ erro: e.message, status: e.status || null }, e.status && e.status < 500 ? e.status : 502);
  }
}

// Nota PENDENTE no Bling (situação 1): confere a Shopify de novo, completa o NCM dos itens
// que vieram sem (tabela em _bling-nfe.js), grava a nota e manda pra SEFAZ. Se algum item não
// está na tabela ou a Shopify não confere, a nota fica pendente com o motivo.
async function completarEEnviar(env, token, idPedido, idNota, doc, saida, order) {
  await esperar(PAUSA_MS);
  const nota = (await bling(env, `/nfe/${idNota}`, { token })).data;
  if (!nota || nota.situacao !== 1) return registrarNota(env, idPedido, idNota, doc, saida, nota);

  const problemas = [];
  if (!order) problemas.push('pedido não encontrado na Shopify');
  else {
    if (order.cancelled_at) problemas.push('pedido cancelado na Shopify');
    if (order.financial_status !== 'paid') problemas.push(`Shopify não está como pago (${order.financial_status})`);
    if ((order.refunds || []).length) problemas.push('pedido tem reembolso na Shopify');
    const diff = Math.abs(Math.round(parseFloat(order.current_total_price ?? order.total_price) * 100) - Math.round(parseFloat(nota.valorNota) * 100));
    if (diff > 1) problemas.push(`valor da nota ${nota.valorNota} diferente da Shopify ${order.current_total_price ?? order.total_price}`);
  }
  const { itens, faltando } = completarNcmItens(nota.itens);
  if (faltando.length) problemas.push('sem NCM na tabela: ' + faltando.join(', '));
  if (problemas.length) {
    const pend = { ...doc, status: 'gerada-com-erro', nota: idNota, numero_nota: nota.numero, erro: problemas.join('; ') };
    await gravarTrava(env, idPedido, pend);
    return { ...saida, emitido: false, nota: pend, erro: `nota ${nota.numero} ficou PENDENTE no Bling: ${problemas.join('; ')}` };
  }

  const mudou = itens.some((it, i) => it.classificacaoFiscal !== (nota.itens[i] || {}).classificacaoFiscal);
  if (mudou) {
    // Item sem produto no Bling (variação da Shopify sem SKU, nunca cadastrada lá): o PUT exige
    // um código. Usa o SKU da Shopify ou, sem SKU, o id da variação. E o PUT recalcula o total
    // pelos itens, então frete e desconto vão explícitos pra fechar com as parcelas.
    const linhas = (order && order.line_items) || [];
    const chave = t => semAcentoLower(t).replace(/\s+/g, ' ').trim();
    const itensCod = itens.map(it => {
      if (it.codigo) return it;
      const l = linhas.find(x => chave(`${x.title} - ${x.variant_title || ''}`) === chave(it.descricao)) || linhas.find(x => chave(it.descricao).startsWith(chave(x.title)));
      return { ...it, codigo: l ? (l.sku || `SHP${l.variant_id}`) : `VC${idPedido}` };
    });
    const somaItens = itensCod.reduce((t, it) => t + Number(it.valor) * Number(it.quantidade), 0);
    const desconto = Math.round((somaItens + Number(nota.valorFrete || 0) - Number(nota.valorNota)) * 100) / 100;
    const corpo = { ...nota, itens: itensCod, transporte: { ...(nota.transporte || {}), frete: Number(nota.valorFrete || 0) } };
    // Desconto vai como número na raiz (testado em 16/10/2026, nota 007634: objeto {valor,unidade}
    // é recusado com 'Total das parcelas difere do total da nota').
    if (desconto > 0) corpo.desconto = desconto;
    for (const k of ['id', 'xml', 'linkDanfe', 'linkPDF', 'chaveAcesso', 'situacao']) delete corpo[k];
    try {
      await esperar(PAUSA_MS);
      await bling(env, `/nfe/${idNota}`, { method: 'PUT', body: corpo, token });
    } catch (e) {
      const pend = { ...doc, status: 'gerada-com-erro', nota: idNota, numero_nota: nota.numero, erro: 'não consegui gravar o NCM na nota: ' + e.message };
      await gravarTrava(env, idPedido, pend);
      return { ...saida, emitido: false, nota: pend, erro: `nota ${nota.numero} ficou PENDENTE: ` + pend.erro };
    }
  }
  return enviarNota(env, token, idPedido, idNota, doc, saida);
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
  return registrarNota(env, idPedido, idNota, doc, saida, nota);
}

// Situação da nota no Bling: 5 autorizada, 6 emitida DANFE. Qualquer outra fica pra conferir.
async function registrarNota(env, idPedido, idNota, doc, saida, nota) {
  const autorizada = !!nota && (nota.situacao === 5 || nota.situacao === 6);
  const fim = {
    ...doc, status: autorizada ? 'enviada' : 'conferir-situacao', nota: idNota,
    numero_nota: nota ? nota.numero : null, situacao_nota: nota ? nota.situacao : null,
    chave: nota ? nota.chaveAcesso : null, danfe: nota ? nota.linkDanfe : null,
  };
  await gravarTrava(env, idPedido, fim);
  return { ...saida, emitido: autorizada, nota: fim };
}
