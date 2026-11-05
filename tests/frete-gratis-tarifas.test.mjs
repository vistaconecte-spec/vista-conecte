import assert from 'node:assert';
import { tarifas, REGRA } from '../functions/api/frete-gratis-tarifas.js';
const hoje = Date.parse('2026-11-05T12:00:00-03:00');
const item = (price, quantity = 1, extra = {}) => ({ price, quantity, requires_shipping: true, ...extra });
const rate = (cep, items, country = 'BR') => ({ destination: { postal_code: cep, country }, items });
const gratis = (r, t = hoje) => tarifas(r, t).length === 1;
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// O buraco que a rota cobre
ok(gratis(rate('25545-202', [item(9700, 2)])), '2 peças R$194 no RJ');
ok(gratis(rate('01310-100', [item(7450), item(5450)])), '2 peças da queima em SP');
ok(gratis(rate('88066260', [item(5450, 3)])), '3 peças em Floripa');
for (const cep of ['01000-000', '29167-300', '39999-999', '80000-000', '99999-999']) ok(gratis(rate(cep, [item(9000, 2)])), 'borda da faixa ' + cep);
ok(tarifas(rate('01310100', [item(9000, 2)]), hoje)[0].total_price === '0', 'preço zero');
ok(gratis(rate('01310100', [item(10000, 2)])), 'exatamente R$200 repete a Frenet em vez de arriscar um vão');

// O que continua pagando ou já é da Frenet
ok(!gratis(rate('01310-100', [item(17500)])), '1 peça');
ok(!gratis(rate('01310-100', [item(17500), item(0)])), 'brinde de R$0 não vira segunda peça');
ok(!gratis(rate('01310-100', [item(17500), item(9000, 1, { requires_shipping: false })])), 'item sem envio não conta');
ok(!gratis(rate('01310-100', [item(17500, 2)])), 'R$350 fica com a regra da Frenet');
for (const cep of ['74770-470', '58046-527', '69005-000', '40010-000', '00999-999', '70000-000']) ok(!gratis(rate(cep, [item(9000, 2)])), 'fora da região ' + cep);
ok(!gratis(rate('', [item(9000, 2)])), 'sem CEP');
ok(!gratis(rate('01310100', [item(9000, 2)], 'PT')), 'fora do Brasil');

// Prazo e entrada ruim
ok(gratis(rate('01310100', [item(9000, 2)]), REGRA.fim), 'último segundo de 30/11');
ok(!gratis(rate('01310100', [item(9000, 2)]), REGRA.fim + 1000), 'depois de 30/11 some sozinho');
ok(tarifas(undefined, hoje).length === 0, 'corpo vazio não quebra');
console.log(`frete-gratis-tarifas: ${n} asserções ok`);
