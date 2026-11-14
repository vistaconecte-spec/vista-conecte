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
  semResposta, promessasDaEquipe, pagoPorItem, numerosDePedido, pedidoEhDaCliente, emailsDoTexto, devolucoesDoPainel, codigosNaConversa, reversasDoPedido, prazoDoPedido, logVazio, podeFechar, podeFecharPelaConversa, casoDeDinheiro, semEscapeUnicode, aprovacaoLiberada, novoId,
  primeiroNome, finalTel, resumoDoCaso, conversaParaAssistente, hojeTexto, brt, metaParaMsg, esperaDaEquipe, PRAZO_RESPOSTA_H, pecasParaConferir, esperaBruta, JUIZ_FILA, conversaParaJuiz, lerJuizo, fatosDoSistema, JUIZ_CONFERIR, lerConferir,
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

const CAMPOS_PEDIDO = 'id,name,created_at,financial_status,fulfillment_status,cancelled_at,total_price,subtotal_price,line_items,shipping_lines,fulfillments,note,tags,refunds,payment_gateway_names,email,phone,customer,shipping_address,billing_address';

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

// ctx ({ wa, emails }) só no abrir_caso: diz se o pedido é da cliente do caso e devolve o e-mail dela em _email,
// que o abrirCaso usa para achar os outros pedidos e tira antes de mandar para a IA.
async function buscarPedido(env, numero, agora = Date.now(), ctx = null) {
  const o = await pedidoBruto(env, numero);
  if (!o) return { encontrado: false, numero };
  const dona = ctx ? pedidoEhDaCliente(o, ctx) : null;
  if (ctx && !dona) return { encontrado: true, numero: o.name, de_outra_cliente: primeiroNome((o.customer && o.customer.first_name) || ''),
    aviso: 'Este pedido é de OUTRA cliente (telefone e e-mail não batem). Não proponha nada nele; diga que o número citado não é dela.' };
  let pagoEm = null, ref = null;
  try {
    const t = await shop(env, `orders/${o.id}/transactions.json`);
    if (t.ok) {
      const venda = ((await t.json()).transactions || []).find(x => (x.kind === 'sale' || x.kind === 'capture') && x.status === 'success');
      if (venda) { pagoEm = venda.processed_at || venda.created_at; ref = venda.receipt && venda.receipt.payment_id; }
    }
  } catch (_) {}
  const mp = await pagamentoMP(env, ref).catch(() => null);
  // Chave da NF-e: a Frenet exige na etiqueta desde 30/10/2026 e a Marcelly não tinha onde ver (06/11/2026). Vem do
  // registro do automático (linhas bling-nfe:<id>), sem chamar o Bling; pedido de antes de 16/10 quase nunca tem.
  const nota = await sb(env, true).get(`vc_modelos?id=like.bling-nfe:*&dados->>shopify=eq.${encodeURIComponent(o.name)}&select=dados&limit=1`)
    .then(l => (l[0] && l[0].dados) || null).catch(() => null);
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
    nota_fiscal: nota && nota.status === 'enviada' && nota.chave ? { numero: nota.numero_nota || null, chave: String(nota.chave).replace(/\D/g, '') } : null,
    etiquetas: (o.fulfillments || []).map(f => ({ em: f.created_at, transportadora: f.tracking_company, rastreio: f.tracking_number })),
    observacao: String(o.note || '').slice(0, 500), tags: o.tags || '',
    estornos_shopify: estornosShopify, mercado_pago: mp,
    prazo: o.financial_status === 'paid' || o.financial_status === 'partially_refunded'
      ? prazoDoPedido(pagoEm || o.created_at, agora, ((o.fulfillments || [])[0] || {}).created_at || null) : null,
    aviso: 'A data de etiqueta é a de quando a etiqueta foi gerada, não a da coleta.',
    ...(ctx ? { da_cliente: true, _email: String(o.email || (o.customer && o.customer.email) || '').toLowerCase() || null } : {}),
  };
}

// Pedido de troca (R$ 0) lançado na Shopify para o pedido original: tag troca-de-N, que o portal e o painel põem.
// Peça nova despachada sem esse pedido não baixa estoque nem aparece na produção (caso 727, calça reenviada à mão).
async function pedidosDeTroca(env, numeros) {
  const ns = numeros.map(n => String(n).replace(/\D/g, '')).filter(Boolean).slice(0, 3);
  if (!ns.length) return [];
  const q = '{' + ns.map(n => `t${n}: orders(first: 5, query: "tag:troca-de-${n}") { nodes { name createdAt displayFulfillmentStatus fulfillments(first: 2) { createdAt trackingInfo { number } } } }`).join(' ') + '}';
  const r = await shop(env, 'graphql.json', { method: 'POST', body: JSON.stringify({ query: q }) });
  const d = ((await r.json()) || {}).data || {};
  return ns.map(n => ({ pedido_original: '#' + n, pedidos_de_troca: ((d['t' + n] || {}).nodes || []).map(o => ({ numero: o.name, criado_em: o.createdAt,
    envio: o.displayFulfillmentStatus, rastreio: ((((o.fulfillments || [])[0] || {}).trackingInfo || [])[0] || {}).number || null })) }));
}

// Os outros pedidos da cliente, achados pelo e-mail, em versão curta (sem transação, Mercado Pago nem nota).
async function outrosPedidos(env, emails, jaTem) {
  const out = [];
  for (const e of emails.slice(0, 2)) {
    const r = await shop(env, `orders.json?status=any&email=${encodeURIComponent(e)}&limit=8&fields=name,created_at,financial_status,fulfillment_status,cancelled_at,total_price,line_items,fulfillments,refunds`).catch(() => null);
    if (!r || !r.ok) continue;
    for (const o of ((await r.json()).orders || [])) {
      if (jaTem.has(o.name) || out.some(x => x.numero === o.name)) continue;
      out.push({ numero: o.name, criado_em: o.created_at, pagamento: o.financial_status, cancelado_em: o.cancelled_at, total: o.total_price,
        envio: o.fulfillment_status || 'não enviado', itens: (o.line_items || []).map(i => `${i.quantity}x ${i.title}${i.variant_title ? ' (' + i.variant_title + ')' : ''}`),
        pago_por_item: (o.line_items || []).map(pagoPorItem),
        etiquetas: (o.fulfillments || []).map(f => ({ em: f.created_at, rastreio: f.tracking_number })),
        estornado: (o.refunds || []).reduce((s, x) => s + (x.transactions || []).reduce((t, y) => t + (parseFloat(y.amount) || 0), 0), 0) });
    }
  }
  return out.slice(0, 6);
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
  // 150 mensagens: o caso inteiro, desde o primeiro dia (Bárbara, 11/11/2026, caso 708 sem contexto com 60)
  const doZap = wa ? await conversaWhatsapp(env, wa, 150) : null;
  const msgs = doZap || (wa ? (await db.get(`wati_ia_mensagens?wa_id=eq.${wa}&order=created_at.desc&limit=150&select=role,texto,created_at`)).reverse() : []);
  const daCliente = msgs.filter(m => m.role === 'user').map(m => m.texto).join('\n');
  // Até 4 números citados, cada um conferido contra a cliente; depois os outros pedidos dela pelo e-mail e o que o
  // painel sabe de devolução e estorno (Bárbara, 11/11/2026: o Assistente precisa da mesma leitura do caso 708).
  const numeros = numerosDePedido(pedido || (caso && caso.pedido), caso && caso.resumo, daCliente).slice(0, 4);
  const ctx = { wa, emails: emailsDoTexto(daCliente) };
  const pedidos = [];
  for (const n of numeros) { try { pedidos.push(await buscarPedido(env, n, agora, ctx)); } catch (e) { pedidos.push({ numero: n, erro: e.message }); } }
  const emails = [...new Set([...pedidos.map(p => p._email).filter(Boolean), ...ctx.emails])];
  pedidos.forEach(p => { delete p._email; });
  const outros = await outrosPedidos(env, emails, new Set(pedidos.map(p => p.numero))).catch(() => []);
  const daCli = [...pedidos.filter(p => p.da_cliente).map(p => p.numero), ...outros.map(p => p.numero)];
  const listas = await sb(env, true).get('vc_modelos?id=in.(retorno,estorno,reversas-resultado,rastreio-trocas)&select=id,dados').catch(() => null);
  const doc = id => ((listas || []).find(x => x.id === id) || {}).dados;
  const devolucoes = listas ? devolucoesDoPainel(doc('retorno'), doc('estorno'), daCli) : null;
  // Caso 727 (11/11/2026): a cliente já postou a peça? e a peça nova foi lançada na Shopify como pedido de troca?
  const reversas = listas ? reversasDoPedido(doc('reversas-resultado'), doc('rastreio-trocas'), daCli, codigosNaConversa(msgs)) : null;
  const trocasShopify = await pedidosDeTroca(env, pedidos.filter(p => p.da_cliente).map(p => p.numero)).catch(() => null);
  const log = await lerLog(env);
  const id = caso && caso.id;
  return {
    hoje: hojeTexto(agora), agora_brt: brt(agora),
    caso: caso ? { ...resumoDoCaso(caso, agora), aberto_em_brt: brt(caso.criado_at), resumo: String(caso.resumo || '').slice(0, 3000) } : null,
    aviso_caso: caso ? null : 'sem caso no CRM para este contato; se a Marcelly agir, o painel abre um',
    wa_id: wa || null, final_tel: finalTel(wa),
    janela_24h: janelaAberta(msgs, agora),
    conversa_fonte: doZap ? 'WhatsApp (completa, com documentos e imagens)' : 'histórico da Vi (só texto; documento e imagem enviados podem faltar)',
    conversa: conversaParaAssistente(msgs, 150),
    promessas_da_equipe: promessasDaEquipe(msgs, { agora }),
    pedidos,
    outros_pedidos_da_cliente: outros,
    devolucoes_no_painel: devolucoes,
    reversas_do_pedido: reversas,
    pedidos_de_troca_na_shopify: trocasShopify,
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
  const texto = semEscapeUnicode(b.texto).trim();
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
    // Regra da Bárbara (13/11/2026): todo caso é da Marcelly; só passa para a Bárbara quando a Marcelly pede a aprovação
    // de estorno ou dinheiro definitivo, que é este botão.
    if (casoId) await db.send('PATCH', `wati_sac_casos?id=eq.${casoId}`, { responsavel: 'Bárbara', atualizado_at: new Date(agora).toISOString() }, 'return=minimal').catch(() => {});
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
  const [c] = await db.send('POST', 'wati_sac_casos', { wa_id: wa, nome: (sess && sess.nome) || null, tipo: 'atendimento pela aba Casos', resumo: String(texto).slice(0, 500), responsavel: 'Marcelly' });
  return c;
}

async function decidir(env, { id, decisao, nota }, agora = Date.now()) {
  if (!['aprovado', 'recusado'].includes(decisao)) return { ok: false, erro: 'decisão inválida' };
  if (soLeitura(env)) return { ok: false, so_leitura: true, simulacao: 'a aprovação ficaria ' + decisao };
  let achou = false, casoDecidido = null;
  await mudarDoc(env, DOC_LOG, d => {
    const a = (d.aprovacoes || []).find(x => x.id === id);
    if (a && a.status === 'pendente') { a.status = decisao; a.nota = nota || ''; a.decidido_em = new Date(agora).toISOString(); achou = true; casoDecidido = a.caso_id; }
  }, logVazio);
  // recusado volta para a Marcelly seguir com a cliente; aprovado fica com a Bárbara até ela marcar como feito
  if (achou && decisao === 'recusado' && casoDecidido) await sb(env).send('PATCH', `wati_sac_casos?id=eq.${Number(casoDecidido)}`, { responsavel: 'Marcelly' }, 'return=minimal').catch(() => {});
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

// Fila da equipe (13/11/2026): casos abertos em que a cliente escreveu depois da última fala da equipe, com as
// horas úteis de espera. Passou de PRAZO_RESPOSTA_H, vencido (aparece também para a Bárbara).
export async function filaEquipe(env, agora = Date.now()) {
  const db = sb(env);
  const casos = await db.get('wati_sac_casos?status=eq.aberto&order=criado_at.asc&limit=300&select=id,wa_id,nome,pedido,tipo,responsavel');
  const was = [...new Set(casos.map(c => c.wa_id).filter(Boolean))];
  const desde = new Date(agora - 45 * DIA).toISOString();
  const porWa = {};
  for (let i = 0; i < was.length; i += 40) {
    // O Supabase devolve no máximo 1000 linhas por chamada; antes vinha em ordem crescente e cortava as
    // mensagens MAIS NOVAS (a resposta da Marcelly à Lu, 13/11, sumia). Agora pagina, das mais novas.
    for (let pag = 0; pag < 8; pag++) {
      const lote = await db.get(`wati_ia_mensagens?wa_id=in.(${was.slice(i, i + 40).join(',')})&role=in.(user,operador,assistant)&created_at=gte.${encodeURIComponent(desde)}&select=wa_id,role,texto,created_at&order=created_at.desc&limit=1000&offset=${pag * 1000}`);
      for (const m of lote) (porWa[m.wa_id] = porWa[m.wa_id] || []).push(m);
      if (lote.length < 1000) break;
    }
    // O que saiu pelo painel (equipe ou mensagem aprovada pela Bárbara) também é resposta da equipe
    const fim8 = t => String(t || '').replace(/\D/g, '').slice(-8);
    const porFim = {};
    for (const w of was.slice(i, i + 40)) porFim[fim8(w)] = w;
    const tels = was.slice(i, i + 40).flatMap(w => variantes(w));
    const doPainel = await db.get(`wa_mensagens?telefone=in.(${tels.join(',')})&direcao=eq.saida&origem=eq.painel&recebida_em=gte.${encodeURIComponent(desde)}&select=telefone,recebida_em,texto&order=recebida_em.desc&limit=1000`).catch(() => []);
    for (const m of doPainel) { const w = porFim[fim8(m.telefone)]; if (w) (porWa[w] = porWa[w] || []).push({ role: 'operador', texto: m.texto || '', created_at: m.recebida_em }); }
  }
  for (const w of Object.keys(porWa)) porWa[w].sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)));
  // Quem escreveu depois da última fala da equipe é candidata; a IA lê a conversa e decide (13/11/2026)
  const vistos = new Set();
  const cand = [];
  for (const c of casos) {
    if (!c.wa_id || vistos.has(c.wa_id)) continue;
    vistos.add(c.wa_id);
    // Caso com a Bárbara (estorno) não é da fila da equipe: aparece no Aguardando Bárbara (13/11/2026)
    if (c.responsavel === 'Bárbara') continue;
    const e = esperaBruta(porWa[c.wa_id], agora);
    if (e) cand.push({ c, e });
  }
  // O que o sistema sabe de trocas e devoluções vai junto da conversa para a IA (e a mesma leitura serve às peças para conferir)
  let docs = [];
  try { docs = await sb(env, true).get('vc_modelos?id=in.(retorno,estorno,rastreio-trocas,reversas-resultado,fila-juizo)&select=id,dados'); } catch (_) {}
  const doc = id => ((docs.find(d => d.id === id) || {}).dados || {});
  const sistema = { retorno: doc('retorno').itens || [], estorno: doc('estorno').itens || [], rastreio: doc('rastreio-trocas').itens || {}, reversas: doc('reversas-resultado').itens || {} };
  for (const x of cand) { x.fatos = fatosDoSistema(x.c.pedido, sistema); x.chave = x.e.ultima_em + '|' + x.fatos.join(' ').length + ':' + x.fatos.join(' ').slice(-40); }
  let juizos = doc('fila-juizo').itens || {};
  const atual = x => { const j = juizos[x.c.wa_id]; return j && j.ate === x.chave ? j : null; };
  // Lê no máximo 8 conversas por vez (limite de chamadas do Cloudflare); as mais antigas primeiro. O resto entra na
  // fila como "ainda não lida" e é lido nas próximas consultas, de 5 em 5 minutos.
  const ler = cand.filter(x => !atual(x)).sort((a, b) => String(a.e.desde).localeCompare(String(b.e.desde))).slice(0, env.ANTHROPIC_API_KEY ? 8 : 0);
  let mudou = false;
  if (ler.length) {
    const lidos = await Promise.all(ler.map(x => julgarEspera(env, porWa[x.c.wa_id], x.c, x.fatos).catch(() => null)));
    ler.forEach((x, i) => { if (lidos[i]) { juizos[x.c.wa_id] = { ...lidos[i], ate: x.chave, lido_em: new Date(agora).toISOString() }; mudou = true; } });
  }
  // Peça da troca que voltou e ninguém conferiu: prazo de 1 dia útil (13/11/2026). Junto vai a conversa da cliente,
  // lida pela IA, para a equipe ver se falta dizer alguma coisa a ela enquanto a troca anda (Bárbara, 14/11/2026).
  let conferir = [];
  try { conferir = pecasParaConferir(sistema.retorno, sistema.rastreio, agora); } catch (_) {}
  if (conferir.length) {
    try {
      const nums = [...new Set(conferir.map(p => String(p.pedido || '').replace(/\D/g, '')).filter(Boolean))];
      const achados = nums.length ? await db.get(`wati_sac_casos?or=(${nums.map(n => `pedido.ilike.*${n}*`).join(',')})&wa_id=not.is.null&select=wa_id,pedido,nome,tipo,criado_at&order=criado_at.desc&limit=100`) : [];
      for (const p of conferir) {
        const n = String(p.pedido || '').replace(/\D/g, '');
        const c = n && achados.find(x => String(x.pedido || '').replace(/\D/g, '') === n);
        if (c) { p.wa_id = c.wa_id; p.caso = c; }
      }
      const faltam = [...new Set(conferir.map(p => p.wa_id).filter(w => w && !porWa[w]))];
      if (faltam.length) {
        const lote = await db.get(`wati_ia_mensagens?wa_id=in.(${faltam.join(',')})&role=in.(user,operador,assistant)&created_at=gte.${encodeURIComponent(desde)}&select=wa_id,role,texto,created_at&order=created_at.desc&limit=1000`);
        for (const m of lote) (porWa[m.wa_id] = porWa[m.wa_id] || []).push(m);
        for (const w of faltam) if (porWa[w]) porWa[w].sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)));
      }
      for (const p of conferir) {
        const msgs = p.wa_id && porWa[p.wa_id];
        if (!msgs || !msgs.length) continue;
        p.fatos = fatosDoSistema(p.pedido, sistema);
        p.chave = String(msgs[msgs.length - 1].created_at) + '|' + p.fatos.join(' ').length;
      }
      const atualC = p => { const j = juizos['conf:' + p.card_id]; return j && j.ate === p.chave ? j : null; };
      const lerC = conferir.filter(p => p.chave && !atualC(p)).slice(0, env.ANTHROPIC_API_KEY ? 3 : 0);
      if (!env.ANTHROPIC_API_KEY) _erroConferir = 'sem chave da IA';
      if (lerC.length) {
        const lidos = await Promise.all(lerC.map(p => julgarConferir(env, porWa[p.wa_id], p.caso, p.fatos).catch(e => { _erroConferir = 'falhou: ' + String(e && e.message || e).slice(0, 120); return null; })));
        lerC.forEach((p, i) => { if (lidos[i]) { juizos['conf:' + p.card_id] = { ...lidos[i], ate: p.chave, lido_em: new Date(agora).toISOString() }; mudou = true; } });
      }
      for (const p of conferir) {
        const j = p.chave && atualC(p);
        p.conversa = !p.wa_id ? 'sem conversa' : j ? 'lida' : p.chave ? 'ainda não lida' : 'sem conversa';
        if (j) { p.falta_cliente = j.falta; p.cliente_sabe = j.sabe; }
        if (!j && _erroConferir) p.leitura_erro = _erroConferir;
        delete p.caso; delete p.fatos; delete p.chave;
      }
    } catch (e) { for (const p of conferir) p.leitura_erro = String(e && e.message || e).slice(0, 160); }
  }
  if (mudou) {
    const vivos = new Set([...cand.map(x => x.c.wa_id), ...conferir.map(p => 'conf:' + p.card_id)]);
    for (const w of Object.keys(juizos)) if (!vivos.has(w)) delete juizos[w];
    await sb(env, true).send('POST', 'vc_modelos?on_conflict=id', { id: 'fila-juizo', dados: { itens: juizos, updated_at: new Date(agora).toISOString() } }, 'resolution=merge-duplicates,return=minimal').catch(() => {});
  }
  const itens = [];
  for (const x of cand) {
    const j = atual(x);
    if (j && !j.espera) continue;
    const { c, e } = x;
    itens.push({ caso_id: c.id, cliente: primeiroNome(c.nome), pedido: c.pedido || null, wa_id: c.wa_id, responsavel: c.responsavel || 'Marcelly',
      tipo: String(c.tipo || '').split(' · ')[0].slice(0, 60), desde_brt: brt(e.desde), horas: e.horas, vencido: e.vencido, ultima: e.ultima,
      falta: j ? j.falta : null, lido: !!j });
  }
  for (const p of conferir) itens.push({ ...p, responsavel: 'Marcelly', desde_brt: brt(p.desde) });
  itens.sort((a, b) => b.horas - a.horas);
  // Estornos que estão com a Bárbara: o que decidir vem da primeira linha "[dd/mm] Com a Bárbara ..." do resumo
  let comBarbara = [];
  try {
    const cb = await db.get(`wati_sac_casos?status=eq.aberto&responsavel=eq.${encodeURIComponent('Bárbara')}&select=id,wa_id,nome,pedido,tipo,resumo,atualizado_at&order=atualizado_at.asc&limit=50`);
    comBarbara = cb.map(c => {
      const linhas = String(c.resumo || '').split(/\r?\n/);
      const linha = linhas.find(l => /Com a Bárbara/i.test(l)) || linhas[0] || '';
      return { caso_id: c.id, cliente: primeiroNome(c.nome), pedido: c.pedido || null, wa_id: c.wa_id,
        decidir: linha.replace(/^\[[^\]]*\]\s*/, '').replace(/^Com a Bárbara[^:]*:\s*/i, '').slice(0, 220) || String(c.tipo || '').slice(0, 120) };
    });
  } catch (_) {}
  return { prazo_horas: PRAZO_RESPOSTA_H, itens, vencidos: itens.filter(i => i.vencido).length, com_barbara: comBarbara };
}
const DIA = 86400000;
// Valor do estorno preenchido sozinho no botão "Estorno sem reversão" (Bárbara, 13/11/2026: "o valor precisa ser
// automático, o motivo ela sempre preenche"). Devolução lançada no painel = soma das peças devolvidas (valor pago);
// sem devolução = o que a cliente pagou no pedido menos o que já foi estornado.
// Estornos com a Bárbara, completos (Bárbara, 13/11/2026: "precisa ter o resumo do caso, qual forma de estorno devo
// fazer, pix, crédito, mp ou outro" e "se o item já chegou"). Só roda quando ela abre o Aguardando Bárbara.
export function formaDoEstorno({ gateways = '', mp = null, pagoEm = null, agora = Date.now() } = {}) {
  const g = String(gateways || '').toLowerCase();
  const dias = pagoEm ? (agora - Date.parse(pagoEm)) / 86400000 : 0;
  if (/pagar\.?me|pagarme/.test(g)) return { forma: 'Pix para a cliente', porque: 'foi pago pela Pagar.me, que está desligada e não estorna; pedir a chave Pix dela' };
  if (/mercado/.test(g) || (mp && mp.achado)) {
    const meio = mp && mp.meio;
    if (meio === 'credit_card') {
      if (dias > 175) return { forma: 'Pix para a cliente', porque: 'cartão pago há mais de 180 dias, o Mercado Pago não estorna mais' };
      return { forma: 'Estorno no cartão pelo Mercado Pago', porque: `cartão${mp.parcelas > 1 ? ' em ' + mp.parcelas + 'x' : ''}, volta na fatura dela` };
    }
    if (meio === 'bank_transfer' || meio === 'account_money') return { forma: 'Estorno do Pix pelo Mercado Pago', porque: 'pagou por Pix no Mercado Pago, o valor volta para a conta dela' };
    if (meio === 'ticket') return { forma: 'Pix para a cliente', porque: 'pagou por boleto, que não tem estorno; pedir a chave Pix dela' };
    return { forma: 'Mercado Pago (conferir o meio no pagamento)', porque: mp && mp.erro ? mp.erro : 'não consegui ler o meio de pagamento' };
  }
  if (/manual|pix|dep[oó]sito|transfer/.test(g) || !g) return { forma: 'Pix para a cliente', porque: 'pagamento feito fora do checkout (Pix direto); pedir a chave Pix dela' };
  return { forma: 'Conferir o meio: ' + gateways, porque: 'meio de pagamento que o painel não conhece' };
}
// Rastreio pela API pública da Frenet (mesmo token da cotação), igual ao robô: entregue ao destinatário = chegou na loja
export function devolucoesDaCliente(lista, { nome, cep, desde } = {}) {
  const norm = x => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  const partes = norm(nome).split(' ').filter(p => p.length > 2);
  const c = String(cep || '').replace(/\D/g, '');
  const d0 = desde ? Date.parse(desde) : 0;
  return (lista || []).filter(v => {
    if (!v || (d0 && Date.parse(v.criado || 0) < d0)) return false;
    const r = norm(v.remetente);
    const porNome = partes.length >= 2 && r.includes(partes[0]) && partes.slice(1).some(p => r.includes(p));
    return porNome || (c && v.cep && v.cep === c);
  }).sort((a, b) => String(b.criado).localeCompare(String(a.criado)));
}
async function rastreioFrenet(env, codigo) {
  const r = await fetch('https://api.frenet.com.br/tracking/trackinginfo', { method: 'POST',
    headers: { token: env.FRENET_TOKEN, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ShippingServiceCode: '03298', TrackingNumber: String(codigo).replace(/[^A-Z0-9]/gi, '').toUpperCase() }) });
  const j = await r.json().catch(() => null);
  const ev = (j && j.TrackingEvents) || [];
  if (!ev.length) return { eventos: 0 };
  const ent = ev.find(e => /entregue ao destinat/i.test(e.EventDescription || ''));
  return { eventos: ev.length, entregue: !!ent, entregue_em: ent ? String(ent.EventDateTime || '').slice(0, 10) : null,
    ultimo: String((ev[0] && ev[0].EventDescription) || '').split(' - ')[0].slice(0, 80) };
}
async function estornosDaBarbara(env, agora = Date.now()) {
  const casos = await sb(env).get(`wati_sac_casos?status=eq.aberto&responsavel=eq.${encodeURIComponent('Bárbara')}&select=id,wa_id,nome,pedido,tipo,resumo&order=atualizado_at.asc&limit=12`);
  let est = [], rast = {}, devLoja = [];
  try {
    const docs = await sb(env, true).get('vc_modelos?id=in.(estorno,rastreio-trocas,devolucoes-frenet)&select=id,dados');
    est = (((docs.find(d => d.id === 'estorno') || {}).dados || {}).itens) || [];
    rast = (((docs.find(d => d.id === 'rastreio-trocas') || {}).dados || {}).itens) || {};
    devLoja = Object.values((((docs.find(d => d.id === 'devolucoes-frenet') || {}).dados || {}).itens) || {});
  } catch (_) {}
  const dia = x => x ? new Date(x).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }) : '';
  const out = [];
  for (const c of casos) {
    const n = ((String(c.pedido || '').match(/\d{4,}/) || [])[0]) || '';
    const linhas = String(c.resumo || '').split(/\r?\n/);
    const resumo = (linhas.find(l => /Com a Bárbara|Estorno sem reversão/i.test(l)) || linhas[0] || '').replace(/^\[[^\]]*\]\s*/, '').replace(/^Com a Bárbara[^:]*:\s*/i, '').slice(0, 260);
    const item = { caso_id: c.id, cliente: primeiroNome(c.nome), pedido: n ? '#' + n : null, wa_id: c.wa_id, tipo: String(c.tipo || '').split(' · ')[0].slice(0, 80), resumo };
    try {
      const v = await valorDoEstorno(env, c.id);
      item.valor = v.valor; item.valor_origem = v.origem;
      const o = n ? await pedidoBruto(env, n) : null;
      if (o) {
        let pagoEm = null, ref = null;
        const t = await shop(env, `orders/${o.id}/transactions.json`);
        if (t.ok) { const venda = ((await t.json()).transactions || []).find(x => (x.kind === 'sale' || x.kind === 'capture') && x.status === 'success'); if (venda) { pagoEm = venda.processed_at || venda.created_at; ref = venda.receipt && venda.receipt.payment_id; } }
        const mp = await pagamentoMP(env, ref).catch(() => null);
        Object.assign(item, formaDoEstorno({ gateways: (o.payment_gateway_names || []).join(', '), mp, pagoEm, agora }));
        item.pagamento = [mp && mp.achado ? 'pagamento MP ' + ref : null, pagoEm ? 'pago ' + dia(pagoEm) : null, mp && mp.devolvido ? `já devolvido R$ ${Number(mp.devolvido).toFixed(2).replace('.', ',')} no MP` : null].filter(Boolean).join(', ');
        // A peça já voltou?
        const re = new RegExp('(#|pedido\\s+#?)\\s?' + n + '(?!\\d)');
        const cards = est.filter(t2 => t2 && re.test(String(t2.pecas || '')) && t2.etapa !== 'concluido');
        const chegou = cards.find(t2 => t2.chegou_em);
        const r2 = cards.map(t2 => rast['estorno:' + t2.id]).find(Boolean);
        // Bárbara (13/11/2026): "precisa conferir sempre na Frenet se a peça voltou pra nós". Além do que o robô já
        // acompanha (rastreio-trocas), confere na Frenet o código de devolução citado no caso ou no cartão.
        const idas = new Set((o.fulfillments || []).map(f => String(f.tracking_number || '').replace(/\s/g, '')).filter(Boolean));
        const codDev = [...new Set([...cards.map(t2 => String(t2.codigo_devolucao || '').trim()).filter(x => x && !x.startsWith('#')),
          ...(String(c.resumo || '').match(/\b[A-Z]{2}\d{9}BR\b|\b\d{10}\b/g) || [])])].filter(x => !idas.has(x));
        let api = null;
        if (!chegou && !(r2 && r2.entregue) && codDev.length && env.FRENET_TOKEN) api = await rastreioFrenet(env, codDev[0]).catch(() => null);
        const naoEnviado = !o.fulfillment_status && !(o.fulfillments || []).length;
        // Etiquetas para a loja na Frenet com ela como remetente, inclusive as feitas à mão (robô, devolucoes-frenet)
        const sa = o.shipping_address || {};
        const doLoja = devolucoesDaCliente(devLoja, { nome: sa.name || [sa.first_name, sa.last_name].filter(Boolean).join(' '), cep: sa.zip, desde: o.created_at });
        item.frenet = doLoja.map(v => `${v.codigo || 'sem código'} de ${dia(v.criado)}: ${v.entregue ? 'entregue na loja ' + dia(v.entregue_em) : v.postado ? 'a caminho' : 'ainda não postada'}`);
        if (doLoja.some(v => v.entregue)) item.peca_ok_frenet = true;
        item.peca_ok = naoEnviado || !!chegou || !!(r2 && r2.entregue) || !!(api && api.entregue) || (doLoja.length > 0 && doLoja.every(v => v.entregue));
        if (naoEnviado) item.peca = 'o pedido não foi enviado, não tem peça para voltar';
        else if (chegou) item.peca = `a peça já voltou e foi conferida (${dia(chegou.chegou_em)})`;
        else if (r2 && r2.entregue) item.peca = `a Frenet mostra a devolução entregue na loja ${dia(r2.entregue_em)}, falta conferir a peça`;
        else if (api && api.entregue) item.peca = `a Frenet mostra a devolução ${codDev[0]} entregue em ${api.entregue_em}, falta conferir a peça`;
        else if ((r2 && r2.postado) || (api && api.eventos)) item.peca = `a devolução ${codDev[0] || ''} está a caminho (${api && api.ultimo ? api.ultimo : 'postada ' + dia(r2 && r2.postado_visto_em)}), ainda não chegou`;
        else if (codDev.length) item.peca = `a Frenet não mostra movimento da devolução ${codDev[0]}: a peça não voltou`;
        else if (doLoja.length) item.peca = 'veja abaixo as etiquetas de devolução dela na Frenet';
        else {
          item.peca = 'não há código de devolução: a Frenet não tem como confirmar que a peça voltou';
          item.valor_origem += ' (pedido inteiro: se voltarem só algumas peças, o valor é menor)';
        }
      }
    } catch (e) { item.erro = e.message; }
    out.push(item);
  }
  return { estornos: out };
}
async function valorDoEstorno(env, casoId) {
  const id = String(casoId || '').replace(/\D/g, '');
  if (!id) return { erro: 'qual caso?' };
  const caso = (await sb(env).get(`wati_sac_casos?id=eq.${id}&select=pedido`))[0];
  const n = ((String((caso && caso.pedido) || '').match(/\d{4,}/) || [])[0]) || '';
  if (!n) return { valor: null, origem: 'o caso não tem pedido ligado, a Bárbara confere o valor' };
  try {
    const est = (((await sb(env, true).get('vc_modelos?id=eq.estorno&select=dados'))[0] || {}).dados || {}).itens || [];
    const re = new RegExp('(#|pedido\\s+#?)\\s?' + n + '(?!\\d)');
    const cards = est.filter(t => t && re.test(String(t.pecas || '')) && t.etapa !== 'concluido' && Number(t.valor) > 0);
    if (cards.length) {
      const v = Math.round(cards.reduce((s2, t) => s2 + Number(t.valor), 0) * 100) / 100;
      return { valor: v, pedido: '#' + n, origem: `soma das ${cards.length} peça${cards.length > 1 ? 's' : ''} da devolução do pedido #${n} (valor pago)` };
    }
  } catch (_) {}
  const o = await pedidoBruto(env, n).catch(() => null);
  if (!o) return { valor: null, pedido: '#' + n, origem: 'não achei o pedido na Shopify, a Bárbara confere o valor' };
  const estornado = (o.refunds || []).reduce((s2, r) => s2 + (r.transactions || []).filter(x => x.kind === 'refund' && x.status === 'success').reduce((a3, x) => a3 + (parseFloat(x.amount) || 0), 0), 0);
  const v = Math.round((parseFloat(o.total_price) - estornado) * 100) / 100;
  return { valor: v > 0 ? v : 0, pedido: o.name, origem: `total pago no pedido ${o.name}${estornado ? ` menos R$ ${estornado.toFixed(2).replace('.', ',')} já estornado` : ''}` };
}
// Uma conversa lida pela IA: a cliente ainda espera resposta ou ação da loja? (13/11/2026)
// Haiku 5.5 pensa antes de responder: com 300 tokens só vinha o raciocínio e nenhum JSON (14/11/2026, a fila parou
// de ler conversas desde 01h). Teto maior e esforço baixo nos dois juízes: a pergunta é simples.
async function julgarEspera(env, msgs, caso, fatos) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODELO, max_tokens: 2500, output_config: { effort: 'low' }, system: JUIZ_FILA, messages: [{ role: 'user', content: conversaParaJuiz(msgs, caso, fatos) }] }),
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return lerJuizo(((j && j.content) || []).filter(b => b.type === 'text').map(b => b.text).join(''));
}

let _erroConferir = null;
async function julgarConferir(env, msgs, caso, fatos) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODELO, max_tokens: 2500, output_config: { effort: 'low' }, system: JUIZ_CONFERIR, messages: [{ role: 'user', content: conversaParaJuiz(msgs, caso, fatos) }] }),
  });
  if (!r.ok) { _erroConferir = 'IA ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 120); return null; }
  const j = await r.json().catch(() => null);
  const txt = ((j && j.content) || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const lido = lerConferir(txt);
  if (!lido) _erroConferir = 'resposta da IA sem JSON: ' + txt.slice(0, 120) + ' | ' + JSON.stringify({ stop: j && j.stop_reason, tipos: ((j && j.content) || []).map(b => b.type), uso: j && j.usage && j.usage.output_tokens });
  return lido;
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
    if (u.searchParams.get('fila')) return J(await filaEquipe(env));
    if (u.searchParams.get('valor_estorno')) return J(await valorDoEstorno(env, u.searchParams.get('valor_estorno')));
    if (u.searchParams.get('estornos')) return J(await estornosDaBarbara(env));
    if (u.searchParams.get('aprovacoes')) {
      return J({ so_leitura: soLeitura(env), aprovacoes: log.aprovacoes.slice(-60).reverse() });
    }
    // contagem no botão "Casos em aberto" já ao abrir a aba (Bárbara, 30/10/2026); só os ids, leve
    const casosAbertos = await sb(env).get('wati_sac_casos?status=eq.aberto&select=id&limit=1000').then(l => l.length).catch(() => null);
    return J({ so_leitura: soLeitura(env), tem_chave: !!env.ANTHROPIC_API_KEY, casos_abertos: casosAbertos,
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
