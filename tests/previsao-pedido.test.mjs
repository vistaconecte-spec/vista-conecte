/**
 * /api/previsao-pedido: posição do pedido peça por peça para a Vi (05/10/2026).
 *
 * Trava três coisas:
 *  1. a cópia de CONJUNTO_PECAS / CONJUNTO_CORES_COMBINADAS no endpoint continua IGUAL à do main.js
 *     (se divergir, a Vi dá data de uma peça que o pedido nem tem);
 *  2. a data só vale com a leva "Em costura" e a entrega gravada para ESSA rodada de costura;
 *  3. a liberação é o dia útil anterior à entrega da Elizete (regra da Bárbara).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(raiz, 'functions/api/previsao-pedido.js'), 'utf8');
const puro = src.slice(src.indexOf('const SIZES'), src.indexOf('export async function onRequestGet'));
const { situacaoPeca, diaUtilAnterior, pecasDe, CONJUNTO_PECAS, CONJUNTO_CORES_COMBINADAS } =
  new Function(puro + '; return { situacaoPeca, diaUtilAnterior, pecasDe, CONJUNTO_PECAS, CONJUNTO_CORES_COMBINADAS };')();

const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const trecho = (nome) => {
  const i = main.indexOf(`const ${nome} = {`);
  let n = 0, j = main.indexOf('{', i);
  for (let k = j; k < main.length; k++) { if (main[k] === '{') n++; if (main[k] === '}' && --n === 0) return main.slice(j, k + 1); }
};
const doMain = (nome) => new Function('return ' + trecho(nome))();

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

console.log('\n1) Cópia dos mapas de conjunto igual à do main.js');
ok('CONJUNTO_PECAS', CONJUNTO_PECAS, doMain('CONJUNTO_PECAS'));
ok('CONJUNTO_CORES_COMBINADAS', CONJUNTO_CORES_COMBINADAS, doMain('CONJUNTO_CORES_COMBINADAS'));

console.log('\n2) Situação da peça');
const base = { est: { Preto: [0, 0, 6, 0, 0] }, prod: { Preto: [0, 0, 0, 2, 0] }, status: 'Em costura', status_at: '2026-09-30T21:11:21.963Z' };
ok('estoque sem leva = pronta', situacaoPeca(base, 'preto', 2), { situacao: 'pronta' });
ok('na leva em costura sem data', situacaoPeca(base, 'Preto', 3), { situacao: 'em_producao', etapa: 'Em costura', leva: 1 });
ok('na leva com entrega desta rodada',
  situacaoPeca({ ...base, entrega: '2026-10-07', entrega_ref: base.status_at }, 'Preto', 3),
  { situacao: 'em_producao', etapa: 'Em costura', leva: 1, entrega_costura: '2026-10-07', libera_em: '2026-10-06' });
ok('entrega de outra rodada não vale',
  situacaoPeca({ ...base, entrega: '2026-09-20', entrega_ref: '2026-09-10T10:00:00Z' }, 'Preto', 3),
  { situacao: 'em_producao', etapa: 'Em costura', leva: 1 });
ok('entrega gravada mas leva ainda em corte não vale',
  situacaoPeca({ ...base, status: 'Em corte', entrega: '2026-10-07', entrega_ref: base.status_at }, 'Preto', 3),
  { situacao: 'em_producao', etapa: 'Em corte', leva: 1 });
ok('sem estoque nem leva', situacaoPeca(base, 'Marrom', 3), { situacao: 'sem_leva' });
ok('estoque E leva: conta a leva (estoque pode ser de pedido mais antigo)',
  situacaoPeca({ ...base, est: { Preto: [0, 0, 0, 5, 0] } }, 'Preto', 3), { situacao: 'em_producao', etapa: 'Em costura', leva: 1 });
ok('duas levas: vale a mais atrasada',
  situacaoPeca({ ...base, prod2: { Preto: [0, 0, 0, 1, 0] }, status2: 'Comprando tecido' }, 'Preto', 3),
  { situacao: 'em_producao', etapa: 'Comprando tecido', leva: 2 });
ok('modelo sem cadastro', situacaoPeca(undefined, 'Preto', 3), { situacao: 'sem_cadastro' });

console.log('\n3) Dia útil anterior');
ok('quarta → terça', diaUtilAnterior('2026-10-07'), '2026-10-06');
ok('segunda → sexta', diaUtilAnterior('2026-10-12'), '2026-10-09');

console.log('\n4) Conjunto vira as peças');
ok('Conjunto Boho preto', pecasDe('conjunto-boho', 'Preto'), [{ key: 'calca-boho', cor: 'Preto' }, { key: 'blusa-boho', cor: 'Preto' }]);
ok('cor fixa por peça', pecasDe('conjunto-calca-bolso-camiseta', 'X'), [{ key: 'calca-bolso-frontal', cor: 'Off White' }, { key: 'camiseta-oversized', cor: 'Preto' }]);
ok('peça avulsa', pecasDe('calca-flare', 'Preto'), [{ key: 'calca-flare', cor: 'Preto' }]);

console.log(`\n${total - falhas}/${total} ok`);
if (falhas) process.exit(1);
