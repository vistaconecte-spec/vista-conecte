/**
 * "Pedir reversa" nas listas de Troca e Devolução (main.js, 19/10/2026).
 *
 * O robô do notebook (frete-frenet/robo-etiquetas.mjs) monta a reversa na Frenet a partir da
 * etiqueta de ida e devolve o código em `reversas-resultado`. Trava aqui:
 *  1. o número do pedido sai certo das duas listas (na Devolução ele vem no texto das peças);
 *  2. "#9250-R1" é o nome da devolução na Shopify, não código dos Correios: não esconde o botão
 *     e é substituído pelo código de verdade;
 *  3. código digitado à mão nunca é sobrescrito pelo do robô;
 *  4. o status mostra carrinho/fila/erro, e erro libera pedir de novo.
 *
 * Rodar:  node tests/reversa.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

const a = main.indexOf('const REV_SERVICO_PADRAO'), b = main.indexOf('// ── Portal de trocas da cliente');
const lab = new Function('mem', `
  const local = mem;
  const loadLocal = k => local[k] ? JSON.parse(JSON.stringify(local[k])) : null;
  const saveLocal = (k, v) => { local[k] = JSON.parse(JSON.stringify(v)); };
  const carimbarItem = t => { t.atualizado_em = 'agora'; return t; };
  const retGetConfig = () => loadLocal('vc:retorno') || { itens: [] };
  const estGetConfig = () => loadLocal('vc:estorno') || { itens: [] };
  const salvos = [];
  const retSalvar = c => { saveLocal('vc:retorno', c); salvos.push('retorno'); };
  const estSalvar = c => { saveLocal('vc:estorno', c); salvos.push('estorno'); };
  const retRender = () => {}, estRender = () => {};
  const salvarListaCompartilhada = async () => {};
  const alert = () => {};
  const estConcluida = t => t.status === 'resolvido' || t.etapa === 'concluido';
  ${main.slice(a, b)}
  return { revNumeroPedido, revCodigoAtual, revPecas, revStatus, revAplicarCodigos, revPedir, salvos };
`);

console.log('\n1) Número do pedido e peças');
{
  const L = lab({});
  ok('troca: campo pedido', L.revNumeroPedido('retorno', { pedido: '#9250' }), '#9250');
  ok('devolução: do texto das peças', L.revNumeroPedido('estorno', { pecas: '1× Calça Pantalona (Uva / G) — pedido #9250' }), '#9250');
  ok('devolução manual sem pedido', L.revNumeroPedido('estorno', { pecas: 'Sherpa preto GG' }), '');
  ok('peças da troca (portal)', L.revPecas('retorno', { produtos: '1× Calça Pantalona (Uva / G) → troca por Uva / M · motivo: Ficou grande' }), [{ nome: 'Calça Pantalona (Uva / G)', qtd: 1, preco: null }]);
  ok('peças da devolução com preço por unidade', L.revPecas('estorno', { pecas: '2× Calça Bolso Frontal (Preta / G) — pedido #9250', valor: 304.1 }), [{ nome: 'Calça Bolso Frontal (Preta / G)', qtd: 2, preco: 152.05 }]);
}

console.log('\n2) Código atual');
{
  const L = lab({});
  ok('#9250-R1 não é código dos Correios', L.revCodigoAtual('estorno', { codigo_devolucao: '#9250-R1' }), '');
  ok('AP...BR é', L.revCodigoAtual('estorno', { codigo_devolucao: 'AP096592174BR' }), 'AP096592174BR');
  ok('com código, nada de botão', L.revStatus('retorno', { id: 'r1', pedido: '#1', codigo_logistica_reversa: '4665143571' }).pode, false);
  ok('sem código e com pedido, botão', L.revStatus('retorno', { id: 'r1', pedido: '#1' }).pode, true);
  ok('peça que já chegou dos Correios: sem botão', L.revStatus('retorno', { id: 'r1', pedido: '#8672', data_chegada_reversa: '2026-09-04', chegou_reversa: true }).pode, false);
  ok('troca resolvida: sem botão', L.revStatus('retorno', { id: 'r1', pedido: '#1', status: 'resolvido' }).pode, false);
  ok('devolução concluída: sem botão', L.revStatus('estorno', { id: 'e1', pecas: 'x — pedido #1', etapa: 'concluido' }).pode, false);
}

console.log('\n3) Status vindo do robô');
{
  const agora = new Date().toISOString();
  const mem = {
    'vc:reversas-pedido': { itens: [{ id: 'retorno:r1', pedido_em: agora }, { id: 'estorno:e2', pedido_em: '2026-10-19T10:00:00Z' }] },
    'vc:reversas-resultado': { itens: {
      'retorno:r1': { status: 'carrinho', servico: 'PAC Reverso', preco: 24.97, em: agora },
      'estorno:e2': { status: 'erro', erro: 'não achei a etiqueta', em: '2026-10-19T11:00:00Z' },
    } },
  };
  const L = lab(mem);
  const c = L.revStatus('retorno', { id: 'r1', pedido: '#9250' });
  ok('no carrinho: falta pagar, sem botão', [/falta pagar/.test(c.txt), c.pode], [true, false]);
  const e = L.revStatus('estorno', { id: 'e2', pecas: 'x — pedido #9' });
  ok('erro mais novo que o pedido: mostra e libera de novo', [e.txt, e.pode], ['robô: não achei a etiqueta', true]);
  ok('na fila', L.revStatus('retorno', { id: 'r9', pedido: '#9' }).pode, true);
}

console.log('\n4) Código do robô entra na linha');
{
  const mem = {
    'vc:retorno': { itens: [{ id: 'r1', pedido: '#9250', codigo_logistica_reversa: '' }, { id: 'r2', pedido: '#9251', codigo_logistica_reversa: 'DIGITADO' }] },
    'vc:estorno': { itens: [{ id: 'e1', pecas: 'x — pedido #9250', codigo_devolucao: '#9250-R1' }] },
    'vc:reversas-resultado': { itens: {
      'retorno:r1': { status: 'codigo', codigo: '4665143571' },
      'retorno:r2': { status: 'codigo', codigo: '9999999999' },
      'estorno:e1': { status: 'codigo', codigo: '4636888107' },
      'estorno:e9': { status: 'codigo', codigo: '1' },
    } },
  };
  const L = lab(mem);
  ok('aplicou em 2 linhas', L.revAplicarCodigos(), 2);
  ok('troca recebeu o código', mem['vc:retorno'].itens[0].codigo_logistica_reversa, '4665143571');
  ok('código digitado à mão ficou', mem['vc:retorno'].itens[1].codigo_logistica_reversa, 'DIGITADO');
  ok('#R1 da Shopify trocado pelo código', mem['vc:estorno'].itens[0].codigo_devolucao, '4636888107');
  ok('rodar de novo não regrava', L.revAplicarCodigos(), 0);
}

console.log('\n5) Pedir reversa grava na fila');
{
  const mem = { 'vc:estorno': { itens: [{ id: 'e1', pecas: '1× Calça Pantalona (Uva / G) — pedido #9250', valor: 135.95 }] } };
  const L = lab(mem);
  await L.revPedir('estorno', 'e1');
  const it = mem['vc:reversas-pedido'].itens[0];
  ok('item na fila com pedido, peças e PAC Reverso', [it.id, it.numero, it.servico, it.pecas[0].preco], ['estorno:e1', '#9250', '03301', 135.95]);
  await L.revPedir('estorno', 'e1');
  ok('pedir de novo não duplica', mem['vc:reversas-pedido'].itens.length, 1);
}

console.log(falhas ? `\n✗ ${falhas} de ${total} falharam` : `\n✓ TODOS OS TESTES PASSARAM — ${total}/${total}`);
if (falhas) process.exit(1);
