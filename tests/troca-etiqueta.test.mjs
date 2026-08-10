/**
 * Teste do card "LIBERAR TROCANDO A ETIQUETA" (main.js → planejarTrocaEtiqueta).
 *
 * POR QUE ISTO EXISTE: o card manda a expedição pegar uma peça da arara e remarcar
 * a etiqueta. Errar aqui é errar no físico — peça cortada/etiqueta trocada não volta
 * atrás. As regras travadas por estes testes:
 *   1. só tamanho VIZINHO (±1) — nunca dois de distância;
 *   2. Macaquinho Amplo nunca entra (a etiqueta não pode ser trocada);
 *   3. calçado e tamanho único nunca entram;
 *   4. só libera quando a troca resolve o pedido INTEIRO;
 *   5. a mesma peça não pode ser prometida a dois pedidos — o mais parado leva.
 *
 * Rodar:  node tests/troca-etiqueta.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');

function extrair(nome) {
  const i = main.indexOf(`function ${nome}(`);
  if (i < 0) throw new Error(`função ${nome} não encontrada em main.js`);
  const fim = main.indexOf('\n}', i);
  return main.slice(i, fim + 2);
}
const planejar = new Function(extrair('planejarTrocaEtiqueta') + '; return planejarTrocaEtiqueta;')();

// A lista real de modelos sem troca vive em main.js — se alguém tirar o macaquinho
// de lá, o teste 3 quebra, que é exatamente o que se quer.
const SEM_TROCA = new Function(
  main.slice(main.indexOf('const SEM_TROCA_ETIQUETA'), main.indexOf(']);', main.indexOf('const SEM_TROCA_ETIQUETA')) + 3) +
  '; return SEM_TROCA_ETIQUETA;')();

const MODELOS = {
  'calca':            { nome: 'Calça',           tamanhos: ['PP','P','M','G','GG','G1'] },
  'blusa':            { nome: 'Blusa' },                       // PP..GG padrão
  'macaquinho-amplo': { nome: 'Macaquinho Amplo' },
  'vestido-unico':    { nome: 'Vestido',         tamanhoUnico: true },
  'flat':             { nome: 'Flat', revenda: true, tamanhos: ['34','35','36','37','38','39','40'] },
};
// nos testes o campo "data" já é o número de dias parado
const diasDe = d => d || 0;

const P = 1, M = 2, G = 3, GG = 4, G1 = 5; // índices de tamanho

// aberto = tabela PEDIDOS EM ABERTO por modelo/cor; bruto = ESTOQUE ATUAL antes de qualquer
// alocação (por padrão igual ao saldo livre, que é o caso quando nada foi separado ainda).
const rodar = (pendentes, livre, aberto, bruto) => {
  const mods = {};
  for (const k of Object.keys(MODELOS)) mods[k] = { ...MODELOS[k], aberto: (aberto && aberto[k]) || {} };
  return planejar(pendentes, livre, mods, SEM_TROCA, diasDe, bruto || livre);
};
const pedido = (numero, dias, faltas, reqs) => ({ numero, data: dias, cliente: 'X', faltas, reqs });
const falta  = (key, cor, tam, qtd) => ({ key, cor, tam, falta: qtd });
const req    = (key, cor, tam, qtd) => ({ key, cor, tam, qtd });

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}
const numeros = r => r.liberaveis.map(p => p.numero);
// [numero, podeSairJUNTO com os demais] — false = disputa a peça com um pedido mais antigo
const simultaneidade = r => r.liberaveis.map(p => [p.numero, !!p.simultaneo]);
const trocas  = r => r.liberaveis.map(p => p.planos.map(pl => pl.trocas.map(t => `${t.de}->${t.para}x${t.qtd}`).join(',')).join('|'));

console.log('\n1) Só tamanho vizinho (±1)');
ok('falta M, tem G na arara → libera trocando G em M',
   numeros(rodar([pedido('#1', 20, [falta('calca','Preto',M,1)])], { calca: { Preto: [0,0,0,1,0,0] } })),
   ['#1']);
ok('falta M, só tem PP (2 de distância) → não libera',
   numeros(rodar([pedido('#1', 20, [falta('calca','Preto',M,1)])], { calca: { Preto: [1,0,0,0,0,0] } })),
   []);
ok('falta PP (primeiro tamanho) → não estoura para índice -1, usa o P',
   trocas(rodar([pedido('#1', 20, [falta('calca','Preto',0,1)])], { calca: { Preto: [0,1,0,0,0,0] } })),
   ['1->0x1']);
ok('falta G1 (último tamanho) → não estoura o array, usa o GG',
   trocas(rodar([pedido('#1', 20, [falta('calca','Preto',G1,1)])], { calca: { Preto: [0,0,0,0,1,0] } })),
   ['4->5x1']);
ok('falta GG na blusa (5 tamanhos) → não busca índice 5 que não existe',
   numeros(rodar([pedido('#1', 20, [falta('blusa','Preto',GG,1)])], { blusa: { Preto: [0,0,0,0,0,9] } })),
   []);

console.log('\n2) Macaquinho Amplo nunca entra — a etiqueta não pode ser trocada');
ok('falta macaquinho M com G na arara → não libera',
   numeros(rodar([pedido('#1', 40, [falta('macaquinho-amplo','Preto',M,1)])], { 'macaquinho-amplo': { Preto: [0,0,0,1,0] } })),
   []);
ok('pedido com calça (resolvível) + macaquinho (não) → não libera, conta como travado',
   (r => [numeros(r), r.travadosSemTroca])(rodar(
     [pedido('#1', 40, [falta('calca','Preto',M,1), falta('macaquinho-amplo','Preto',M,1)])],
     { calca: { Preto: [0,0,0,1,0,0] }, 'macaquinho-amplo': { Preto: [0,0,0,1,0] } })),
   [[], 1]);

console.log('\n3) Calçado e tamanho único não têm troca de etiqueta');
ok('Flat 36 com 37 na arara → não libera (revenda)',
   numeros(rodar([pedido('#1', 40, [falta('flat','Preto',2,1)])], { flat: { Preto: [0,0,0,1,0,0,0] } })),
   []);
ok('vestido tamanho único → não libera',
   numeros(rodar([pedido('#1', 40, [falta('vestido-unico','Preto',0,1)])], { 'vestido-unico': { Preto: [5] } })),
   []);

console.log('\n4) Só libera quando a troca resolve o pedido INTEIRO');
ok('2 faltas, só 1 tem vizinho → não libera e conta como parcial',
   (r => [numeros(r), r.parciais])(rodar(
     [pedido('#1', 30, [falta('calca','Preto',M,1), falta('blusa','Nude',M,1)])],
     { calca: { Preto: [0,0,0,1,0,0] }, blusa: { Nude: [0,0,0,0,0] } })),
   [[], 1]);
ok('falta 3 peças e só há 2 vizinhas → não libera',
   numeros(rodar([pedido('#1', 30, [falta('calca','Preto',M,3)])], { calca: { Preto: [0,1,0,1,0,0] } })),
   []);
ok('falta 2 peças, 1 no P e 1 no G → libera somando os dois vizinhos',
   trocas(rodar([pedido('#1', 30, [falta('calca','Preto',M,2)])], { calca: { Preto: [0,1,0,1,0,0] } })),
   ['1->2x1,3->2x1']);

console.log('\n5) O saldo é oferecido a TODOS, com a disputa marcada');
const doisQuerendoOMesmoG = [pedido('#novo', 5, [falta('calca','Preto',M,1)]),
                             pedido('#antigo', 45, [falta('calca','Preto',M,1)])];
ok('dois pedidos e 1 peça → os DOIS aparecem (a dona escolhe)',
   numeros(rodar(doisQuerendoOMesmoG, { calca: { Preto: [0,0,0,1,0,0] } })),
   ['#antigo', '#novo']);
ok('só um deles pode sair de fato — o mais parado é o simultâneo',
   simultaneidade(rodar(doisQuerendoOMesmoG, { calca: { Preto: [0,0,0,1,0,0] } })),
   [['#antigo', true], ['#novo', false]]);
ok('o que ficou em disputa aponta com quem disputa',
   rodar(doisQuerendoOMesmoG, { calca: { Preto: [0,0,0,1,0,0] } }).liberaveis.find(p => !p.simultaneo).disputaCom,
   ['#antigo']);
ok('conta de quantos podem sair juntos',
   rodar(doisQuerendoOMesmoG, { calca: { Preto: [0,0,0,1,0,0] } }).simultaneos, 1);
ok('duas peças na arara → os dois saem juntos, sem disputa',
   simultaneidade(rodar(doisQuerendoOMesmoG, { calca: { Preto: [0,0,0,2,0,0] } })),
   [['#antigo', true], ['#novo', true]]);
ok('pedido que ninguém disputa nunca é marcado como disputa',
   simultaneidade(rodar(
     [pedido('#a', 30, [falta('calca','Preto',M,1)]), pedido('#b', 20, [falta('blusa','Nude',M,1)])],
     { calca: { Preto: [0,0,0,1,0,0] }, blusa: { Nude: [0,0,0,1,0] } })),
   [['#a', true], ['#b', true]]);
ok('cor diferente não serve de vizinho',
   numeros(rodar([pedido('#1', 40, [falta('calca','Preto',M,1)])], { calca: { Nude: [0,0,0,5,0,0] } })),
   []);

console.log('\n6) Só o SALDO DISPONÍVEL é oferecido');
// #antigo está travado esperando a blusa, mas a calça M dele JÁ está separada na arara.
// Essa calça não é saldo disponível — não pode virar G para soltar o #novo.
const antigoSegurandoCalca = pedido('#antigo', 45,
  [falta('blusa', 'Preto', M, 1)],
  [req('calca', 'Marsala', M, 1), req('blusa', 'Preto', M, 1)]);
const novoQuerG = pedido('#novo', 10,
  [falta('calca', 'Marsala', G, 1)],
  [req('calca', 'Marsala', G, 1)]);

ok('calça já separada para pedido travado não é oferecida a outro',
   numeros(rodar([antigoSegurandoCalca, novoQuerG], { calca: { Marsala: [0,0,1,0,0,0] }, blusa: { Preto: [0,0,0,0,0] } })),
   []);
ok('havendo 2 na arara, 1 fica reservada e a outra libera o pedido novo',
   numeros(rodar([antigoSegurandoCalca, novoQuerG], { calca: { Marsala: [0,0,2,0,0,0] }, blusa: { Preto: [0,0,0,0,0] } })),
   ['#novo']);
ok('sem ninguém segurando, a peça continua sendo oferecida',
   numeros(rodar([novoQuerG], { calca: { Marsala: [0,0,1,0,0,0] } })),
   ['#novo']);
ok('a reserva não engole peça de tamanho diferente do que o travado segura',
   numeros(rodar(
     [pedido('#antigo', 45, [falta('blusa','Preto',M,1)], [req('calca','Marsala',P,1), req('blusa','Preto',M,1)]), novoQuerG],
     { calca: { Marsala: [0,1,1,0,0,0] }, blusa: { Preto: [0,0,0,0,0] } })),
   ['#novo']);
ok('dois travados segurando a mesma peça: reserva não fica negativa nem sobra fantasma',
   numeros(rodar(
     [pedido('#a', 45, [falta('blusa','Preto',M,1)], [req('calca','Marsala',M,1), req('blusa','Preto',M,1)]),
      pedido('#b', 40, [falta('blusa','Preto',M,1)], [req('calca','Marsala',M,1), req('blusa','Preto',M,1)]),
      novoQuerG],
     { calca: { Marsala: [0,0,1,0,0,0] }, blusa: { Preto: [0,0,0,0,0] } })),
   []);

console.log('\n7) Nunca passa de ESTOQUE − PEDIDOS EM ABERTO (pega até pedido não pago)');
// Pedido aguardando pagamento não entra na fila dos pagos, mas conta na tabela PEDIDOS
// EM ABERTO. O teto de estoque−aberto é o que impede a peça dele de ser oferecida.
ok('1 no estoque e 1 em aberto (pedido não pago) → não oferece',
   numeros(rodar([novoQuerG], { calca: { Marsala: [0,0,1,0,0,0] } }, { calca: { Marsala: [0,0,1,0,0,0] } })),
   []);
ok('2 no estoque e 1 em aberto → sobra 1 e libera',
   numeros(rodar([novoQuerG], { calca: { Marsala: [0,0,2,0,0,0] } }, { calca: { Marsala: [0,0,1,0,0,0] } })),
   ['#novo']);
ok('pedido em aberto de OUTRO tamanho não bloqueia a peça',
   numeros(rodar([novoQuerG], { calca: { Marsala: [0,0,1,0,0,0] } }, { calca: { Marsala: [1,0,0,0,0,0] } })),
   ['#novo']);
ok('pedido em aberto de OUTRA cor não bloqueia a peça',
   numeros(rodar([novoQuerG], { calca: { Marsala: [0,0,1,0,0,0] } }, { calca: { Preto: [0,0,9,0,0,0] } })),
   ['#novo']);
// Peça já separada pra pedido pronto sai do saldo livre mas continua no estoque bruto e
// no aberto — o teto não pode "devolver" essa peça pro card.
ok('peça reservada a pedido pronto não volta pelo teto',
   numeros(rodar([novoQuerG], { calca: { Marsala: [0,0,0,0,0,0] } }, { calca: { Marsala: [0,0,1,0,0,0] } }, { calca: { Marsala: [0,0,2,0,0,0] } })),
   []);

console.log('\n8) Arara vazia / sem pedidos travados');
ok('sem estoque livre → nada a liberar',
   numeros(rodar([pedido('#1', 40, [falta('calca','Preto',M,1)])], {})), []);
ok('sem pedidos pendentes → nada a liberar',
   numeros(rodar([], { calca: { Preto: [9,9,9,9,9,9] } })), []);

console.log('\n9) Botão "troquei" — aplica a troca no estoque');
// A troca física só vira dado aqui: a peça sai do tamanho antigo e entra no novo. É o que
// falta pro pedido virar enviável. O risco é criar peça que não existe na arara.
const aplica = main.slice(main.indexOf('async function aplicarTrocaEtiqueta'),
                          main.indexOf('\nfunction renderTrocaEtiqueta'));
ok('pede confirmação antes de mexer no estoque', /confirm\(/.test(aplica), true);
ok('tira do tamanho antigo', /arr\[tr\.de\]\s*=\s*temNoTamanhoAntigo - mover/.test(aplica), true);
ok('põe no tamanho novo',    /arr\[tr\.para\] = \(arr\[tr\.para\] \|\| 0\) \+ mover/.test(aplica), true);
ok('é uma TRANSFERÊNCIA: não muda o total de peças',
   /const mover = Math\.min\(temNoTamanhoAntigo, tr\.qtd\)/.test(aplica), true);
ok('peça que sumiu entre a tela e o clique não é inventada',
   /if \(mover <= 0\) \{ faltaram\.push/.test(aplica), true);
ok('avisa o que não deu para trocar', /faltaram\.length\) \{[\s\S]{0,120}alert\(/.test(aplica), true);
ok('grava na nuvem', /await salvarNuvem\(pl\.key, saved\)/.test(aplica), true);
ok('completa a grade curta antes de indexar', /while \(arr\.length < nSz\) arr\.push\(0\)/.test(aplica), true);
ok('a lista fica acessível para o botão', /window\._trocasEtiqueta = liberaveis/.test(main), true);
ok('o botão existe na tabela', /onclick="aplicarTrocaEtiqueta\(\$\{idx\}, this\)"/.test(main), true);
// Simula a transferência com a mesma conta do código
const transferir = (arr, de, para, qtd) => {
  const tem = arr[de] || 0, mover = Math.min(tem, qtd);
  if (mover <= 0) return arr.slice();
  const n = arr.slice(); n[de] = tem - mover; n[para] = (n[para] || 0) + mover; return n;
};
ok('G→M com 1 no G: some do G, aparece no M', transferir([0,0,0,1,0,0], 3, 2, 1), [0,0,1,0,0,0]);
ok('total de peças não muda',
   transferir([0,0,0,1,0,0], 3, 2, 1).reduce((a,b)=>a+b,0), 1);
ok('sem peça no tamanho antigo, nada muda', transferir([0,0,0,0,0,0], 3, 2, 1), [0,0,0,0,0,0]);
ok('pede 2 e só tem 1: move 1, não inventa o segundo', transferir([0,0,0,1,0,0], 3, 2, 2), [0,0,1,0,0,0]);

console.log(`\n${falhas === 0 ? '✓ TODOS OS TESTES PASSARAM' : '✗ ' + falhas + ' FALHA(S)'} — ${total - falhas}/${total}\n`);
process.exit(falhas === 0 ? 0 : 1);
