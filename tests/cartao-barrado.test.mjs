/**
 * Teste do resgate de cartão barrado (functions/_cartao-barrado.js + webhooks).
 *
 * POR QUE ISTO EXISTE: desde 20/08/2026 o antifraude do Mercado Pago barra ~8% dos cartões
 * em cliente real, e quem não é avisado a tempo some (R$1.449 perdidos só em setembro).
 * A automação manda um link por outro caminho pelo WhatsApp. Errar aqui é mandar mensagem
 * pra quem pagou, mandar duas vezes, ou marcar pedido como pago com valor errado — por
 * isso a decisão (diagnosticar) e o pipeline inteiro rodam aqui com rede de mentira.
 *
 * Rodar:  node tests/cartao-barrado.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHmac } from 'node:crypto';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = await import('../functions/_cartao-barrado.js');
const { descartarPeloCorpo } = await import('../functions/api/webhook-shopify-pedido.js');
const { lerCorpo } = await import('../functions/api/webhook-pagarme.js');
const { extrairPagamento } = await import('../functions/api/webhook-mp.js');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

// ── pedido de mentira, com a cara do #9057 (Juliana, 11/09/2026) ─────────────
const agora = Date.parse('2026-09-11T12:30:00Z');
const pedido = (extra = {}) => ({
  id: 7732224786541, name: '#9057', created_at: '2026-09-11T09:06:24-03:00', cancelled_at: null,
  financial_status: 'pending', total_price: '305.40', currency: 'BRL', email: 'j@x.com', phone: null,
  customer: { first_name: 'JULIANA', last_name: 'Kegler', phone: '+55 21 98888-7777' },
  shipping_address: { name: 'Juliana Kegler', phone: null }, billing_address: null, tags: '',
  payment_gateway_names: ['Mercado Pago Cartões'], line_items: [], ...extra,
});
const recusaMP = { kind: 'sale', status: 'failure', gateway: 'Mercado Pago Cartões', message: 'Erro de Mercado Pago Cartões: Protegemos você de um pagamento suspeito.', created_at: '2026-09-11T09:06:16-03:00' };
const pixPendente = { kind: 'sale', status: 'pending', gateway: 'Mercado Pago Pix', message: 'Pagamento pendente do comprador' };
const venda = { kind: 'sale', status: 'success', gateway: 'Mercado Pago Cartões' };

console.log('\ndiagnosticar');
{
  const d = lib.diagnosticar(pedido(), [recusaMP, recusaMP, recusaMP], { agora });
  ok('barrado no MP com telefone → resgatar', [d.resgatar, d.motivo, d.tentativas, d.antifraude], [true, 'antifraude do Mercado Pago', 3, true]);
  ok('telefone vira 55DDDNNNNNNNNN', d.telefone, '5521988887777');
  ok('nome sai capitalizado', d.nome, 'Juliana');
  ok('total como número', d.total, 305.4);
  ok('gateway que recusou', d.gateway, 'Mercado Pago Cartões');
}
ok('pago (financial_status) → não', lib.diagnosticar(pedido({ financial_status: 'paid' }), [recusaMP, venda], { agora }).motivo, 'já pago');
ok('pago (transação success) mesmo pending → não', lib.diagnosticar(pedido(), [recusaMP, venda], { agora }).motivo, 'já pago');
ok('cancelado → não', lib.diagnosticar(pedido({ cancelled_at: '2026-09-11T10:00:00-03:00' }), [recusaMP], { agora }).motivo, 'pedido cancelado');
ok('já avisado (tag) → não', lib.diagnosticar(pedido({ tags: 'vip, cartao-barrado-avisado' }), [recusaMP], { agora }).motivo, 'já avisado');
ok('Pix pendente sem recusa de cartão → não', lib.diagnosticar(pedido({ payment_gateway_names: ['Mercado Pago Pix'] }), [pixPendente], { agora }).motivo, 'sem recusa de cartão');
ok('pedido velho (>24h) → não', lib.diagnosticar(pedido({ created_at: '2026-09-09T09:06:24-03:00' }), [recusaMP], { agora }).motivo, 'pedido com mais de 24h');
ok('pedido velho com ignorarJanela → resgatar', lib.diagnosticar(pedido({ created_at: '2026-09-02T09:06:24-03:00' }), [recusaMP], { agora, ignorarJanela: true }).resgatar, true);
ok('sem telefone → não', lib.diagnosticar(pedido({ customer: { first_name: 'Ana' } }), [recusaMP], { agora }).motivo, 'sem telefone');
ok('recusa sem "suspeito" ainda resgata, motivo diferente', lib.diagnosticar(pedido(), [{ ...recusaMP, message: 'Erro: fundos insuficientes' }], { agora }).motivo, 'cartão recusado no Mercado Pago');
ok('barrado no Pagar.me → motivo diz Pagar.me', lib.diagnosticar(pedido({ payment_gateway_names: ['Pagar.me - Cartão de Crédito'] }), [{ ...recusaMP, gateway: 'Pagar.me - Cartão de Crédito' }], { agora }).motivo, 'antifraude do Pagar.me');

console.log('\ntelefoneWhatsapp');
ok('(21) 99999-8888 → 5521999998888', lib.telefoneWhatsapp({ phone: '(21) 99999-8888' }), '5521999998888');
ok('fixo com 10 dígitos ganha 55', lib.telefoneWhatsapp({ phone: '21 3333-4444' }), '552133334444');
ok('já com 55 fica', lib.telefoneWhatsapp({ phone: '+55 (11) 91234-5678' }), '5511912345678');
ok('zero à esquerda some', lib.telefoneWhatsapp({ phone: '021 99999-8888' }), '5521999998888');
ok('lixo → null', lib.telefoneWhatsapp({ phone: '123' }), null);
ok('cai pro endereço de entrega', lib.telefoneWhatsapp({ phone: null, customer: {}, shipping_address: { phone: '48 98888-1111' } }), '5548988881111');

console.log('\nordem dos provedores');
ok('barrou no MP → Pagar.me primeiro', lib.ordemProvedores('Mercado Pago Cartões'), ['pagarme', 'mp']);
ok('barrou no Pagar.me → MP primeiro', lib.ordemProvedores('Pagar.me - Cartão de Crédito'), ['mp', 'pagarme']);
ok('centavos sem erro de ponto flutuante', lib.centavos('305.40'), 30540);
ok('config: modo observar por padrão', lib.config({}).ativo, false);
ok('config: ATIVO=1 liga', lib.config({ CARTAO_BARRADO_ATIVO: '1' }).ativo, true);
ok('config: env sobrescreve parcelas', lib.config({ RESGATE_PARCELAS_SEM_JUROS: '3' }).parcelasSemJuros, 3);

console.log('\nassinatura do webhook da Shopify');
{
  const segredo = 'shpss_teste', corpo = '{"id":1,"name":"#1"}';
  const raw = new TextEncoder().encode(corpo);
  const certo = createHmac('sha256', segredo).update(corpo).digest('base64');
  ok('assinatura certa passa', await lib.verificarHmacShopify(raw, certo, segredo), true);
  ok('assinatura errada não passa', await lib.verificarHmacShopify(raw, certo.slice(0, -2) + 'AA', segredo), false);
  ok('sem segredo não passa', await lib.verificarHmacShopify(raw, certo, ''), false);
  ok('igual é falso pra tamanhos diferentes', lib.igual('abc', 'abcd'), false);
}

console.log('\ndescarte barato pelo corpo do webhook');
ok('pago → pago', descartarPeloCorpo({ id: 1, financial_status: 'paid', payment_gateway_names: ['Mercado Pago Cartões'] }), 'pago');
ok('só Pix → sem cartão', descartarPeloCorpo({ id: 1, financial_status: 'pending', payment_gateway_names: ['Mercado Pago Pix'] }), 'sem cartão');
ok('com a tag → já avisado', descartarPeloCorpo({ id: 1, financial_status: 'pending', payment_gateway_names: ['Mercado Pago Cartões'], tags: 'cartao-barrado-avisado' }), 'já avisado');
ok('candidato → null (vai reler na API)', descartarPeloCorpo({ id: 1, financial_status: 'pending', payment_gateway_names: ['Mercado Pago Cartões'] }), null);

console.log('\ncorpo dos postbacks');
ok('Pagar.me form-urlencoded', lerCorpo('id=123&object=transaction&current_status=paid', 'application/x-www-form-urlencoded'), { id: '123', object: 'transaction', current_status: 'paid' });
ok('Pagar.me json', lerCorpo('{"id":"9","object":"transaction"}', 'application/json'), { id: '9', object: 'transaction' });
ok('MP webhook novo', extrairPagamento(new URLSearchParams('data.id=55&type=payment'), { type: 'payment', data: { id: 55 } }), { tipo: 'payment', id: '55' });
ok('MP IPN antigo', extrairPagamento(new URLSearchParams('topic=payment&id=77'), {}), { tipo: 'payment', id: '77' });
ok('MP merchant_order é ignorado pelo tipo', extrairPagamento(new URLSearchParams('topic=merchant_order&id=1'), {}).tipo, 'merchant_order');

console.log('\nparâmetros do template (na ordem: nome, pedido, link)');
ok('nomes vêm do template', lib.paramsWati({ custom_params: [{ name: 'first_name' }, { name: 'pedido' }, { name: 'link' }] }, ['Juliana', '#9057', 'https://x']),
  [{ name: 'first_name', value: 'Juliana' }, { name: 'pedido', value: '#9057' }, { name: 'link', value: 'https://x' }]);
ok('ordem trocada no template não troca os valores', lib.paramsWati({ custom_params: [{ name: 'link_pagamento' }, { name: 'nome' }] }, ['Juliana', '#9057', 'https://x']),
  [{ name: 'link_pagamento', value: 'https://x' }, { name: 'nome', value: 'Juliana' }]);
ok('nome que não diz nada cai na posição', lib.paramsWati({ custom_params: [{ name: 'a' }, { name: 'b' }] }, ['Juliana', '#9057', 'https://x']),
  [{ name: 'a', value: 'Juliana' }, { name: 'b', value: '#9057' }]);

console.log('\nmiddleware');
{
  const mw = readFileSync(join(raiz, 'functions/api/_middleware.js'), 'utf8');
  const bloco = mw.slice(mw.indexOf('const PUBLICO'), mw.indexOf(']);', mw.indexOf('const PUBLICO')));
  for (const r of ['/api/webhook-shopify-pedido', '/api/webhook-pagarme', '/api/webhook-mp', '/api/cartao-barrado'])
    ok(`${r} é público`, bloco.includes(`'${r}'`), true);
}

// ── pipeline inteiro com rede de mentira ─────────────────────────────────────
console.log('\npipeline (fetch de mentira)');
const chamadas = [];
function redeFalsa({ travaConflito = false, pagarmeFalha = false } = {}) {
  chamadas.length = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); const m = opts.method || 'GET';
    chamadas.push(`${m} ${u.replace(/\?.*$/, '')}`);
    const R = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
    // criado há 3 h, senão o pipeline (que usa o relógio de verdade) recusa por "mais de 24h"
    if (u.includes('/orders/7732224786541.json')) return R({ order: pedido({ created_at: new Date(Date.now() - 3 * 3600e3).toISOString() }) });
    if (u.includes('/orders/7732224786541/transactions.json')) return R({ transactions: [recusaMP, recusaMP] });
    if (u.includes('supabase.co/rest/v1/vc_modelos') && m === 'POST') return travaConflito ? new Response('dup', { status: 409 }) : new Response(null, { status: 201 });
    if (u.includes('supabase.co/rest/v1/vc_modelos') && m === 'PATCH') { chamadas.push('doc:' + JSON.parse(opts.body).dados.status); return new Response(null, { status: 204 }); }
    if (u.includes('wati.io') && u.includes('/messagetemplates?')) return R({ templates: [{ elementName: 'cartao_resgate_v1', status: 'approved', custom_params: [{ name: 'first_name' }, { name: 'pedido' }, { name: 'link' }] }] });
    if (u.includes('wati.io') && u.includes('/schedule')) { chamadas.push('wati:' + JSON.parse(opts.body).recipients[0].custom_params.map(p => p.value).join('|')); return R({ success: true, broadcast_id: 'b1' }); }
    if (u.includes('api.pagar.me/1/payment_links')) return pagarmeFalha ? R({ errors: [{ message: 'conta bloqueada' }] }, 401) : R({ id: 'pl_1', url: 'https://pagar.me/l/abc' });
    if (u.includes('mercadopago.com/checkout/preferences')) return R({ id: 'pref_1', init_point: 'https://mp.com/p/xyz' });
    if (u.includes('graphql.json')) { const b = JSON.parse(opts.body); chamadas.push('gql:' + (b.query.includes('tagsAdd') ? 'tagsAdd ' + b.variables.tags.join(',') : 'outro')); return R({ data: { tagsAdd: { userErrors: [] } } }); }
    throw new Error('fetch inesperado: ' + u);
  };
}
const env = { SHOPIFY_STORE_DOMAIN: 'loja.myshopify.com', SHOPIFY_ADMIN_TOKEN: 't', SUPABASE_ANON_KEY: 's', WATI_TOKEN: 'w', PAGARME_SECRET_KEY: 'ak', MP_ACCESS_TOKEN: 'mp', WEBHOOK_KEY: 'chave' };

{
  redeFalsa();
  const r = await lib.processarPedido(env, '7732224786541');
  ok('modo observar: registra e para', [r.feito, r.status, r.modo], [true, 'observado', 'observar']);
  ok('modo observar: nem Wati nem link nem tag', chamadas.some(c => c.includes('wati.io') || c.includes('pagar.me') || c.includes('graphql')), false);
}
{
  redeFalsa();
  const r = await lib.processarPedido({ ...env, CARTAO_BARRADO_ATIVO: '1' }, '7732224786541');
  ok('ativo: agendado com link do Pagar.me', [r.feito, r.status, r.link.provedor, r.link.url], [true, 'agendado', 'pagarme', 'https://pagar.me/l/abc']);
  ok('ativo: WhatsApp leva nome, pedido e link', chamadas.find(c => c.startsWith('wati:')), 'wati:Juliana|#9057|https://pagar.me/l/abc');
  ok('ativo: tag no pedido', chamadas.find(c => c.startsWith('gql:')), 'gql:tagsAdd cartao-barrado-avisado');
  ok('ativo: MP não foi chamado', chamadas.some(c => c.includes('mercadopago')), false);
}
{
  redeFalsa({ pagarmeFalha: true });
  const r = await lib.processarPedido({ ...env, CARTAO_BARRADO_ATIVO: '1' }, '7732224786541');
  ok('Pagar.me falhou → link do MP, erro anotado', [r.status, r.link.provedor, r.erros.length], ['agendado', 'mp', 1]);
}
{
  redeFalsa({ travaConflito: true });
  const r = await lib.processarPedido({ ...env, CARTAO_BARRADO_ATIVO: '1' }, '7732224786541');
  ok('segundo webhook do mesmo pedido leva 409 e desiste', [r.feito, r.motivo], [false, 'já em andamento (trava)']);
  ok('e não manda nada', chamadas.some(c => c.includes('wati.io')), false);
}
{
  redeFalsa();
  const r = await lib.processarPedido({ ...env, CARTAO_BARRADO_ATIVO: '1', CARTAO_BARRADO_TEMPLATE: 'nao_existe' }, '7732224786541');
  ok('template inexistente → erro registrado, sem tag', [r.status, r.erros[0].includes('não existe'), chamadas.some(c => c.includes('graphql'))], ['erro', true, false]);
}
{
  // Postback: pagamento relido com valor certo marca pago e etiqueta; valor errado não.
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); const m = opts.method || 'GET';
    chamadas.push(`${m} ${u.replace(/\?.*$/, '')}`);
    const R = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
    // criado há 3 h, senão o pipeline (que usa o relógio de verdade) recusa por "mais de 24h"
    if (u.includes('/orders/7732224786541.json')) return R({ order: pedido({ created_at: new Date(Date.now() - 3 * 3600e3).toISOString() }) });
    if (u.includes('supabase.co') && m === 'GET') return R([{ dados: { pedido: '#9057', order_id: 7732224786541, erros: [] } }]);
    if (u.includes('supabase.co') && m === 'PATCH') { chamadas.push('doc:' + JSON.parse(opts.body).dados.status); return new Response(null, { status: 204 }); }
    if (u.includes('graphql.json')) { const b = JSON.parse(opts.body); if (b.query.includes('orderMarkAsPaid')) { chamadas.push('gql:markPaid'); return R({ data: { orderMarkAsPaid: { order: { id: 'x', displayFinancialStatus: 'PAID' }, userErrors: [] } } }); } chamadas.push('gql:tagsAdd ' + b.variables.tags.join(',')); return R({ data: { tagsAdd: { userErrors: [] } } }); }
    throw new Error('fetch inesperado: ' + u);
  };
  chamadas.length = 0;
  const r1 = await lib.confirmarPagamento(env, '7732224786541', { provedor: 'pagarme', pagamento_id: '1', valorCentavos: 30540, bruto: {} });
  ok('valor bate → marca pago + tag pago-link-pagarme', [r1.ok, chamadas.includes('gql:markPaid'), chamadas.includes('gql:tagsAdd pago-link-pagarme')], [true, true, true]);
  chamadas.length = 0;
  const r2 = await lib.confirmarPagamento(env, '7732224786541', { provedor: 'mp', pagamento_id: '2', valorCentavos: 30000, bruto: {} });
  ok('valor diferente → não marca pago', [r2.ok, r2.motivo, chamadas.includes('gql:markPaid')], [false, 'valor diferente', false]);
}

console.log(falhas === 0 ? `\n✓ ${total}/${total} passaram\n` : `\n✗ ${falhas} de ${total} falharam\n`);
process.exit(falhas === 0 ? 0 : 1);
