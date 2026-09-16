/**
 * Teste do botão "Tirar da compra o que não tem pedido" (card PRODUÇÃO ACIMA DO
 * NECESSÁRIO, main.js).
 *
 * POR QUE ISTO EXISTE: o botão zera peças de leva. Se ele tirar de leva já cortada, ou
 * tirar peça que ainda tem pedido, some produção de verdade. A regra: só leva em
 * "Comprando tecido", só o que passa de Pedidos − Estoque, primeiro da 2ª leva.
 *
 * Rodar:  node tests/sobra-compra.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const html = readFileSync(join(raiz, 'index.html'), 'utf8');

function extrair(nome) {
  const i = main.indexOf(`function ${nome}(`);
  if (i < 0) throw new Error(`função ${nome} não encontrada em main.js`);
  const fim = main.indexOf('\n}', i);
  return main.slice(i, fim + 2);
}
const corpo = ['chaveCor', 'coresDoModelo', 'sobrasNaCompra'].map(extrair).join('\n');
const sobras = new Function('saved', 'def', `${corpo}\nreturn sobrasNaCompra(saved, def);`);

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

const DEF = { nome: 'Regata', cores: ['Preto'], aberto: { Preto: [0,0,1,0,0] } };

console.log('\n1) Leva em compra com peça sem pedido → sai só o que sobra');
{
  // pedidos M1 · estoque P1 G2 · leva 1 (compra) P1 M4 G2 GG2 → precisa só M1: sobram P1 M3 G2 GG2
  const r = sobras({ status: 'Comprando tecido', prod: { Preto: [0,1,4,2,2] }, est: { Preto: [0,1,0,2,2] } }, DEF);
  ok('tira 8 peças da leva 1', [r.total, r.tira1], [8, { Preto: [0,1,3,2,2] }]);
  ok('nada na 2ª leva', r.tira2, {});
}

console.log('\n2) Leva em corte NÃO é mexida, mesmo com sobra');
{
  ok('em corte → null', sobras({ status: 'Em corte', prod: { Preto: [0,1,4,2,2] } }, DEF), null);
  ok('em costura → null', sobras({ status: 'Em costura', prod: { Preto: [0,1,4,2,2] } }, DEF), null);
  ok('sem status → null (não é produção)', sobras({ status: '', prod: { Preto: [0,1,4,2,2] } }, DEF), null);
}

console.log('\n3) Leva 1 em corte + 2ª leva em compra: a sobra sai da 2ª, e só até o que ela tem');
{
  // pedidos M1 · leva 1 (corte) M3 · leva 2 (compra) M2 → sobram 4, a 2ª só tem 2
  const r = sobras({ status: 'Em corte', prod: { Preto: [0,0,3,0,0] }, status2: 'Comprando tecido', prod2: { Preto: [0,0,2,0,0] } }, DEF);
  ok('2ª leva perde as 2 que tem', r.tira2, { Preto: [0,0,2,0,0] });
  ok('leva 1 (corte) fica intacta', r.tira1, {});
  ok('total 2, não 4', r.total, 2);
}

console.log('\n4) As duas em compra: sai primeiro da 2ª leva, o resto da 1ª');
{
  // pedidos M1 · leva 1 M3 · leva 2 M2 → sobram 4: 2 da leva 2 + 2 da leva 1
  const r = sobras({ status: 'Comprando tecido', prod: { Preto: [0,0,3,0,0] }, status2: 'Comprando tecido', prod2: { Preto: [0,0,2,0,0] } }, DEF);
  ok('2ª leva zera', r.tira2, { Preto: [0,0,2,0,0] });
  ok('leva 1 perde 2 e guarda a do pedido', r.tira1, { Preto: [0,0,2,0,0] });
}

console.log('\n5) Peça com pedido nunca sai');
{
  ok('leva igual ao pedido → null', sobras({ status: 'Comprando tecido', prod: { Preto: [0,0,1,0,0] } }, DEF), null);
  ok('leva menor que o pedido → null', sobras({ status: 'Comprando tecido', prod: { Preto: [0,0,0,0,0] } }, { ...DEF, aberto: { Preto: [0,0,5,0,0] } }), null);
}

console.log('\n6) Tamanho único conta por total, na posição 0');
{
  const TU = { nome: 'Bolsa', cores: ['Preto'], tamanhoUnico: true, aberto: { Preto: [1,1,0,0,0] } };
  const r = sobras({ status: 'Comprando tecido', prod: { Preto: [5,0,0,0,0] }, est: { Preto: [1,0,0,0,0] } }, TU);
  ok('2 pedidos − 1 estoque = 1 precisa; leva 5 → tira 4 na posição 0', r.tira1, { Preto: [4,0,0,0,0] });
}

console.log('\n7) Tela e gravação');
{
  ok('botão no card, escondido até ter o que tirar', /id="dash-duplicado-btn"[^>]*display:none[^>]*onclick="tirarSobraDaCompra\(\)"/.test(html), true);
  ok('o card recalcula a contagem do botão com sobrasNaCompra', /dupBtn\.innerHTML = `<i class="ti ti-eraser"><\/i> Tirar da compra o que não tem pedido \(\$\{naCompra\}\)`/.test(main), true);
  ok('grava lendo a nuvem e recontando lá', /gravarModeloNaNuvem\(it\.key, saved => \{\s*const s = sobrasNaCompra\(saved, def\);/.test(main), true);
  ok('leva vazia volta para sem status', /aplicar\('prod2', s\.tira2\)\) \{ saved\.status2 = ''; saved\.status2_at = null; \}/.test(main), true);
  ok('oficina não aciona', /async function tirarSobraDaCompra\(\) \{\s*if \(ehPerfilOficina\(\)\) return;/.test(main), true);
  const iT = main.indexOf('async function tirarSobraDaCompra()'), iU = main.indexOf('async function mandarUrgentesParaProducao()');
  const trecho = (i) => main.slice(i, main.indexOf('const itens = [];', i) > 0 && main.indexOf('const itens = [];', i) < i + 1500 ? main.indexOf('const itens = [];', i) : i + 1200);
  ok('pedidos parados → não grava (tirar da compra)', /if \(!leituraDePedidosFresca\(\)\) \{[\s\S]*?nada foi feito[\s\S]*?return;\s*\}/.test(trecho(iT)), true);
  ok('pedidos parados → não grava (mandar tudo p/ produção)', /if \(!leituraDePedidosFresca\(\)\) \{[\s\S]*?nada foi feito[\s\S]*?return;\s*\}/.test(trecho(iU)), true);
}

console.log(falhas ? `\n✗ ${falhas} de ${total} falharam` : `\n✓ ${total}/${total} passaram`);
process.exit(falhas ? 1 : 0);
