// Resgate de pedido barrado no cartão (11/09/2026).
//
// POR QUE ISTO EXISTE: desde que o Mercado Pago virou o único gateway de cartão (20/08/2026),
// o antifraude dele barra ~8% das tentativas ("Protegemos você de um pagamento suspeito"),
// em cliente real. Quem é avisado a tempo troca de caminho e paga (3 de 7 pagaram sozinhos
// em menos de 15 min); quem não é, some — 3 pedidos e R$1.449 perdidos só em setembro.
//
// O FLUXO
//   1. Shopify avisa (webhook orders/updated) → /api/webhook-shopify-pedido
//   2. O pedido é RELIDO na API (o payload do webhook é só um aviso, nunca a verdade) e
//      só segue se: não pago, não cancelado, cartão do MP recusado, tem telefone, e ainda
//      sem a tag `cartao-barrado-avisado`.
//   3. Um documento `cb:<orderId>` é INSERIDO no Supabase. Insert sem merge é a trava:
//      o segundo webhook do mesmo pedido leva 409 e para. (O orders/updated dispara em
//      cada tentativa da cliente e no e-mail de falha, às vezes no mesmo segundo.)
//   4. Gera um link de pagamento por OUTRO caminho: Pagar.me (outro adquirente, outro
//      antifraude) e, se ele falhar, Checkout Pro do Mercado Pago (mesmo antifraude, mas a
//      cliente pode entrar na conta dela, o que baixa o risco).
//   5. Agenda o template no Wati pra +5 min. Quem ainda está tentando (1 dos 7 passou na
//      5ª tentativa) não recebe mensagem no meio do caminho; o texto do template tem a
//      linha "se já deu certo, desconsidere" pra quem pagou nesse intervalo.
//   6. Marca a tag no pedido da Shopify.
//   7. Quando o link é pago, o postback do Pagar.me/MP bate em /api/webhook-pagarme ou
//      /api/webhook-mp; o pagamento é RELIDO na API do provedor (o postback também é só um
//      aviso) e, batendo valor e pedido, o pedido é marcado como pago na Shopify, com a tag
//      `pago-link-pagarme` ou `pago-link-mp` — o Financeiro precisa disso pra saber que a
//      taxa desse pedido não é a do gateway "manual".
//
// MODOS (env CARTAO_BARRADO_ATIVO)
//   ausente/'0' → observar: registra o caso no Supabase e para. Serve pra ver a detecção
//                 funcionando antes de mandar qualquer mensagem.
//   '1'         → ativo: link + Wati + tag.
//
// Prefixo "_" faz o Pages não tratar o arquivo como rota. Sem dependência de runtime
// além de fetch/crypto.subtle, pra ser importável nos testes em Node.

export const TAG_AVISADO = 'cartao-barrado-avisado';
export const TAG_PAGO_PAGARME = 'pago-link-pagarme';
export const TAG_PAGO_MP = 'pago-link-mp';
export const PREFIXO_DOC = 'cb:';
export const API_VERSION = '2024-04';
export const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
export const WATI_URL = 'https://live-mt-server.wati.io/api/ext/v3';

// Condições do link de resgate. Sem juros até 2x acompanha o checkout de hoje (o MP
// desligou o 3x em 27/08/2026); juros acima disso vão pra cliente. Tudo sobrescrevível
// por env, pra dona mudar sem deploy.
export const PADRAO = {
  parcelasSemJuros: 2,
  parcelasMax: 12,
  jurosPct: 2.99,          // ao mês, só nas parcelas acima do sem-juros
  linkValidoMin: 1440,     // 24h — depois disso a cliente fala com o time
  atrasoMin: 5,            // espera antes do WhatsApp (a dona pediu 5, 11/09/2026)
  janelaPedidoH: 24,       // webhook só olha pedido criado nas últimas 24h
  template: 'cartao_resgate_v1',
};

const enc = new TextEncoder();

// Comparação em tempo constante — a mesma ideia do `igual` do _middleware.
export function igual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function config(env) {
  const n = (v, p) => { const x = parseFloat(v); return Number.isFinite(x) ? x : p; };
  return {
    ativo: String(env.CARTAO_BARRADO_ATIVO || '') === '1',
    parcelasSemJuros: n(env.RESGATE_PARCELAS_SEM_JUROS, PADRAO.parcelasSemJuros),
    parcelasMax: n(env.RESGATE_PARCELAS_MAX, PADRAO.parcelasMax),
    jurosPct: n(env.RESGATE_JUROS_PCT, PADRAO.jurosPct),
    linkValidoMin: n(env.RESGATE_LINK_VALIDO_MIN, PADRAO.linkValidoMin),
    atrasoMin: n(env.CARTAO_BARRADO_ATRASO_MIN, PADRAO.atrasoMin),
    janelaPedidoH: n(env.CARTAO_BARRADO_JANELA_H, PADRAO.janelaPedidoH),
    template: env.CARTAO_BARRADO_TEMPLATE || PADRAO.template,
    base: (env.PUBLIC_BASE_URL || 'https://vistaconecte.pages.dev').replace(/\/$/, ''),
  };
}

// ── Shopify ──────────────────────────────────────────────────────────────────

export async function verificarHmacShopify(rawBody, header, secret) {
  if (!secret || !header) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, rawBody);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return igual(b64, header);
}

export function shopify(env) {
  const store = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  const rest = async (path) => {
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/${path}`, { headers: H });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Shopify ${r.status} em ${path}: ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  };
  const gql = async (query, variables) => {
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, { method: 'POST', headers: H, body: JSON.stringify({ query, variables }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(j.errors || j).slice(0, 300)}`);
    return j.data;
  };
  return {
    pedido: id => rest(`orders/${id}.json?fields=id,name,created_at,cancelled_at,financial_status,total_price,currency,email,phone,customer,billing_address,shipping_address,tags,payment_gateway_names,line_items`).then(j => j.order),
    transacoes: id => rest(`orders/${id}/transactions.json`).then(j => j.transactions || []),
    async porNome(nome) {
      const n = String(nome).replace(/^#/, '');
      const j = await rest(`orders.json?status=any&name=${encodeURIComponent('#' + n)}&fields=id,name`);
      return (j.orders || []).find(o => o.name === '#' + n) || null;
    },
    async addTags(id, tags) {
      const d = await gql(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
        { id: `gid://shopify/Order/${id}`, tags });
      const e = d.tagsAdd.userErrors;
      if (e.length) throw new Error('tagsAdd: ' + e.map(x => x.message).join('; '));
    },
    async marcarPago(id) {
      const d = await gql(`mutation($id: ID!) { orderMarkAsPaid(input: { id: $id }) { order { id displayFinancialStatus } userErrors { field message } } }`,
        { id: `gid://shopify/Order/${id}` });
      const e = d.orderMarkAsPaid.userErrors;
      if (e.length) throw new Error('orderMarkAsPaid: ' + e.map(x => x.message).join('; '));
      return d.orderMarkAsPaid.order.displayFinancialStatus;
    },
    webhooks: () => rest('webhooks.json').then(j => j.webhooks || []),
    async criarWebhook(topic, address) {
      const r = await fetch(`https://${store}/admin/api/${API_VERSION}/webhooks.json`, { method: 'POST', headers: H, body: JSON.stringify({ webhook: { topic, address, format: 'json' } }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`criar webhook ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
      return j.webhook;
    },
    async removerWebhook(id) {
      const r = await fetch(`https://${store}/admin/api/${API_VERSION}/webhooks/${id}.json`, { method: 'DELETE', headers: H });
      if (!r.ok) throw new Error(`remover webhook ${r.status}`);
    },
    escopos: () => fetch(`https://${store}/admin/oauth/access_scopes.json`, { headers: H }).then(r => r.json()).then(j => (j.access_scopes || []).map(x => x.handle)),
  };
}

// ── Diagnóstico do pedido: é caso de resgate? ────────────────────────────────
// Puro (sem rede) pra ser testável. Devolve { resgatar, motivo, ... }.

export function telefoneWhatsapp(pedido) {
  const cands = [pedido.phone, pedido.customer && pedido.customer.phone,
    pedido.shipping_address && pedido.shipping_address.phone,
    pedido.billing_address && pedido.billing_address.phone];
  for (const c of cands) {
    if (!c) continue;
    let d = String(c).replace(/\D/g, '');
    if (d.startsWith('0')) d = d.replace(/^0+/, '');
    if ((d.length === 10 || d.length === 11) && !d.startsWith('55')) d = '55' + d;
    if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d;
  }
  return null;
}

export function primeiroNome(pedido) {
  const c = pedido.customer || {};
  const s = pedido.shipping_address || {};
  const bruto = c.first_name || (s.name || s.first_name || '').split(' ')[0] || '';
  const n = bruto.trim().split(/\s+/)[0] || '';
  return n ? n[0].toUpperCase() + n.slice(1).toLowerCase() : 'cliente';
}

export function diagnosticar(pedido, transacoes, { janelaH = PADRAO.janelaPedidoH, agora = Date.now(), ignorarJanela = false } = {}) {
  const tags = String(pedido.tags || '').split(',').map(s => s.trim()).filter(Boolean);
  const aprovada = transacoes.some(t => t.status === 'success' && (t.kind === 'sale' || t.kind === 'capture'));
  const recusas = transacoes.filter(t => (t.status === 'failure' || t.status === 'error') && /Cart/i.test(t.gateway || ''));
  const antifraude = recusas.some(t => /suspeito/i.test(t.message || ''));
  const idadeH = (agora - new Date(pedido.created_at).getTime()) / 3600e3;
  // Qual gateway recusou decide por onde vai o resgate: barrou no MP, o link sai pelo
  // Pagar.me; barrou no Pagar.me (se um dia voltar a ser o principal), o link sai pelo MP.
  const gateway = recusas.length ? (recusas[recusas.length - 1].gateway || '') : '';
  const base = {
    pedido: pedido.name, order_id: pedido.id, total: parseFloat(pedido.total_price),
    tentativas: recusas.length, antifraude, gateway, telefone: telefoneWhatsapp(pedido), nome: primeiroNome(pedido),
  };
  const nao = motivo => ({ ...base, resgatar: false, motivo });
  if (pedido.cancelled_at) return nao('pedido cancelado');
  if (['paid', 'refunded', 'partially_refunded', 'partially_paid', 'authorized'].includes(pedido.financial_status) || aprovada) return nao('já pago');
  if (tags.includes(TAG_AVISADO)) return nao('já avisado');
  if (!recusas.length) return nao('sem recusa de cartão');
  if (!ignorarJanela && idadeH > janelaH) return nao(`pedido com mais de ${janelaH}h`);
  if (!base.telefone) return nao('sem telefone');
  if (!(base.total > 0)) return nao('total zerado');
  const onde = /Pagar/i.test(gateway) ? 'Pagar.me' : 'Mercado Pago';
  return { ...base, resgatar: true, motivo: antifraude ? `antifraude do ${onde}` : `cartão recusado no ${onde}` };
}

// ── Supabase: documento por pedido (trava + registro) ────────────────────────

// A chave de SERVIÇO não alcança a vc_modelos (11/09/2026: "permission denied for table
// vc_modelos", o service_role só tem privilégio no schema `modelagem`). A vc_modelos é lida e
// gravada pela chave anon — a mesma que o main.js usa, pública por natureza —, guardada no
// Pages como SUPABASE_ANON_KEY pra não duplicar o valor no código das functions.
export function chaveSupabase(env) {
  return env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function sbHeaders(env, extra) {
  const k = chaveSupabase(env);
  return { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json', ...(extra || {}) };
}

export const docId = orderId => PREFIXO_DOC + orderId;

// Insert SEM merge-duplicates: se o documento já existe o banco responde 409 e quem chegou
// depois desiste. É isso que impede duas mensagens pro mesmo pedido.
export async function travar(env, orderId, dados) {
  const r = await fetch(`${SB_URL}/rest/v1/vc_modelos`, {
    method: 'POST', headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ id: docId(orderId), dados }),
  });
  if (r.status === 409) return false;
  if (!r.ok) throw new Error(`Supabase insert ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return true;
}

export async function lerDoc(env, orderId) {
  const r = await fetch(`${SB_URL}/rest/v1/vc_modelos?id=eq.${encodeURIComponent(docId(orderId))}&select=dados`, { headers: sbHeaders(env) });
  if (!r.ok) throw new Error(`Supabase get ${r.status}`);
  const rows = await r.json();
  return rows[0] ? rows[0].dados : null;
}

export async function gravarDoc(env, orderId, dados) {
  const r = await fetch(`${SB_URL}/rest/v1/vc_modelos?id=eq.${encodeURIComponent(docId(orderId))}`, {
    method: 'PATCH', headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ dados: { ...dados, atualizado: new Date().toISOString() } }),
  });
  if (!r.ok) throw new Error(`Supabase patch ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

export async function listarDocs(env, limite = 50) {
  const r = await fetch(`${SB_URL}/rest/v1/vc_modelos?id=like.${encodeURIComponent(PREFIXO_DOC + '*')}&select=id,dados,updated_at&order=updated_at.desc&limit=${limite}`, { headers: sbHeaders(env) });
  if (!r.ok) throw new Error(`Supabase list ${r.status}`);
  return r.json();
}

// ── Links de resgate ─────────────────────────────────────────────────────────

export function centavos(v) { return Math.round(parseFloat(v) * 100); }

export function urlPostback(cfg, env, rota, orderId) {
  return `${cfg.base}/api/${rota}?pedido=${orderId}&k=${encodeURIComponent(env.WEBHOOK_KEY || '')}`;
}

// Pagar.me v4 (api.pagar.me/1). Um link, um pedido, 24h. A tentativa de pagamento pelo link
// chega no postback de TRANSAÇÃO com ?pedido=<id da Shopify> na URL — é assim que o
// pagamento acha o pedido de volta sem depender de campo nenhum do corpo.
export async function linkPagarme(env, cfg, diag) {
  const sk = env.PAGARME_SECRET_KEY;
  if (!sk) throw new Error('PAGARME_SECRET_KEY ausente');
  const valor = centavos(diag.total);
  const postback = urlPostback(cfg, env, 'webhook-pagarme', diag.order_id);
  const body = {
    api_key: sk, amount: valor, name: `Pedido ${diag.pedido}`,
    items: [{ id: String(diag.order_id), title: `Pedido ${diag.pedido} - Vista Conecte`, unit_price: valor, quantity: 1, tangible: true }],
    payment_config: {
      boleto: { enabled: false },
      credit_card: { enabled: true, free_installments: cfg.parcelasSemJuros, max_installments: cfg.parcelasMax, interest_rate: cfg.jurosPct },
      default_payment_method: 'credit_card',
    },
    expires_in: cfg.linkValidoMin, max_orders: 1,
    postback_config: { transactions: postback, orders: postback },
  };
  const r = await fetch('https://api.pagar.me/1/payment_links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) throw new Error(`Pagar.me ${r.status}: ${JSON.stringify(j).replace(/api_key=[^&"\s]+/g, 'api_key=***').slice(0, 300)}`);
  return { provedor: 'pagarme', id: j.id, url: j.url, expira: j.expires_at || null };
}

// Mercado Pago Checkout Pro: preferência com external_reference = id do pedido. A
// notificação também leva ?pedido= na URL; a verificação real é reler o pagamento.
export async function linkMercadoPago(env, cfg, diag, pedido) {
  const token = env.MP_ACCESS_TOKEN;
  if (!token) throw new Error('MP_ACCESS_TOKEN ausente');
  const ate = new Date(Date.now() + cfg.linkValidoMin * 60e3);
  const tel = diag.telefone || '';
  const body = {
    items: [{ id: String(diag.order_id), title: `Pedido ${diag.pedido} - Vista Conecte`, quantity: 1, unit_price: Number(diag.total.toFixed(2)), currency_id: 'BRL' }],
    payer: {
      name: (pedido.customer && pedido.customer.first_name) || diag.nome,
      surname: (pedido.customer && pedido.customer.last_name) || '',
      email: pedido.email || undefined,
      phone: tel ? { area_code: tel.slice(2, 4), number: tel.slice(4) } : undefined,
    },
    external_reference: String(diag.order_id),
    notification_url: urlPostback(cfg, env, 'webhook-mp', diag.order_id),
    payment_methods: { excluded_payment_types: [{ id: 'ticket' }], installments: cfg.parcelasMax },
    expires: true, expiration_date_to: ate.toISOString().replace('Z', '-00:00'),
    statement_descriptor: 'VISTA CONECTE',
    metadata: { shopify_order_id: String(diag.order_id), pedido: diag.pedido },
  };
  const r = await fetch('https://api.mercadopago.com/checkout/preferences', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.init_point) throw new Error(`Mercado Pago ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return { provedor: 'mp', id: j.id, url: j.init_point, expira: j.expiration_date_to || null };
}

// O OUTRO provedor primeiro (outro antifraude); o que barrou fica de reserva, caso o
// primeiro falhe por qualquer motivo (chave inválida, conta com pendência, API fora).
export function ordemProvedores(gateway) {
  return /Pagar/i.test(gateway || '') ? ['mp', 'pagarme'] : ['pagarme', 'mp'];
}

export async function gerarLink(env, cfg, diag, pedido) {
  const erros = [];
  for (const p of ordemProvedores(diag.gateway)) {
    try {
      const link = p === 'pagarme' ? await linkPagarme(env, cfg, diag) : await linkMercadoPago(env, cfg, diag, pedido);
      return { link, erros };
    } catch (e) { erros.push(`${p}: ${e.message}`); }
  }
  return { link: null, erros };
}

// ── Wati ─────────────────────────────────────────────────────────────────────

function watiHeaders(env) {
  return { Authorization: 'Bearer ' + env.WATI_TOKEN, 'Content-Type': 'application/json' };
}

export async function templateWati(env, nome) {
  const r = await fetch(`${WATI_URL}/messagetemplates?pageSize=100`, { headers: watiHeaders(env) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Wati ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return (j.templates || []).find(t => (t.elementName || t.name) === nome) || null;
}

// Os nomes dos parâmetros são os que a dona deu ao criar o template no painel. Quem se chama
// nome/name recebe o nome, pedido/order o número do pedido, link/url o link — em qualquer
// ordem. Nome que não diz nada cai na ordem: nome, pedido, link.
export function paramsWati(template, valores) {
  const nomes = (template.custom_params || template.customParams || []).map(p => p.name || p.paramName);
  const porNome = [/nome|name/i, /pedido|order/i, /link|url/i];
  const v = valores.map(x => (x == null ? '' : String(x)));
  return nomes.map((name, i) => {
    const idx = porNome.findIndex(re => re.test(name));
    return { name, value: idx >= 0 ? v[idx] : (v[i] || '') };
  });
}

export async function agendarWati(env, cfg, diag, link, template) {
  const quando = new Date(Date.now() + cfg.atrasoMin * 60e3).toISOString();
  const body = {
    template_name: cfg.template,
    broadcast_name: `resgate-${diag.pedido.replace('#', '')}-${Date.now()}`,
    scheduled_at: quando,
    recipients: [{ phone_number: diag.telefone, custom_params: paramsWati(template, [diag.nome, diag.pedido, link.url]) }],
  };
  const r = await fetch(`${WATI_URL}/messagetemplates/schedule`, { method: 'POST', headers: watiHeaders(env), body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`Wati agendar ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return { broadcast_id: j.broadcast_id || null, agendado_para: quando };
}

// ── Pipeline ─────────────────────────────────────────────────────────────────
// Devolve o registro gravado (ou o motivo de não ter feito nada). Nunca lança: erro vira
// campo `erros` no documento, pra ser lido em /api/cartao-barrado?acao=casos.

export async function processarPedido(env, orderId, { forcar = false, ignorarJanela = false } = {}) {
  const cfg = config(env);
  const sh = shopify(env);
  const [pedido, transacoes] = await Promise.all([sh.pedido(orderId), sh.transacoes(orderId)]);
  const diag = diagnosticar(pedido, transacoes, { janelaH: cfg.janelaPedidoH, ignorarJanela });
  if (!diag.resgatar) return { feito: false, ...diag };

  const doc = {
    pedido: diag.pedido, order_id: diag.order_id, criado: pedido.created_at, cliente: diag.nome,
    telefone: diag.telefone, total: diag.total, motivo: diag.motivo, tentativas: diag.tentativas,
    modo: cfg.ativo ? 'ativo' : 'observar', status: 'detectado', erros: [], detectado_em: new Date().toISOString(),
  };
  const novo = await travar(env, orderId, doc);
  if (!novo && !forcar) return { feito: false, ...diag, motivo: 'já em andamento (trava)' };

  if (!cfg.ativo) { doc.status = 'observado'; await gravarDoc(env, orderId, doc); return { feito: true, ...doc }; }

  try {
    const template = await templateWati(env, cfg.template);
    if (!template) throw new Error(`template "${cfg.template}" não existe no Wati`);
    if (String(template.status).toLowerCase() !== 'approved') throw new Error(`template "${cfg.template}" está "${template.status}", não aprovado`);

    const { link, erros } = await gerarLink(env, cfg, diag, pedido);
    doc.erros.push(...erros);
    if (!link) throw new Error('nenhum provedor gerou link');
    doc.link = link;

    doc.wati = await agendarWati(env, cfg, diag, link, template);
    doc.status = 'agendado';
    await sh.addTags(orderId, [TAG_AVISADO]);
    doc.tag = true;
  } catch (e) {
    doc.erros.push(e.message);
    doc.status = doc.status === 'agendado' ? 'agendado-sem-tag' : 'erro';
  }
  await gravarDoc(env, orderId, doc);
  return { feito: doc.status === 'agendado', ...doc };
}

// Tentativa no link que NÃO virou pagamento (recusada de novo, pendente, estornada): fica no
// documento pra dona ver que a cliente tentou, e por onde.
export async function registrarEvento(env, orderId, ev) {
  const doc = (await lerDoc(env, orderId)) || { pedido: '?', order_id: orderId, erros: [] };
  doc.eventos = [...(doc.eventos || []), { ...ev, em: new Date().toISOString() }].slice(-30);
  await gravarDoc(env, orderId, doc);
  return doc;
}

// Chamado pelos postbacks depois de RELER o pagamento no provedor. Só marca pago se o valor
// bate com o pedido (em centavos) e o pedido ainda não está pago.
export async function confirmarPagamento(env, orderId, { provedor, pagamento_id, valorCentavos, bruto }) {
  const sh = shopify(env);
  const doc = (await lerDoc(env, orderId)) || { pedido: '?', order_id: orderId, erros: [] };
  const pedido = await sh.pedido(orderId);
  const esperado = centavos(pedido.total_price);
  const reg = { provedor, pagamento_id, valor: valorCentavos / 100, em: new Date().toISOString(), bruto };
  doc.pagamentos = [...(doc.pagamentos || []), reg];
  if (valorCentavos !== esperado) {
    doc.erros.push(`valor pago ${valorCentavos} ≠ pedido ${esperado} (${provedor} ${pagamento_id})`);
    doc.status = 'pago-valor-diferente';
    await gravarDoc(env, orderId, doc);
    return { ok: false, motivo: 'valor diferente', doc };
  }
  if (['paid', 'partially_refunded', 'refunded'].includes(pedido.financial_status)) {
    doc.status = 'pago';
    await gravarDoc(env, orderId, doc);
    return { ok: true, motivo: 'já estava pago', doc };
  }
  try {
    const st = await sh.marcarPago(orderId);
    await sh.addTags(orderId, [provedor === 'pagarme' ? TAG_PAGO_PAGARME : TAG_PAGO_MP]);
    doc.status = 'pago'; doc.pago_em = reg.em; doc.shopify_status = st;
  } catch (e) {
    doc.erros.push('marcar pago: ' + e.message);
    doc.status = 'pago-conferir';   // dinheiro entrou, Shopify não aceitou: o time marca à mão
  }
  await gravarDoc(env, orderId, doc);
  return { ok: doc.status === 'pago', motivo: doc.status, doc };
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}
