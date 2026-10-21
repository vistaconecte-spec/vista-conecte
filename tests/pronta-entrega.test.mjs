/**
 * /api/pronta-entrega (21/10/2026): pronta entrega = estoque físico menos o que os pedidos em aberto
 * já vão consumir; conjunto só está pronto quando as duas peças sobram na cor e no tamanho.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(raiz, 'functions/api/pronta-entrega.js'), 'utf8');
const puro = src.slice(src.indexOf('const chaveCor'), src.indexOf('export async function onRequestGet')).replace(/function acharModelo[\s\S]*?\n}\n/, '');
const { sobraDasPecas } = new Function(puro + '; return { sobraDasPecas };')();
let falhas = 0, total = 0;
const ok = (n, r, e) => { total++; const b = JSON.stringify(r) === JSON.stringify(e); if (!b) { falhas++; console.log(`  ✗ ${n}\n      esperado: ${JSON.stringify(e)}\n      obtido:   ${JSON.stringify(r)}`); } else console.log(`  ✓ ${n}`); };

const est = { 'macaquinho-amplo': { Preto: [0, 2, 1, 0, 0], 'Off White': [1, 0, 0, 0, 0] } };
ok('sem pedido em aberto, sobra = estoque', sobraDasPecas([{ key: 'macaquinho-amplo', cor: 'preto' }], est, {}, 5), [0, 2, 1, 0, 0]);
ok('pedido em aberto consome o estoque', sobraDasPecas([{ key: 'macaquinho-amplo', cor: 'Preto' }], est, { 'macaquinho-amplo': { preto: [0, 2, 0, 0, 0] } }, 5), [0, 0, 1, 0, 0]);
ok('mais pedido que estoque fica negativo (não é pronta)', sobraDasPecas([{ key: 'macaquinho-amplo', cor: 'Off White' }], est, { 'macaquinho-amplo': { 'off white': [3] } }, 5), [-2, 0, 0, 0, 0]);
const est2 = { 'calca-boho': { Preto: [0, 0, 1, 1, 0] }, 'blusa-boho': { Preto: [0, 0, 0, 1, 0] } };
ok('conjunto: só pronto onde as duas peças sobram', sobraDasPecas([{ key: 'calca-boho', cor: 'Preto' }, { key: 'blusa-boho', cor: 'Preto' }], est2, {}, 5), [0, 0, 0, 1, 0]);
ok('cor que não existe = 0', sobraDasPecas([{ key: 'macaquinho-amplo', cor: 'Marsala' }], est, {}, 5), [0, 0, 0, 0, 0]);
console.log(`\n${total - falhas}/${total} ok`);
if (falhas) process.exit(1);
