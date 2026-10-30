// /api/casos — aba CASOS: assistente da Marcelly para resolver os casos do Wati.
// Regras e prompt em ../_casos.js (lá está o porquê de cada decisão).
//
// O laço do assistente roda NO NAVEGADOR: cada chamada aqui faz no máximo UMA ida à API da
// Anthropic ou UMA ferramenta. Assim cada requisição fica longe dos 10 ms de CPU e dos 50
// subrequests do plano grátis da Cloudflare, e a ferramenta de produção (estoque real, levas)
// roda na tela, onde esse dado já está carregado.
//
//   GET  /api/casos?estado=1        → { so_leitura, aprovacoes_pendentes }   (barato, sem IA)
//   GET  /api/casos?aprovacoes=1    → lista de aprovações (fila da Bárbara)
//   GET  /api/casos?abertos=1       → casos abertos do CRM da Vi (botão "Casos em aberto", sem IA)
//   POST { acao:'assistente', messages }        → resposta do modelo (content, stop_reason)
//   POST { acao:'ferramenta', nome, input }     → resultado de uma ferramenta do servidor
//   POST { acao:'executar', tipo, ... }         → botão confirmado (em só leitura só simula)
//   POST { acao:'decidir', id, decisao, nota }  → Bárbara aprova/recusa
//   POST { acao:'feito', id, nota }             → aprovação cumprida (conta como ação do caso)
//
// Secrets: ANTHROPIC_API_KEY, CASOS_AVISO_WA (número da Bárbara para o aviso), CASOS_SO_LEITURA (=1 trava os botões),
// SUPABASE_SERVICE_ROLE_KEY, SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN, MP_ACCESS_TOKEN, META_ACCESS_TOKEN (ou WA_TOKEN).
import {
  soLeitura, MODELO, DOC_LOG, TEMPLATE_CONTINUIDADE, TEMPLATE_ALERTA, CATEGORIAS_DINHEIRO,
  SISTEMA, FERRAMENTAS, FERRAMENTAS_SERVIDOR, problemasDoTexto, prometeDinheiro, janelaAberta, revisarResposta,
  semResposta, promessasDaEquipe, pagoPorItem, numerosDePedido, prazoDoPedido, logVazio, podeFechar, podeFecharPelaConversa, casoDeDinheiro, aprovacaoLiberada, novoId,
  primeiroNome, finalTel, resumoDoCaso, conversaParaAssistente, hojeTexto, brt, metaParaMsg,
} from '../_casos.js';
import { variantes, mesclar, enviarTextoDaLoja, enviarArquivoDaLoja, enviarModeloDaLoja } from '../_whatsapp.js';

const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
const API_SHOPIFY = '2024-04';
const ARQUIVO_MAX = 5 * 1024 * 1024;

const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

// ── Supabase ────────────────────────────────────────────────────────────────────
// Duas chaves, cada uma onde tem permissão: as tabelas do Wati (wati_*) só abrem para a service
// role; o vc_modelos só para a chave pública (anon), a mesma do main.js. A service key toma 403
// no vc_modelos (visto em 17/09/2026 e de novo aqui em 19/10/2026).
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhja3pzYmx3eWFibWh6Ympkamd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNTEyOTIsImV4cCI6MjA5NDcyNzI5Mn0.guif8jtidWmfqykhgDgPJiaRbWLoEEDMp1usTlAs1dQ';
function sb(env, painel = false) {
  const k = painel ? (env.SUPABASE_ANON_KEY || SB_ANON) : env.SUPABASE_SERVICE_ROLE_KEY;
  const H = extra => ({ apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json', ...(extra || {}) });
  return {
    async get(caminho) {
      const r = await fetch(`${SB_URL}/rest/v1/${caminho}`, { headers: H() });
      if (!r.ok) throw new Error(`Supabase ${r.status} em ${caminho.split('?')[0]}`);
      return r.json();
    },
    async send(metodo, caminho, corpo, prefer = 'return=representation') {
      const r = await fetch(`${SB_URL}/rest/v1/${caminho}`, { method: metodo, headers: H({ Prefer: prefer }), body: JSON.stringify(corpo) });
      if (!r.ok) throw new Error(`Supabase ${metodo} ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const t = await r.text();
      return t ? JSON.parse(t) : [];
    },
  };
}

// Linha do vc_modelos lida junto com o carimbo, para gravar só se ninguém mexeu no meio
// (mesma trava da baixa de estoque e das listas do SAC).
async function lerDoc(env, id) {
  const db = sb(env, true);
  const rows = await db.get(`vc_modelos?id=eq.${encodeURIComponent(id)}&select=dados,updated_at`);
  return rows[0] || null;
}

// Aplica `mudar(dados)` com PATCH condicional por updated_at; se a linha mudou, relê e refaz.
async function mudarDoc(env, id, mudar, vazio) {
  const db = sb(env, true);
  for (let volta = 0; volta < 4; volta++) {
    const atual = await lerDoc(env, id);
    if (!atual) {
      const dados = vazio();
      mudar(dados);
      try { await db.send('POST', 'vc_modelos', { id, dados }, 'return=minimal'); return dados; }
      catch (e) { if (!/409/.test(e.message)) throw e; continue; }
    }
    const dados = atual.dados || vazio();
    mudar(dados);
    const rows = await db.send('PATCH', `vc_modelos?id=eq.${encodeURIComponent(id)}&updated_at=eq.${encodeURIComponent(atual.updated_at)}&select=id`, { dados });
    if (rows.length) return dados;
  }
  throw new Error('a linha ' + id + ' mudou 4 vezes seguidas, tente de novo');
}

async function lerLog(env) {
  const d = await lerDoc(env, DOC_LOG);
  const l = (d && d.dados) || logVazio();
  l.acoes = l.acoes || []; l.aprovacoes = l.aprovacoes || [];
  return l;
}

// ── Shopify e Mercado Pago ──────────────────────────────────────────────────────
const shop = (env, caminho, init = {}) => fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${API_SHOPIFY}/${caminho}`, {
  ...init, headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
});

const CAMPOS_PEDIDO = 'id,name,created_at,financial_status,fulfillment_status,cancelled_at,total_price,subtotal_price,line_items,shipping_lines,fulfillments,note,tags,refunds,payment_gateway_names';

async function pedidoBruto(env, numero) {
  const n = String(numero || '').replace(/\D/g, '');
  if (!n) return null;
  const r = await shop(env, `orders.json?name=${encodeURIComponent('#' + n)}&status=any&fields=${CAMPOS_PEDIDO}`);
  if (!r.ok) throw new Error('Shopify ' + r.status);
  return ((await r.json()).orders || [])[0] || null;
}

// O pagamento do MP pela Shopify guarda a referência em receipt.payment_id, e o MP usa a mesma
// como external_reference: é por ela que se descobre se um estorno saiu de verdade.
async function pagamentoMP(env, ref) {
  if (!ref || !env.MP_ACCESS_TOKEN) return null;
  const r = await fetch(`https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(ref)}&limit=5`,
    { headers: { Authorization: 'Bearer ' + env.MP_ACCESS_TOKEN } });
  if (!r.ok) return { erro: 'Mercado Pago ' + r.status };
  const p = ((await r.json()).results || [])[0];
  if (!p) return { achado: false };
  return { achado: true, status: p.status, detalhe: p.status_detail, valor: p.transaction_amount,
    devolvido: p.transaction_amount_refunded || 0, meio: p.payment_type_id, parcelas: p.installments,
    estornos: (p.refunds || []).map(x => ({ em: x.date_created, valor: x.amount, status: x.status })) };
}

async function buscarPedido(env, numero, agora = Date.now()) {
  const o = await pedidoBruto(env, numero);
  if (!o) return { encontrado: false, numero };
  let pagoEm = null, ref = null;
  try {
    const t = await shop(env, `orders/${o.id}/transactions.json`);
    if (t.ok) {
      const venda = ((await t.json()).transactions || []).find(x => (x.kind === 'sale' || x.kind === 'capture') && x.status === 'success');
      if (venda) { pagoEm = venda.processed_at || venda.created_at; ref = venda.receipt && venda.receipt.payment_id; }
    }
  } catch (_) {}
  const mp = await pagamentoMP(env, ref).catch(() => null);
  const estornosShopify = (o.refunds || []).map(r => ({ em: r.created_at,
    valor: (r.transactions || []).reduce((s, x) => s + (parseFloat(x.amount) || 0), 0) }));
  return {
    encontrado: true, hoje: hojeTexto(agora), numero: o.name, criado_em: o.created_at,
    pagamento: o.financial_status, meio: (o.payment_gateway_names || []).join(', ') || null,
    cancelado_em: o.cancelled_at, total: o.total_price, pecas: o.subtotal_price,
    itens: (o.line_items || []).map(i => `${i.quantity}x ${i.title}${i.variant_title ? ' (' + i.variant_title + ')' : ''}`),
    pago_por_item: (o.line_items || []).map(pagoPorItem),
    frete: (o.shipping_lines || []).map(s => `${s.title} R$ ${s.price}`),
    envio: o.fulfillment_status || 'não enviado',
    etiquetas: (o.fulfillments || []).map(f => ({ em: f.created_at, transportadora: f.tracking_company, rastreio: f.tracking_number })),
    observacao: String(o.note || '').slice(0, 500), tags: o.tags || '',
    estornos_shopify: estornosShopify, mercado_pago: mp,
    prazo: o.financial_status === 'paid' || o.financial_status === 'partially_refunded'
      ? prazoDoPedido(pagoEm || o.created_at, agora, ((o.fulfillments || [])[0] || {}).created_at || null) : null,
    aviso: 'A data de etiqueta é a de quando a etiqueta foi gerada, não a da coleta.',
  };
}

// ── Ferramentas do servidor ─────────────────────────────────────────────────────
async function pendenciasDoDia(env, agora = Date.now()) {
  const db = sb(env);
  const desde = new Date(agora - 48 * 3600e3).toISOString();
  const [casos, msgs, log] = await Promise.all([
    db.get('wati_sac_casos?status=eq.aberto&order=criado_at.asc&limit=80&select=id,wa_id,nome,tipo,resumo,pedido,status,criado_at,atualizado_at,responsavel'),
    db.get(`wati_ia_mensagens?created_at=gte.${encodeURIComponent(desde)}&select=wa_id,role,texto,created_at&order=created_at.desc&limit=1500`),
    lerLog(env),
  ]);
  const comCaso = new Set(casos.map(c => c.wa_id));
  // Confere na conversa do WhatsApp quem parece sem resposta: o histórico da Vi não tem documento nem
  // imagem que a equipe mandou, e a cliente apareceria esperando quando a etiqueta já tinha ido.
  const candidatos = semResposta(msgs, { agora }).slice(0, 12);
  const conferidos = await Promise.all(candidatos.map(async e => {
    const w = await conversaWhatsapp(env, e.wa_id, 10);
    if (!w) return e;
    return semResposta(w.map(m => ({ ...m, wa_id: e.wa_id })), { agora })[0] || null;
  }));
  const esperando = conferidos.filter(Boolean);
  let nomes = {};
  if (esperando.length) {
    const lista = esperando.slice(0, 40).map(e => e.wa_id).join(',');
    try {
      (await db.get(`wati_ia_sessions?wa_id=in.(${lista})&select=wa_id,nome,status`))
        .forEach(s => { nomes[s.wa_id] = s; });
    } catch (_) {}
  }
  return {
    hoje: hojeTexto(agora), agora_brt: brt(agora),
    casos_abertos: casos.map(c => {
      const p = promessasDaEquipe(msgs.filter(m => m.wa_id === c.wa_id), { agora });
      return p.length ? { ...resumoDoCaso(c, agora), promessas_da_equipe: p } : resumoDoCaso(c, agora);
    }),
    sem_resposta: esperando.slice(0, 40).map(e => ({ ...e, cliente: primeiroNome(nomes[e.wa_id] && nomes[e.wa_id].nome),
      final_tel: finalTel(e.wa_id), tem_caso_aberto: comCaso.has(e.wa_id), promessas_da_equipe: promessasDaEquipe(msgs.filter(m => m.wa_id === e.wa_id), { agora }), status_wati: (nomes[e.wa_id] || {}).status || null })),
    aguardando_barbara: log.aprovacoes.filter(a => a.status === 'pendente' || a.status === 'aprovado')
      .map(a => ({ id: a.id, caso_id: a.caso_id, cliente: a.cliente, pedido: a.pedido, categoria: a.categoria, valor: a.valor, status: a.status })),
  };
}

async function abrirCaso(env, { caso_id, wa_id, pedido }, agora = Date.now()) {
  const db = sb(env);
  let caso = null;
  if (caso_id) caso = (await db.get(`wati_sac_casos?id=eq.${Number(caso_id)}&select=*`))[0] || null;
  else if (wa_id) caso = (await db.get(`wati_sac_casos?wa_id=eq.${String(wa_id).replace(/\D/g, '')}&order=criado_at.desc&limit=1&select=*`))[0] || null;
  else if (pedido) {
    const n = String(pedido).replace(/\D/g, '');
    caso = (await db.get(`wati_sac_casos?pedido=ilike.*${n}*&order=criado_at.desc&limit=1&select=*`))[0] || null;
  }
  const wa = (caso && caso.wa_id) || String(wa_id || '').replace(/\D/g, '');
  if (!caso && !wa && !pedido) return { encontrado: false, motivo: 'nada para buscar' };
  // Conversa do WhatsApp (tem documento, foto, áudio e template); o histórico da Vi sozinho só entra se ela falhar.
  const doZap = wa ? await conversaWhatsapp(env, wa, 60) : null;
  const msgs = doZap || (wa ? (await db.get(`wati_ia_mensagens?wa_id=eq.${wa}&order=created_at.desc&limit=60&select=role,texto,created_at`)).reverse() : []);
  const daCliente = msgs.filter(m => m.role === 'user').map(m => m.texto).join('\n');
  const numeros = numerosDePedido(pedido || (caso && caso.pedido), caso && caso.resumo, daCliente).slice(0, 2);
  const pedidos = [];
  for (const n of numeros) { try { pedidos.push(await buscarPedido(env, n, agora)); } catch (e) { pedidos.push({ numero: n, erro: e.message }); } }
  const log = await lerLog(env);
  const id = caso && caso.id;
  return {
    hoje: hojeTexto(agora), agora_brt: brt(agora),
    caso: caso ? { ...resumoDoCaso(caso, agora), resumo: String(caso.resumo || '').slice(0, 1500) } : null,
    aviso_caso: caso ? null : 'sem caso no CRM para este contato; se a Marcelly agir, o painel abre um',
    wa_id: wa || null, final_tel: finalTel(wa),
    janela_24h: janelaAberta(msgs, agora),
    conversa_fonte: doZap ? 'WhatsApp (completa, com documentos e imagens)' : 'histórico da Vi (só texto; documento e imagem enviados podem faltar)',
    conversa: conversaParaAssistente(msgs),
    promessas_da_equipe: promessasDaEquipe(msgs, { agora }),
    pedidos,
    feito_pelo_painel: id ? log.acoes.filter(a => Number(a.caso_id) === Number(id)).map(a => ({ tipo: a.tipo, em: a.em, texto: String(a.texto || '').slice(0, 200) })) : [],
    aprovacoes: id ? log.aprovacoes.filter(a => Number(a.caso_id) === Number(id)).map(a => ({ categoria: a.categoria, valor: a.valor, status: a.status, nota: a.nota || null })) : [],
    pode_fechar: id ? podeFechar(id, log) : { ok: false, motivo: 'sem caso' },
  };
}

async function ferramenta(env, nome, input) {
  if (nome === 'pendencias_do_dia') return pendenciasDoDia(env);
  if (nome === 'abrir_caso') return abrirCaso(env, input || {});
  if (nome === 'buscar_pedido') return buscarPedido(env, (input || {}).numero);
  throw new Error('ferramenta desconhecida: ' + nome);
}

// ── Assistente (uma ida à Anthropic por chamada) ────────────────────────────────
async function assistente(env, messages) {
  if (!env.ANTHROPIC_API_KEY) return J({ erro: 'Falta a chave da API (ANTHROPIC_API_KEY) no Cloudflare. A Bárbara precisa colar a chave.' }, 503);
  if (!Array.isArray(messages) || !messages.length) return J({ erro: 'conversa vazia' }, 400);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODELO, max_tokens: 8000,
      system: SISTEMA, tools: FERRAMENTAS, messages,
      cache_control: { type: 'ephemeral' },   // a conversa cresce a cada volta; o começo vem do cache
      output_config: { effort: 'medium' },
    }),
  });
  const corpo = await r.json().catch(() => null);
  if (!r.ok) return J({ erro: 'Anthropic ' + r.status + ': ' + ((corpo && corpo.error && corpo.error.message) || '') }, 502);
  return J({ content: corpo.content, stop_reason: corpo.stop_reason, usage: corpo.usage, revisao: revisarResposta(corpo.content) });
}

// ── WhatsApp (pela Meta desde 26/10/2026; antes pelo Wati) ───────────────────────────────
// O que chegou e saiu pela Meta (wa_mensagens) junto com o histórico da Vi, nas duas grafias do número.
// Duas leituras por conversa: a lista de pendências confere até 12 de uma vez, longe dos 50 subrequests.
async function conversaWhatsapp(env, wa, limite) {
  if (!/^\d+$/.test(String(wa || ''))) return null;
  try {
    const db = sb(env);
    const vs = variantes(wa).join(',');
    const [daMeta, daVi] = await Promise.all([
      db.get(`wa_mensagens?telefone=in.(${vs})&or=(texto.not.is.null,midia_id.not.is.null)&select=wamid,direcao,tipo,texto,midia_id,midia_mime,status,erro,enviada_em,recebida_em,origem&order=recebida_em.desc&limit=${limite}`),
      db.get(`wati_ia_mensagens?wa_id=in.(${vs})&select=msg_id,role,texto,created_at&order=created_at.desc&limit=${limite}`),
    ]);
    // Lista vazia vira null: aí entra o histórico da Vi, em vez de concluir que a janela fechou.
    const msgs = mesclar(daMeta, daVi).map(metaParaMsg).filter(Boolean).slice(-limite);
    return msgs.length ? msgs : null;
  } catch (_) { return null; }
}

// Os envios devolvem { erro, detalhe } em vez de lançar; aqui vira erro do botão, como era com o Wati.
function conferirEnvio(r) {
  if (r && r.erro) throw new Error('A Meta não aceitou: ' + (r.detalhe || r.erro));
  return r;
}

// ── Botões ──────────────────────────────────────────────────────────────────────
const ehNum = v => v !== null && v !== undefined && v !== '' && !isNaN(Number(v));

async function executar(env, b, agora = Date.now()) {
  const db = sb(env);
  const tipo = b.tipo;
  const casoId = ehNum(b.caso_id) ? Number(b.caso_id) : null;
  const log = await lerLog(env);
  const caso = casoId ? (await db.get(`wati_sac_casos?id=eq.${casoId}&select=*`))[0] : null;
  if (casoId && !caso) return { ok: false, erro: 'caso ' + casoId + ' não existe' };
  const wa = String((caso && caso.wa_id) || b.wa_id || '').replace(/\D/g, '');
  const texto = String(b.texto || '').trim();
  const pedido = String(b.pedido || (caso && caso.pedido) || '').replace(/\D/g, '');
  let simulacao = '';

  if (tipo === 'mensagem') {
    // Arquivo anexado no cartão (PDF da etiqueta, foto). Pedido da Marcelly em 19/10/2026: "não dá
    // pra enviar por ali a etiqueta". Arquivo só vai dentro da janela de 24h (template não leva).
    const arq = b.arquivo && typeof b.arquivo === 'object' && b.arquivo.size ? b.arquivo : null;
    if (arq && arq.size > ARQUIVO_MAX) return { ok: false, erro: 'Arquivo grande demais (máximo 5 MB).' };
    if (!(arq && !texto)) {
      const prob = problemasDoTexto(texto);
      if (prob.length) return { ok: false, erro: 'Ajuste o texto antes de enviar: ' + prob.join(', ') };
    }
    if (!wa) return { ok: false, erro: 'sem número da cliente' };
    if (prometeDinheiro(texto) && !(casoId && aprovacaoLiberada(casoId, log)))
      return { ok: false, erro: 'O texto promete dinheiro (estorno, desconto, frete, brinde). Isso precisa da aprovação da Bárbara antes.' };
    // Janela pela conversa do WhatsApp (a mesma fonte da conversa); o histórico da Vi fica de reserva.
    const conv = await conversaWhatsapp(env, wa, 15)
      || await db.get(`wati_ia_mensagens?wa_id=eq.${wa}&role=eq.user&order=created_at.desc&limit=1&select=role,created_at`);
    const jan = janelaAberta(conv, agora);
    const assunto = String(b.assunto || '').trim();
    if (arq && !jan.aberta) return { ok: false, erro: 'A janela de 24h fechou e arquivo não vai por template. Mande primeiro a mensagem sem o arquivo (vai o template de continuidade); quando a cliente responder, anexe a etiqueta de novo.' };
    if (!jan.aberta && !assunto) return { ok: false, erro: 'A janela de 24h fechou. Precisa de um assunto curto para o template de continuidade.' };
    simulacao = arq ? `iria o arquivo ${arq.name || ''} com a mensagem (janela de 24h aberta)`
      : jan.aberta ? 'iria como mensagem normal (janela de 24h aberta)' : `iria pelo template de continuidade com o assunto "${assunto}" (janela fechada)`;
    if (soLeitura(env)) return { ok: false, so_leitura: true, simulacao };
    let gravado = texto;
    if (arq) {
      conferirEnvio(await enviarArquivoDaLoja(env, wa, arq, texto));
      gravado = `[a loja enviou o arquivo ${arq.name || ''}]${texto ? ' ' + texto : ''}`;
    } else if (jan.aberta) conferirEnvio(await enviarTextoDaLoja(env, wa, texto));
    else {
      const nome = primeiroNome(caso && caso.nome);
      gravado = conferirEnvio(await enviarModeloDaLoja(env, wa, TEMPLATE_CONTINUIDADE, [nome, assunto])).texto;
    }
    // Grava no histórico da Vi como mensagem dela (assistant): ela continua a conversa sabendo o
    // que foi dito. Como "operador" a Vi pausaria 24h naquele contato.
    await db.send('POST', 'wati_ia_mensagens', { msg_id: novoId('painel_'), wa_id: wa, role: 'assistant', texto: gravado }, 'return=minimal');
    const c = caso || await abrirCasoNovo(db, wa, gravado);
    await registrar(env, { caso_id: c.id, tipo: 'mensagem', texto: gravado, via: arq ? 'arquivo' : jan.aberta ? 'sessao' : 'template', em: new Date(agora).toISOString() });
    return { ok: true, feito: arq ? 'arquivo enviado' : jan.aberta ? 'mensagem enviada' : 'template de continuidade enviado', caso_id: c.id };
  }

  if (tipo === 'anotar') {
    if (!texto) return { ok: false, erro: 'nota vazia' };
    if (!casoId && !pedido) return { ok: false, erro: 'diga o caso ou o pedido' };
    simulacao = `iria no topo ${casoId ? 'do caso ' + casoId : ''}${casoId && pedido ? ' e ' : ''}${pedido ? 'da observação do pedido #' + pedido : ''}`;
    if (soLeitura(env)) return { ok: false, so_leitura: true, simulacao };
    const dia = new Date(agora - 3 * 3600e3).toISOString().slice(8, 10) + '/' + new Date(agora - 3 * 3600e3).toISOString().slice(5, 7);
    // A nota vai no TOPO: quem abre lê primeiro a instrução nova, não a velha da Vi.
    // O resumo do caso é reescrito pela Vi a cada 6h; a nota fica guardada no casos-log também.
    if (caso) await db.send('PATCH', `wati_sac_casos?id=eq.${casoId}`, { resumo: (`+ [${dia}] ${texto}\n\n` + (caso.resumo || '')).slice(0, 3000), atualizado_at: new Date(agora).toISOString() }, 'return=minimal');
    if (pedido) {
      const o = await pedidoBruto(env, pedido);
      if (!o) return { ok: false, erro: 'pedido #' + pedido + ' não achado' };
      const r = await shop(env, `orders/${o.id}.json`, { method: 'PUT', body: JSON.stringify({ order: { id: o.id, note: `[${dia}] ${texto}\n` + (o.note || '') } }) });
      if (!r.ok) throw new Error('Shopify não gravou a observação: ' + r.status);
    }
    await registrar(env, { caso_id: casoId, pedido, tipo: 'anotar', texto, em: new Date(agora).toISOString() });
    return { ok: true, feito: 'anotado' };
  }

  if (tipo === 'urgente') {
    if (!pedido) return { ok: false, erro: 'precisa do número do pedido' };
    simulacao = `o pedido #${pedido} iria para a PRIORIDADE DE LIBERAÇÃO do SAC`;
    if (soLeitura(env)) return { ok: false, so_leitura: true, simulacao };
    const agoraIso = new Date(agora).toISOString();
    await mudarDoc(env, 'sac', d => {
      d.tickets = d.tickets || [];
      const t = d.tickets.find(x => String(x.pedido).replace(/\D/g, '') === pedido && x.status !== 'resolvido');
      if (t) { t.urgente = true; t.atualizado_em = agoraIso; }
      else d.tickets.push({ id: 'sac' + agora, pedido, caso: texto || 'Prioridade pedida pela aba Casos', info_expedicao: '',
        rastreio: '', urgente: true, status: 'pendente', criado_em: agoraIso, atualizado_em: agoraIso, origem: 'casos' });
      d.updated_at = agoraIso;
    }, () => ({ tickets: [], removidos: [] }));
    await registrar(env, { caso_id: casoId, pedido, tipo: 'urgente', texto, em: agoraIso });
    return { ok: true, feito: 'pedido marcado como urgente no SAC' };
  }

  if (tipo === 'fechar') {
    if (!casoId) return { ok: false, erro: 'qual caso?' };
    const pode = podeFechar(casoId, log);
    if (!pode.ok) return { ok: false, erro: 'Ainda não dá para fechar: ' + pode.motivo };
    simulacao = 'o caso ' + casoId + ' seria fechado';
    if (soLeitura(env)) return { ok: false, so_leitura: true, simulacao };
    await db.send('PATCH', `wati_sac_casos?id=eq.${casoId}`, { status: 'resolvido', atualizado_at: new Date(agora).toISOString() }, 'return=minimal');
    await registrar(env, { caso_id: casoId, tipo: 'fechar', texto, em: new Date(agora).toISOString() });
    return { ok: true, feito: 'caso fechado' };
  }

  if (tipo === 'fechar_conversa') {
    if (!caso) return { ok: false, erro: 'qual caso?' };
    if (caso.status !== 'aberto') return { ok: true, feito: 'caso já estava fechado' };
    const pode = podeFecharPelaConversa(caso, log);
    if (!pode.ok) return { ok: false, erro: 'Ainda não dá para fechar: ' + pode.motivo };
    simulacao = 'o caso ' + casoId + ' seria fechado';
    if (soLeitura(env)) return { ok: false, so_leitura: true, simulacao };
    await db.send('PATCH', `wati_sac_casos?id=eq.${casoId}&status=eq.aberto`, { status: 'resolvido', atualizado_at: new Date(agora).toISOString() }, 'return=minimal');
    await registrar(env, { caso_id: casoId, tipo: 'fechar', texto: texto || 'Fechado junto com a conversa (Resolvida no Vi - atendimento)', em: new Date(agora).toISOString() });
    return { ok: true, feito: 'caso fechado' };
  }

  if (tipo === 'pedir_aprovacao') {
    const cat = CATEGORIAS_DINHEIRO.includes(b.categoria) ? b.categoria : 'outro';
    if (!texto) return { ok: false, erro: 'escreva o motivo' };
    const valor = ehNum(b.valor) ? Number(b.valor) : null;
    const cliente = primeiroNome(caso && caso.nome);
    const aviso = `Caso ${casoId || 'sem número'}, ${cliente}${pedido ? ', pedido #' + pedido : ''}. Pede ${cat}${valor !== null ? ' de R$ ' + valor.toFixed(2).replace('.', ',') : ''}. Motivo ${texto.slice(0, 400)}. Para decidir abra o painel em Atendimento, Assistente.`;
    simulacao = 'iria para a fila Aguardando Bárbara, com aviso no WhatsApp dela';
    if (soLeitura(env)) return { ok: false, so_leitura: true, simulacao, aviso };
    const id = novoId('apv_');
    await mudarDoc(env, DOC_LOG, d => {
      d.aprovacoes = d.aprovacoes || [];
      d.aprovacoes.push({ id, caso_id: casoId, cliente, pedido, categoria: cat, valor, motivo: texto, status: 'pendente', criado_em: new Date(agora).toISOString() });
    }, logVazio);
    let avisada = false;
    if (env.CASOS_AVISO_WA) {
      try { avisada = !(await enviarModeloDaLoja(env, env.CASOS_AVISO_WA, TEMPLATE_ALERTA, [aviso.slice(0, 900)])).erro; } catch (_) {}
    }
    return { ok: true, feito: 'pedido enviado para a Bárbara' + (avisada ? ' (avisada no WhatsApp)' : ' (aviso no WhatsApp não saiu, ela vê no painel)'), id };
  }

  return { ok: false, erro: 'ação desconhecida: ' + tipo };
}

async function registrar(env, acao) {
  await mudarDoc(env, DOC_LOG, d => {
    d.acoes = d.acoes || [];
    d.acoes.push({ id: novoId('ac_'), ...acao });
    if (d.acoes.length > 3000) d.acoes = d.acoes.slice(-3000);
  }, logVazio);
}

// Conversa sem caso no CRM (cliente sem resposta): ao agir, abre um para o registro ter onde morar.
async function abrirCasoNovo(db, wa, texto) {
  const sess = (await db.get(`wati_ia_sessions?wa_id=eq.${wa}&select=nome`))[0];
  const [c] = await db.send('POST', 'wati_sac_casos', { wa_id: wa, nome: (sess && sess.nome) || null, tipo: 'atendimento pela aba Casos', resumo: String(texto).slice(0, 500) });
  return c;
}

async function decidir(env, { id, decisao, nota }, agora = Date.now()) {
  if (!['aprovado', 'recusado'].includes(decisao)) return { ok: false, erro: 'decisão inválida' };
  if (soLeitura(env)) return { ok: false, so_leitura: true, simulacao: 'a aprovação ficaria ' + decisao };
  let achou = false;
  await mudarDoc(env, DOC_LOG, d => {
    const a = (d.aprovacoes || []).find(x => x.id === id);
    if (a && a.status === 'pendente') { a.status = decisao; a.nota = nota || ''; a.decidido_em = new Date(agora).toISOString(); achou = true; }
  }, logVazio);
  return achou ? { ok: true } : { ok: false, erro: 'aprovação não está mais pendente' };
}

async function marcarFeito(env, { id, nota }, agora = Date.now()) {
  if (soLeitura(env)) return { ok: false, so_leitura: true, simulacao: 'ficaria marcado como feito' };
  let a = null;
  await mudarDoc(env, DOC_LOG, d => {
    a = (d.aprovacoes || []).find(x => x.id === id && x.status === 'aprovado');
    if (!a) return;
    a.status = 'feito'; a.feito_em = new Date(agora).toISOString(); a.nota_feito = nota || '';
    d.acoes = d.acoes || [];
    d.acoes.push({ id: novoId('ac_'), caso_id: a.caso_id, pedido: a.pedido, tipo: 'aprovacao_feita', texto: `${a.categoria} ${a.valor ?? ''} ${nota || ''}`.trim(), em: a.feito_em });
  }, logVazio);
  return a ? { ok: true } : { ok: false, erro: 'só dá para marcar como feito o que a Bárbara aprovou' };
}

// ── Rota ────────────────────────────────────────────────────────────────────────
export async function onRequestGet({ request, env }) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return J({ erro: 'SUPABASE_SERVICE_ROLE_KEY ausente' }, 500);
  const u = new URL(request.url);
  try {
    const log = await lerLog(env);
    const abertas = log.aprovacoes.filter(a => a.status === 'pendente' || a.status === 'aprovado');
    // Botão "Casos em aberto" no topo do Assistente (30/10/2026): lista direta do CRM da Vi, sem passar pela IA.
    if (u.searchParams.get('abertos')) {
      const casos = await sb(env).get('wati_sac_casos?status=eq.aberto&order=criado_at.asc&limit=300&select=id,wa_id,nome,tipo,pedido,resumo,criado_at,status,responsavel');
      return J({ casos: casos.map(c => ({ ...resumoDoCaso(c), dinheiro: casoDeDinheiro(c), pode_fechar: podeFecharPelaConversa(c, log).ok })) });
    }
    if (u.searchParams.get('aprovacoes')) {
      return J({ so_leitura: soLeitura(env), aprovacoes: log.aprovacoes.slice(-60).reverse() });
    }
    return J({ so_leitura: soLeitura(env), tem_chave: !!env.ANTHROPIC_API_KEY,
      aprovacoes_pendentes: abertas.filter(a => a.status === 'pendente').length, aprovadas_a_fazer: abertas.filter(a => a.status === 'aprovado').length });
  } catch (e) { return J({ erro: e.message }, 500); }
}

export async function onRequestPost({ request, env }) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return J({ erro: 'SUPABASE_SERVICE_ROLE_KEY ausente' }, 500);
  // Botão com arquivo anexado chega como multipart; o resto é JSON.
  let b = null;
  if (/multipart\/form-data/i.test(request.headers.get('content-type') || '')) {
    const fd = await request.formData().catch(() => null);
    if (fd) { b = {}; for (const [k, v] of fd.entries()) b[k] = v; }
  } else b = await request.json().catch(() => null);
  if (!b || !b.acao) return J({ erro: 'corpo inválido' }, 400);
  try {
    if (b.acao === 'assistente') return await assistente(env, b.messages);
    if (b.acao === 'ferramenta') {
      if (!FERRAMENTAS_SERVIDOR.includes(b.nome)) return J({ erro: 'ferramenta não é do servidor: ' + b.nome }, 400);
      return J({ resultado: await ferramenta(env, b.nome, b.input) });
    }
    if (b.acao === 'executar') return J(await executar(env, b));
    if (b.acao === 'decidir') return J(await decidir(env, b));
    if (b.acao === 'feito') return J(await marcarFeito(env, b));
    return J({ erro: 'ação desconhecida' }, 400);
  } catch (e) {
    return J({ erro: e.message }, 500);
  }
}

// Para os testes
export const _interno = { executar, buscarPedido, abrirCaso, pendenciasDoDia, mudarDoc };
