/**
 * Vale-troca de quem escolheu crédito na loja (functions/_vale.js, /api/vale-troca e as etapas
 * na lista de Devolução do main.js, 19/10/2026).
 *
 * Regras da Bárbara: sai quando a peça chega, 90 dias, valor pago, Marcelly manda no WhatsApp.
 * Trava: código estável (dois cliques = um cupom só), valor nunca passa do pago no pedido,
 * cupom preso à cliente do pedido e no formato que a API da loja aceita (`context`), mensagem
 * no tom da loja, e a linha anda chegou → gerar → enviado.
 *
 * Rodar:  node tests/vale.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as V from '../functions/_vale.js';
import { onRequestPost } from '../functions/api/vale-troca.js';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

console.log('\n1) Código e valor');
{
  const c = V.codigoVale('#9250', 'portal-9250-abc-1');
  ok('código começa com VALE + pedido', /^VALE9250[A-Z0-9]{4}$/.test(c), true);
  ok('mesmo item, mesmo código', V.codigoVale('9250', 'portal-9250-abc-1'), c);
  ok('outro item, outro código', V.codigoVale('9250', 'portal-9250-abc-2') !== c, true);
  ok('valor pago passa', V.validarValor(135.95, '314.33').valor, 135.95);
  ok('valor acima do pedido é recusado', !!V.validarValor(400, '314.33').erro, true);
  ok('linha sem valor é recusada', !!V.validarValor(0, '314.33').erro, true);
  const agora = new Date('2026-10-19T15:00:00Z');
  ok('vale 90 dias', V.dataVale(agora).toISOString(), '2027-01-17T15:00:00.000Z');
}

console.log('\n2) Cupom na Shopify');
{
  const d = V.inputDesconto({ codigo: 'VALE9250ABCD', valor: 135.95, titulo: 'Vale troca #9250', customerId: 'gid://shopify/Customer/1', agora: new Date('2026-10-19T15:00:00Z') });
  ok('uso único', [d.usageLimit, d.appliesOncePerCustomer], [1, true]);
  ok('preso à cliente (campo context, não customerSelection)', [d.context, d.customerSelection], [{ customers: { add: ['gid://shopify/Customer/1'] } }, undefined]);
  ok('valor fixo no pedido inteiro', d.customerGets, { value: { discountAmount: { amount: '135.95', appliesOnEachItem: false } }, items: { all: true } });
  ok('sem cliente cadastrada: vale para quem tiver o código', V.inputDesconto({ codigo: 'X', valor: 1, titulo: 't' }).context, { all: 'ALL' });
}

console.log('\n3) Mensagem para a Marcelly');
{
  const m = V.mensagemVale({ nome: 'Lais Jarilho', valor: 135.95, codigo: 'VALE9250ABCD', ate: '2027-01-17T15:00:00.000Z' });
  ok('tem nome, valor, código e validade', [/^Oi Lais,/.test(m), m.includes('R$ 135,95'), m.includes('VALE9250ABCD'), m.includes('17/01/2027')], [true, true, true, true]);
  ok('avisa que é uso único', /uso único/.test(m), true);
  ok('sem travessão, sem dois-pontos, sem "amor"', [/—/.test(m), /:/.test(m), /amor/i.test(m)], [false, false, false]);
}

console.log('\n4) Endpoint (Shopify simulada)');
{
  const criados = [];
  let existente = null;
  globalThis.fetch = async (url, opts) => {
    const { query, variables } = JSON.parse(opts.body);
    if (query.includes('orders(')) return new Response(JSON.stringify({ data: { orders: { nodes: variables.q === 'name:#9250'
      ? [{ name: '#9250', email: 'l@x.com', customer: { id: 'gid://shopify/Customer/7' }, shippingAddress: { name: 'Lais Jarilho' }, currentTotalPriceSet: { shopMoney: { amount: '314.33' } } }] : [] } } }));
    if (query.includes('codeDiscountNodeByCode')) return new Response(JSON.stringify({ data: { codeDiscountNodeByCode: existente } }));
    criados.push(variables.d);
    return new Response(JSON.stringify({ data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://x', codeDiscount: { endsAt: variables.d.endsAt } }, userErrors: [] } } }));
  };
  const chamar = async b => { const r = await onRequestPost({ env: { SHOPIFY_STORE_DOMAIN: 'l', SHOPIFY_ADMIN_TOKEN: 't' }, request: new Request('https://x', { method: 'POST', body: JSON.stringify(b) }) }); return { s: r.status, j: await r.json() }; };
  const r1 = await chamar({ pedido: '#9250', item_id: 'e1', valor: 135.95, cliente: 'Lais Jarilho' });
  ok('cria o cupom preso à cliente do pedido', [r1.s, r1.j.ok, criados.length, criados[0]?.context?.customers?.add?.[0]], [200, true, 1, 'gid://shopify/Customer/7']);
  ok('devolve a mensagem pronta', /VALE9250/.test(r1.j.mensagem || ''), true);
  existente = { id: 'gid://x', codeDiscount: { endsAt: '2027-01-17T15:00:00Z', customerGets: { value: { amount: { amount: '135.95' } } } } };
  const r2 = await chamar({ pedido: '#9250', item_id: 'e1', valor: 135.95 });
  ok('segundo clique não cria outro', [r2.j.ja_existia, criados.length, r2.j.codigo], [true, 1, r1.j.codigo]);
  existente = null;
  const r3 = await chamar({ pedido: '#9250', item_id: 'e2', valor: 999 });
  ok('valor acima do pago é recusado', [r3.s, criados.length], [422, 1]);
  const r4 = await chamar({ pedido: '#1', item_id: 'e3', valor: 10 });
  ok('pedido inexistente', r4.s, 404);
}

console.log('\n5) Etapas na lista de Devolução (main.js)');
{
  const main = readFileSync(join(raiz, 'main.js'), 'utf8');
  const a = main.indexOf('function valeEhCredito'), b = main.indexOf('function valeAlterar');
  const { valeEhCredito, valeEtapa, valeAcaoHtml } = new Function(`${main.slice(a, b)}; return { valeEhCredito, valeEtapa, valeAcaoHtml };`)();
  ok('crédito do portal', valeEhCredito({ forma: 'credito' }), true);
  ok('crédito digitado à mão', valeEhCredito({ motivo: 'Crédito na loja · Ficou grande' }), true);
  ok('dinheiro de volta não tem vale', [valeEhCredito({ forma: 'devolucao', motivo: 'Dinheiro de volta · x' }), valeAcaoHtml({ id: 'x', forma: 'devolucao' })], [false, '']);
  ok('anda chegou → gerado → enviado', [valeEtapa({}), valeEtapa({ chegou_em: 'x' }), valeEtapa({ chegou_em: 'x', vale_codigo: 'V' }), valeEtapa({ vale_codigo: 'V', vale_enviado_em: 'y' })], ['esperando', 'chegou', 'gerado', 'enviado']);
  ok('antes de chegar só aparece "chegou"', [/valeChegou/.test(valeAcaoHtml({ id: 'a', forma: 'credito' })), /valeGerar/.test(valeAcaoHtml({ id: 'a', forma: 'credito' }))], [true, false]);
  ok('depois de gerado: copiar e marcar enviado', [/valeCopiar/.test(valeAcaoHtml({ id: 'a', forma: 'credito', vale_codigo: 'V' })), /valeEnviado/.test(valeAcaoHtml({ id: 'a', forma: 'credito', vale_codigo: 'V' }))], [true, true]);
}

console.log(falhas ? `\n✗ ${falhas} de ${total} falharam` : `\n✓ TODOS OS TESTES PASSARAM — ${total}/${total}`);
if (falhas) process.exit(1);
