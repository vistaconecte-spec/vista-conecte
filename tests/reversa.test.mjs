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
  const atdSyncViews = () => {};
  ${main.slice(a, b)}
  ${main.slice(main.indexOf('const TRC_ETAPAS'), main.indexOf('function trcCartaoHtml'))}
  return { revNumeroPedido, revCodigoAtual, revPecas, revStatus, revAplicarCodigos, revPedir, trcEtapa, trcNoQuadro, salvos };
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

console.log('\n6) Etapa no quadro da aba TROCAS');
{
  const agora = new Date().toISOString();
  const L = lab({
    'vc:reversas-pedido': { itens: [{ id: 'retorno:q', pedido_em: agora }] },
    'vc:reversas-resultado': { itens: { 'retorno:c': { status: 'carrinho', servico: 'PAC Reverso', preco: 24.97, em: agora } } },
  });
  ok('sem nada: pedido feito', L.trcEtapa({ id: 'n', pedido: '#1' }), 'pedido');
  ok('na fila do robô: pra pagar', L.trcEtapa({ id: 'q', pedido: '#1' }), 'pagar');
  ok('no carrinho: pra pagar', L.trcEtapa({ id: 'c', pedido: '#1' }), 'pagar');
  ok('com código: esperando a peça', L.trcEtapa({ id: 'x', pedido: '#1', codigo_logistica_reversa: 'AP337664240BR' }), 'esperando');
  ok('chegou', L.trcEtapa({ id: 'x', pedido: '#1', codigo_logistica_reversa: 'AP1', data_chegada_reversa: '2026-09-04', chegou_reversa: true }), 'chegou');
  ok('com reenvio: enviada', L.trcEtapa({ id: 'x', data_chegada_reversa: '2026-09-04', codigo_reenvio: 'AD1' }), 'enviada');
  ok('resolvida: enviada', L.trcEtapa({ id: 'x', status: 'resolvido' }), 'enviada');
  ok('resolvida há 20 dias sai do quadro', L.trcNoQuadro({ status: 'resolvido', resolvido_em: new Date(Date.now() - 20 * 864e5).toISOString() }), false);
  ok('aberta fica no quadro', L.trcNoQuadro({ status: 'pendente' }), true);
}

console.log('\n7) Rastreio da devolução (robô de hora em hora, 20/10/2026)');
{
  const a = main.indexOf('// ── Rastreio da devolução da troca'), b = main.indexOf('// ── Portal de trocas da cliente');
  const agora = Date.parse('2026-10-20T12:00:00Z');
  const mem = {
    'vc:rastreio-trocas': { itens: {
      'retorno:r1': { entregue: true, entregue_em: '2026-10-19T15:00:00Z', postado: true },
      'retorno:r2': { postado: false, vence_em: '2026-10-21T12:00:00Z' },
      'retorno:r3': { postado: false, vence_em: '2026-10-19T12:00:00Z' },
      'retorno:r4': { postado: true, vence_em: '2026-10-19T12:00:00Z' },
      'retorno:r5': { entregue: true, entregue_em: '2026-10-18T15:00:00Z' },
    } },
    'vc:retorno': { itens: [
      { id: 'r1', status: 'pendente', codigo_logistica_reversa: 'AP1' },
      { id: 'r5', status: 'pendente', codigo_logistica_reversa: 'AP5', data_chegada_reversa: '2026-10-10', chegou_reversa: true },
    ] },
  };
  const R = new Function('mem', `
    const loadLocal = k => mem[k] ? JSON.parse(JSON.stringify(mem[k])) : null;
    const carimbarItem = t => { t.atualizado_em = 'agora'; return t; };
    const retGetConfig = () => loadLocal('vc:retorno');
    const retSalvar = c => { mem['vc:retorno'] = c; };
    const estGetConfig = () => loadLocal('vc:estorno') || { itens: [] };
    const estSalvar = c => { mem['vc:estorno'] = c; };
    const estConcluida = t => t.status === 'resolvido' || t.etapa === 'concluido';
    const atdSyncViews = () => {};
    ${main.slice(a, b)}
    return { trcVencimento, revAplicarRastreio };
  `)(mem);
  ok('faltando 1 dia sem postar: laranja', R.trcVencimento({ id: 'r2' }, agora)?.cor, '#e0892b');
  ok('vencido sem postar: vermelho', R.trcVencimento({ id: 'r3' }, agora)?.cor, '#dc2626');
  ok('postado não alerta, mesmo depois do prazo', R.trcVencimento({ id: 'r4' }, agora), null);
  ok('entregue pelos Correios: 1 linha marcada como chegou', R.revAplicarRastreio(), 1);
  const r1 = mem['vc:retorno'].itens[0], r5 = mem['vc:retorno'].itens[1];
  ok('chegada pelo rastreio com a data da entrega', [r1.chegou_reversa, r1.chegada_por_rastreio, r1.data_chegada_reversa.length], [true, true, 10]);
  ok('chegada marcada à mão não muda', r5.data_chegada_reversa, '2026-10-10');
}

console.log('\n8) Troca do portal fecha quando a peça nova é despachada (20/10/2026)');
{
  const a = main.indexOf('async function trcConferirShopify() {'), b = main.indexOf('async function trcAtualizar() {');
  const mem = { 'vc:retorno': { itens: [
    { id: 'p1', portal_id: 'troca-portal:9250-x', pedido: '#9250', pedido_troca: '#9401', status: 'pendente', conferido_em: 'x' },
    { id: 'p2', portal_id: 'troca-portal:9251-x', pedido: '#9251', pedido_troca: '#9402', status: 'pendente', conferido_em: 'x' },
    { id: 'm1', pedido: '#8705', status: 'pendente' },
  ] } };
  const respostas = { troca_status: {
    '#9401': { name: '#9401', enviado: true, pecas: 1, enviadas: 1, rastreios: ['AA123'] },
    '#9402': { name: '#9402', enviado: false, pecas: 2, enviadas: 1, rastreios: ['BB1'] },
  }, pedidos: { '#8705': null } };
  const R = new Function('mem', 'respostas', `
    const retGetConfig = () => mem['vc:retorno'];
    const retSalvar = c => { mem['vc:retorno'] = c; };
    const carimbarItem = t => { t.atualizado_em = 'agora'; return t; };
    const atdSyncViews = () => {};
    const fetch = async () => ({ ok: true, json: async () => respostas });
    ${main.slice(a, b)}
    return { trcConferirShopify };
  `)(mem, respostas);
  await R.trcConferirShopify();
  const [p1, p2, m1] = mem['vc:retorno'].itens;
  ok('tudo despachado: fecha com o rastreio no reenvio', [p1.status, p1.codigo_reenvio], ['resolvido', 'AA123']);
  ok('1 de 2: continua aberta e mostra o parcial', [p2.status, p2.pedido_troca_envio], ['pendente', '1 de 2 peças enviadas']);
  ok('manual sem pedido de troca: aviso vermelho', m1.pedido_troca_ausente, true);
}

console.log('\n9) Etapa no quadro da Devolução (20/10/2026)');
{
  const a = main.indexOf('const DEV_ETAPAS'), b = main.indexOf('function devCartaoHtml');
  const L = lab({ 'vc:reversas-pedido': { itens: [] }, 'vc:reversas-resultado': { itens: {} } });
  const D = new Function('L', `
    const estConcluida = t => t.status === 'resolvido' || t.etapa === 'concluido';
    const revCodigoAtual = L.revCodigoAtual, revStatus = L.revStatus;
    const TRC_CONCLUIDA_DIAS = 15;
    const valeEhCredito = t => t.forma === 'credito';
    ${main.slice(a, b)}
    return { devEtapa, devNoQuadro };
  `)(L);
  ok('sem nada: pedido feito', D.devEtapa({ id: 'e1', pecas: 'x — pedido #1' }), 'pedido');
  ok('com código da reversa: esperando', D.devEtapa({ id: 'e1', pecas: 'x — pedido #1', codigo_devolucao: '4665143571' }), 'esperando');
  ok('#9250-R1 da Shopify não é código: pedido feito', D.devEtapa({ id: 'e1', pecas: 'x — pedido #1', codigo_devolucao: '#9250-R1' }), 'pedido');
  ok('chegou, dinheiro de volta', D.devEtapa({ id: 'e1', chegou_em: '2026-10-20T10:00:00Z', codigo_devolucao: 'AP1' }), 'chegou_dinheiro');
  ok('chegou, crédito em coluna própria (29/10)', D.devEtapa({ id: 'e1', chegou_em: '2026-10-20T10:00:00Z', codigo_devolucao: 'AP1', forma: 'credito' }), 'chegou_credito');
  ok('estorno feito: concluída', D.devEtapa({ id: 'e1', chegou_em: 'x', etapa: 'concluido', estorno_feito_em: 'x' }), 'concluida');
  ok('concluída há 20 dias sai do quadro', D.devNoQuadro({ etapa: 'concluido', estorno_feito_em: new Date(Date.now() - 20 * 864e5).toISOString() }), false);
  ok('concluída hoje também sai: fica no botão concluídas (29/10)', D.devNoQuadro({ etapa: 'concluido', estorno_feito_em: new Date().toISOString() }), false);
  ok('aberta continua no quadro', D.devNoQuadro({ id: 'e9', chegou_em: 'x' }), true);
}

console.log(falhas ? `\n✗ ${falhas} de ${total} falharam` : `\n✓ TODOS OS TESTES PASSARAM — ${total}/${total}`);
if (falhas) process.exit(1);
