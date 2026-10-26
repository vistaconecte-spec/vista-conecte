/**
 * Testes do /api/shopify-processar (robô processa o pedido na Shopify com o código da Frenet).
 *
 * POR QUE ISTO EXISTE: em 26/10/2026 a Bárbara pediu para o pedido ser processado sozinho
 * quando a etiqueta é paga, para a cliente receber o código. O que não pode acontecer: código
 * no pedido errado, processar pedido cancelado/sem pagamento/troca esperando peça, ou processar
 * de novo um pedido que a Manu já processou à mão.
 *
 * Rodar:  node tests/processar.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = await import(pathToFileURL(join(raiz, 'functions', 'api', 'shopify-processar.js')).href);
const fonte = readFileSync(join(raiz, 'functions', 'api', 'shopify-processar.js'), 'utf8');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) falhas++;
  console.log(`${bateu ? '  ✓' : '  ✗'} ${nome}${bateu ? '' : `\n      esperado ${JSON.stringify(esperado)}\n      veio     ${JSON.stringify(real)}`}`);
}

const pedido = (extra = {}) => ({
  name: '#9364', cancelledAt: null, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', tags: [],
  shippingAddress: { name: 'Maria da Silva Souza', city: 'São Paulo' }, fulfillments: [],
  fulfillmentOrders: { edges: [{ node: { id: 'gid://FO/1', status: 'OPEN', lineItems: { edges: [{ node: { remainingQuantity: 2 } }] } } }] },
  ...extra,
});
const et = { codigo: 'PVZK5BO4', nome: 'MARIA SOUZA', cidade: 'Sao Paulo' };

ok('pedido pago, sem envio, mesma pessoa → processar', api.avaliar(pedido(), et).acao, 'processar');
ok('conta as peças a enviar', api.avaliar(pedido(), et).itens, 2);
ok('já tem este código → ja_processado (não processa de novo)',
  api.avaliar(pedido({ displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ trackingInfo: [{ number: 'pvzk5bo4' }] }] }), et).acao, 'ja_processado');
ok('processado com outro código → pular', api.avaliar(pedido({ displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ trackingInfo: [{ number: 'XYZ12345' }] }] }), et).acao, 'pular');
ok('cancelado → pular', api.avaliar(pedido({ cancelledAt: '2026-10-20' }), et).acao, 'pular');
ok('pagamento pendente → pular', api.avaliar(pedido({ displayFinancialStatus: 'PENDING' }), et).acao, 'pular');
ok('reembolso parcial ainda envia', api.avaliar(pedido({ displayFinancialStatus: 'PARTIALLY_REFUNDED' }), et).acao, 'processar');
ok('troca esperando a peça → pular', api.avaliar(pedido({ tags: ['troca-aguardando'] }), et).acao, 'pular');
ok('outra pessoa na etiqueta → pular', api.avaliar(pedido(), { ...et, nome: 'Maria Oliveira' }).acao, 'pular');
ok('outra cidade na etiqueta → pular', api.avaliar(pedido(), { ...et, cidade: 'Santos' }).acao, 'pular');
ok('parcial: manda só o que falta', api.avaliar(pedido({ displayFulfillmentStatus: 'PARTIALLY_FULFILLED', fulfillments: [{ trackingInfo: [{ number: 'AAA11111' }] }] }), et).acao, 'processar');
ok('fulfillment order fechado → nada a enviar', api.avaliar(pedido({ fulfillmentOrders: { edges: [{ node: { id: 'x', status: 'CLOSED', lineItems: { edges: [] } } }] } }), et).acao, 'pular');
ok('pedido não achado → pular', api.avaliar(null, et).acao, 'pular');
ok('código vazio → pular', api.avaliar(pedido(), { ...et, codigo: '' }).acao, 'pular');
ok('mesmaPessoa ignora acento e nome do meio', api.mesmaPessoa('Mychelle Monteiro', 'MYCHELLE DE SOUZA MONTEIRO'), true);
ok('só grava com confirmar:true', /b\.confirmar !== true/.test(fonte), true);
ok('avisa a cliente (e-mail da Shopify e Wati)', /notifyCustomer: true/.test(fonte), true);

console.log(`\n${total - falhas}/${total} ok${falhas ? `, ${falhas} falha(s)` : ''}`);
process.exit(falhas ? 1 : 0);
