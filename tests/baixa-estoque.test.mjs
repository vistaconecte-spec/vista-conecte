/**
 * Teste da baixa automática de estoque (main.js + functions/api/shopify-orders.js).
 *
 * POR QUE ISTO EXISTE: até 10/08/2026 a baixa saía UMA VEZ POR DIA às 16h. No intervalo,
 * o pedido processado já tinha sumido de "pedidos em aberto" mas o estoque continuava
 * cheio — e "estoque − pedidos em aberto" inflava, oferecendo a peça a outro pedido
 * (caso do Vestido Amplo PP). Agora a baixa é na hora.
 *
 * O processamento é feito NA SHOPIFY, então ela é a fonte da verdade sobre o que foi
 * enviado. Os dois riscos que estes testes travam:
 *   1. baixar peça que NÃO saiu (pedido cancelado some da lista igual a um enviado);
 *   2. baixar DUAS vezes o mesmo pedido (dois aparelhos, ou a rotina antiga das 16h).
 *
 * Rodar:  node tests/baixa-estoque.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const api  = readFileSync(join(raiz, 'functions/api/shopify-orders.js'), 'utf8');


let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

console.log('\n1) A regra das 16h não existe mais');
ok('sem agendamento para as 16h', /setHours\(\s*16\s*,/.test(main) || /agendarVerificacaoEnvios\s*\(/.test(main), false);
ok('a baixa roda junto com cada atualização de pedidos',
   (main.match(/baixaImediataDeProcessados\(\)/g) || []).length >= 3, true);

console.log('\n2) Quem diz o que foi processado é a Shopify');
ok('a API busca pedidos com envio criado', /fulfillment_status=\$\{st\}/.test(api), true);
ok('usa status=any (senão não enxerga o histórico completo)', /status=any&fulfillment_status=/.test(api), true);
ok('CANCELADO é filtrado fora — a peça dele continua na arara',
   /filter\(o => !o\.cancelled_at\)/.test(api), true);
ok('em pedido processado a quantidade vem de quantity, não de fulfillable_quantity',
   /usarQuantidadeTotal \? \(item\.quantity \?\? 0\) : \(item\.fulfillable_quantity \?\? 0\)/.test(api), true);
ok('o parser continua sendo um só (mesma função para aberto e processado)',
   (api.match(/function parseLineItem\(/g) || []).length, 1);
ok('falha ao buscar processados não derruba a lista de pedidos em aberto',
   /catch \(e\) \{[\s\S]{0,200}processados = \[\];/.test(api), true);

console.log('\n3) Nunca baixa o mesmo pedido duas vezes');
const corpo = main.slice(main.indexOf('async function baixaImediataDeProcessados'),
                         main.indexOf('\n}', main.indexOf('async function baixaImediataDeProcessados')));
ok('pula remessa que já está no registro', /!ledger\.envios\[p\.id\]/.test(corpo), true);
ok('grava a remessa no registro ao baixar', /ledger\.envios\[p\.id\] = \{/.test(corpo), true);
ok('o registro é salvo na NUVEM (celular e computador compartilham)',
   /await salvarNuvem\(LEDGER_BAIXAS, ledger\)/.test(corpo), true);
ok('registro fica em vc_modelos, como a precificação', /const LEDGER_BAIXAS = 'baixas-estoque'/.test(main), true);

console.log('\n4) A virada da regra NÃO reaplica o que já foi baixado');
// Os envios da janela de 7 dias já tiveram baixa pela rotina das 16h (e pelo acerto de
// 10/08/2026 às 17h41, confirmado no modal). Subtrair de novo sumiria com estoque real —
// e estoque subtraído a mais não reaparece sozinho, só recontando a arara na mão.
ok('primeira execução não baixa nada, só registra',
   /ledger = \{ chave: LEDGER_CHAVE, desde: new Date\(\)\.toISOString\(\), envios: \{\} \};[\s\S]{0,600}?return;/.test(corpo), true);
ok('marca os envios já existentes como anteriores ao registro',
   /nota: 'anterior ao registro'/.test(corpo), true);
ok('depois disso, só entra envio posterior ao início do registro',
   /maisNovoQue\(p\.enviado_em, ledger\.desde\)/.test(corpo), true);

console.log('\n4b) FURO ACHADO 10/08/2026 — data comparada como texto');
// A Shopify devolve com fuso ("...-03:00"); o registro grava em Z. Comparar como string
// dá errado quando o envio cruza a meia-noite: virava "antigo" e nunca tinha baixa.
const maisNovoQue = new Function(
  main.slice(main.indexOf('function maisNovoQue('), main.indexOf('\n}', main.indexOf('function maisNovoQue('))) + '\n}'
  + '; return maisNovoQue;')();
ok('envio 01:00 (-03:00) é MAIS NOVO que registro de 02:00Z do mesmo dia',
   maisNovoQue('2026-08-11T01:00:00-03:00', '2026-08-11T02:00:00.000Z'), true);
ok('(a comparação como texto errava exatamente este caso)',
   '2026-08-11T01:00:00-03:00' >= '2026-08-11T02:00:00.000Z', false);
ok('envio realmente anterior continua fora',
   maisNovoQue('2026-08-09T10:00:00-03:00', '2026-08-10T20:00:00.000Z'), false);
ok('data inválida não vira baixa', maisNovoQue('', '2026-08-10T20:00:00.000Z'), false);
ok('o código usa a comparação por data, não string',
   /maisNovoQue\(p\.enviado_em, ledger\.desde\)/.test(corpo), true);
ok('a poda de 60 dias também', /!maisNovoQue\(r\.em, corte\)/.test(corpo), true);

console.log('\n4c) FURO ACHADO 10/08/2026 — envio PARCIAL não dava baixa');
ok('a API busca também os parciais', /for \(const st of \['shipped', 'partial'\]\)/.test(api), true);
ok('pedido que cai nas duas buscas não é contado duas vezes', /if \(vistos\.has\(o\.id\)\) continue;/.test(api), true);
ok('a baixa é por REMESSA, não por pedido (2ª remessa também baixa)',
   /for \(const f of o\.fulfillments \|\| \[\]\)/.test(api) && /id: String\(f\.id\)/.test(api), true);
ok('as peças vêm do que REALMENTE saiu (line_items da remessa)',
   /for \(const item of f\.line_items \|\| \[\]\)/.test(api), true);
ok('remessa cancelada/falhada não dá baixa', /if \(f\.status && f\.status !== 'success'\) continue;/.test(api), true);
ok('registro por remessa é marcado, e formato antigo é re-semeado',
   /const LEDGER_CHAVE = 'fulfillment'/.test(main) && /l\.chave === LEDGER_CHAVE/.test(main), true);

console.log('\n4d) FURO ACHADO 10/08/2026 — a conferência manual duplicaria a baixa');
// O modal antigo comparava com uma FOTO do total em aberto. Como a baixa automática mexe
// no estoque sem tocar nessa foto, a diferença mostraria de novo tudo o que já foi baixado
// — e confirmar subtrairia duas vezes. Agora a conferência é feita contra o REGISTRO.
const conf = main.slice(main.indexOf('async function verificarEnvios'),
                        main.indexOf('\nasync function confirmarBaixaEstoque'));
ok('a conferência lista o que NÃO está no registro',
   /filter\(p => !ledger\.envios\[p\.id\]\)/.test(conf), true);
ok('não usa mais a foto do total em aberto', /aberto-snapshot/.test(main), false);
ok('a foto agregada foi removida de vez', /salvarSnapshotAberto/.test(main), false);
const confirma = main.slice(main.indexOf('async function confirmarBaixaEstoque'),
                            main.indexOf('\nfunction fecharModalEnvios'));
ok('confirmar pula remessa que já entrou no registro nesse meio-tempo',
   /if \(ledger\.envios\[id\]\) continue;/.test(confirma), true);
ok('confirmar grava no registro (não dá pra aplicar duas vezes)',
   /ledger\.envios\[id\] = \{[\s\S]{0,160}'conferência manual'/.test(confirma), true);
const ignora = main.slice(main.indexOf('async function ignorarEnvios'), main.length);
ok('ignorar marca sem mexer no estoque', /'ignorado na conferência'/.test(ignora)
   && !/baixarEstoqueDoPedido/.test(ignora.slice(0, ignora.indexOf('\n}'))), true);

console.log('\n5) A baixa não inventa nem estoura estoque');
const baixa = main.slice(main.indexOf('function baixarEstoqueDoPedido'),
                         main.indexOf('\n}', main.indexOf('function baixarEstoqueDoPedido')));
ok('cor sem estoque cadastrado é pulada', /if \(!saved \|\| !saved\.est \|\| !saved\.est\[r\.cor\]\) continue;/.test(baixa), true);
ok('nunca deixa o estoque negativo', /Math\.min\(antes, r\.qtd\)/.test(baixa), true);
ok('tamanho único baixa na posição 0', /tamanhoUnico\) \? 0 : r\.tam/.test(baixa), true);
ok('conjunto é expandido pela fonte única (requisitosDoItem)', /requisitosDoItem\(item\)/.test(baixa), true);

console.log('\n6) requisitosDoItem é fonte única (card de prontos + baixa)');
ok('existe uma única definição da regra', (main.match(/function requisitosDoItem\(/g) || []).length, 1);
ok('o card de prontos usa a mesma função', /const reqsDoItem = requisitosDoItem;/.test(main), true);

console.log('\n7) A baixa é automática, mas não silenciosa');
ok('guarda o que saiu para o aviso', /_ultimaBaixaAuto = \{ quando/.test(corpo), true);
ok('o dashboard tem onde mostrar', /renderAvisoBaixaAuto/.test(main), true);

console.log(`\n${falhas === 0 ? '✓ TODOS OS TESTES PASSARAM' : '✗ ' + falhas + ' FALHA(S)'} — ${total - falhas}/${total}\n`);
process.exit(falhas === 0 ? 0 : 1);
