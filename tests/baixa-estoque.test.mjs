/**
 * Teste da baixa automática de estoque (main.js).
 *
 * POR QUE ISTO EXISTE: até 10/08/2026 a baixa saía UMA VEZ POR DIA às 16h. No intervalo,
 * o pedido processado já tinha sumido de "pedidos em aberto" mas o estoque continuava
 * cheio — e "estoque − pedidos em aberto" inflava, oferecendo a peça a outro pedido
 * (caso do Vestido Amplo PP). Agora a baixa é na hora, pedido a pedido.
 *
 * O risco novo é o oposto: baixar estoque de peça que NÃO saiu. Um pedido some da lista
 * de não-enviados por dois motivos — enviado ou cancelado — e só o enviado tira peça da
 * arara. Estes testes travam essa decisão.
 *
 * Rodar:  node tests/baixa-estoque.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const endpoint = readFileSync(join(raiz, 'functions/api/shopify-status-pedidos.js'), 'utf8');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

console.log('\n1) A regra das 16h não existe mais');
ok('nenhum agendamento para as 16h no código',
   /setHours\(\s*16\s*,/.test(main) || /agendarVerificacaoEnvios\s*\(/.test(main), false);
ok('a baixa roda junto com a atualização de pedidos',
   (main.match(/baixaImediataDeProcessados\(\)/g) || []).length >= 3, true);
ok('a baixa também sai ao processar o pedido pelo próprio app',
   /await carregarPedidosShopify\(\);\s*\r?\n\s*await baixaImediataDeProcessados/.test(main), true);

console.log('\n2) Enviado dá baixa, cancelado NÃO');
// Reproduz a classificação do endpoint sobre pedidos crus da Shopify.
const classificar = new Function('orders', `
  return orders.map(o => ({
    id: String(o.id),
    enviado: !o.cancelled_at && (o.fulfillment_status === 'fulfilled' || o.fulfillment_status === 'partial'),
    cancelado: !!o.cancelled_at,
  }));
`);
const cenario = [
  { id: 1, fulfillment_status: 'fulfilled', cancelled_at: null },
  { id: 2, fulfillment_status: null,        cancelled_at: '2026-08-10T12:00:00Z' },
  { id: 3, fulfillment_status: 'partial',   cancelled_at: null },
  { id: 4, fulfillment_status: null,        cancelled_at: null },
  { id: 5, fulfillment_status: 'fulfilled', cancelled_at: '2026-08-10T12:00:00Z' },
];
ok('pedido enviado → baixa',        classificar(cenario)[0].enviado, true);
ok('pedido cancelado → SEM baixa',  classificar(cenario)[1].enviado, false);
ok('envio parcial → baixa',         classificar(cenario)[2].enviado, true);
ok('sumiu sem estar enviado nem cancelado → SEM baixa', classificar(cenario)[3].enviado, false);
ok('enviado E depois cancelado → SEM baixa (cancelamento manda)', classificar(cenario)[4].enviado, false);

console.log('\n3) O endpoint não inventa resposta');
ok('usa status=any (senão o cancelado nem aparece e viraria baixa)', /status=any/.test(endpoint), true);
ok('devolve os ids que a Shopify não achou, em vez de assumir envio', /nao_encontrados/.test(endpoint), true);
ok('limita o lote (URL da Shopify tem teto)', /slice\(0,\s*50\)/.test(endpoint), true);
ok('só aceita id numérico', /\^\\d\+\$/.test(endpoint), true);

console.log('\n4) Sem confirmação da Shopify, o estoque não é tocado');
const corpo = main.slice(main.indexOf('async function baixaImediataDeProcessados'),
                         main.indexOf('\n}', main.indexOf('async function baixaImediataDeProcessados')));
ok('erro de rede → return antes de qualquer baixa', /catch\s*\{\s*return;\s*\}/.test(corpo), true);
ok('resposta não-ok → return',                      /if \(!res\.ok\) return;/.test(corpo), true);
ok('primeira execução só fotografa, não baixa',
   /if \(!snap\) \{ salvarSnapshotPedidos\(\); return; \}/.test(corpo), true);
ok('pedido não confirmado continua na foto (não some sem baixa)',
   /if \(!resolvidos\.has\(id\)\) novaFoto\[id\] = snap\[id\]/.test(corpo), true);

console.log('\n5) A baixa não inventa estoque');
const baixa = main.slice(main.indexOf('function baixarEstoqueDoPedido'),
                         main.indexOf('\n}', main.indexOf('function baixarEstoqueDoPedido')));
ok('cor sem estoque cadastrado é pulada', /if \(!saved \|\| !saved\.est \|\| !saved\.est\[r\.cor\]\) continue;/.test(baixa), true);
ok('nunca deixa o estoque negativo', /Math\.min\(antes, r\.qtd\)/.test(baixa), true);
ok('tamanho único baixa na posição 0', /tamanhoUnico\) \? 0 : r\.tam/.test(baixa), true);
ok('conjunto é expandido pela fonte única (requisitosDoItem)', /requisitosDoItem\(item\)/.test(baixa), true);

console.log('\n6) requisitosDoItem é fonte única (card de prontos + baixa)');
ok('existe uma única definição da regra', (main.match(/function requisitosDoItem\(/g) || []).length, 1);
ok('o card de prontos usa a mesma função', /const reqsDoItem = requisitosDoItem;/.test(main), true);

console.log(`\n${falhas === 0 ? '✓ TODOS OS TESTES PASSARAM' : '✗ ' + falhas + ' FALHA(S)'} — ${total - falhas}/${total}\n`);
process.exit(falhas === 0 ? 0 : 1);
