import assert from 'node:assert';
import { tarifas, REGRA } from '../functions/api/frete-gratis-tarifas.js';
const hoje = Date.parse('2026-11-05T12:00:00-03:00');
const item = (price, quantity = 1, extra = {}) => ({ price, quantity, grams: 400, requires_shipping: true, ...extra });
const rate = (cep, items, country = 'BR') => ({ destination: { postal_code: cep, country }, items });
const cota = preco => async () => [{ cliente_paga: preco, prazo_dias: 6 }, { cliente_paga: null }];
const ops = (extra = {}) => ({ token: 't', agora: hoje, cotarFn: async () => { throw new Error('não devia cotar'); }, ...extra });
const gratis = async (r, o) => (await tarifas(r, ops(o))).length === 1;
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// Sul e Sudeste: 2 peças, sem cotar nada
ok(await gratis(rate('25545-202', [item(9700, 2)])), '2 peças R$194 no RJ');
ok(await gratis(rate('01310-100', [item(7450), item(5450)])), '2 peças da queima em SP');
ok(await gratis(rate('88066260', [item(5450, 3)])), '3 peças em Floripa');
for (const cep of ['01000-000', '29167-300', '39999-999', '80000-000', '99999-999']) ok(await gratis(rate(cep, [item(9000, 2)])), 'borda da faixa ' + cep);
ok((await tarifas(rate('01310100', [item(9000, 2)]), ops()))[0].total_price === '0', 'preço zero');
ok(await gratis(rate('01310100', [item(10000, 2)])), 'exatamente R$200 repete a Frenet em vez de arriscar um vão');
ok(!await gratis(rate('01310-100', [item(17500, 2)])), 'R$350 fica com a regra da Frenet');

// Resto do Brasil: depende da cotação do carrinho
ok(await gratis(rate('74770-470', [item(9000, 2)]), { cotarFn: cota(20.39) }), 'GO com frete R$20');
ok(await gratis(rate('74770-470', [item(17500, 2)]), { cotarFn: cota(29.99) }), 'acima de R$200 também, a Frenet não zera lá');
ok(!await gratis(rate('58046-527', [item(9000, 2)]), { cotarFn: cota(30) }), 'R$30 cravado não é menor que R$30');
ok(!await gratis(rate('58046-527', [item(9000, 2)]), { cotarFn: cota(40.54) }), 'PB com frete R$40');
ok(!await gratis(rate('74770-470', [item(17500)])), '1 peça nem cota');
ok(!await gratis(rate('74770-470', [item(40000, 2)])), 'R$800 fica com a regra de R$669 da Frenet');
ok(!await gratis(rate('74770-470', [item(9000, 2)]), { cotarFn: async () => { throw new Error('caiu'); } }), 'Frenet fora do ar');
ok(!await gratis(rate('74770-470', [item(9000, 2)]), { cotarFn: async () => [] }), 'sem serviço');
ok(!await gratis(rate('74770-470', [item(9000, 2)]), { token: undefined }), 'sem token');
ok(!await gratis(rate('', [item(9000, 2)])), 'sem CEP');
let visto;
await tarifas(rate('74770-470', [item(9000, 2), item(5000, 1, { grams: 200 })]), ops({ cotarFn: async (t, p) => { visto = p; return []; } }));
ok(visto.cep === '74770470' && visto.valor === 230 && Math.abs(visto.peso - 1) < 1e-9, 'cota com CEP, valor e peso do carrinho');
ok((await tarifas(rate('74770-470', [item(9000, 2)]), ops({ cotarFn: cota(20) })))[0].description.includes('6 dias úteis'), 'mostra o prazo');

// O que nunca entra
ok(!await gratis(rate('01310-100', [item(17500)])), '1 peça');
ok(!await gratis(rate('01310-100', [item(17500), item(0)])), 'brinde de R$0 não vira segunda peça');
ok(!await gratis(rate('01310-100', [item(17500), item(9000, 1, { requires_shipping: false })])), 'item sem envio não conta');
ok(!await gratis(rate('01310100', [item(9000, 2)], 'PT')), 'fora do Brasil');
ok(await gratis(rate('01310100', [item(9000, 2)]), { agora: REGRA.fim }), 'último segundo de 30/11');
ok(!await gratis(rate('01310100', [item(9000, 2)]), { agora: REGRA.fim + 1000 }), 'depois de 30/11 some sozinho');
ok((await tarifas(undefined, ops())).length === 0, 'corpo vazio não quebra');
console.log(`frete-gratis-tarifas: ${n} asserções ok`);
