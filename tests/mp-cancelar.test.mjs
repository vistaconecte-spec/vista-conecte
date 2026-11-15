// Só Pix pendente pode ser cancelado (15/11/2026, #9714). Aprovado/cartão nunca.
import assert from 'node:assert/strict';
import { podeCancelar } from '../functions/api/mp-cancelar.js';
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
ok(podeCancelar({ status: 'pending', payment_type_id: 'bank_transfer' }) === '', 'pix pendente cancela');
ok(podeCancelar({ status: 'approved', payment_type_id: 'bank_transfer' }) !== '', 'pix pago não');
ok(podeCancelar({ status: 'pending', payment_type_id: 'credit_card' }) !== '', 'cartão não');
ok(podeCancelar({ status: 'authorized', payment_type_id: 'account_money' }) !== '', 'autorizado não');
ok(podeCancelar(null) !== '', 'sem pagamento não');
console.log(`mp-cancelar: ${n}/${n} ok`);
