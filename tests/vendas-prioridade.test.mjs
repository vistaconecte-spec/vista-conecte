/**
 * Testes da aba VENDAS (rascunhos da Shopify) e da PRIORIDADE DE LIBERACAO do SAC.
 *
 * POR QUE ISTO EXISTE: pedidos da dona no grupo Sac/Expedicao em 11/09/2026:
 *   - "criar uma aba vendas da Marcelly, puxar os pedidos criados em rascunho; nao puxar os
 *     pedidos com valor R$ 0 (sao trocas)";
 *   - "criar uma prioridade no sac de liberacao dos pedidos com ocorrencia de clientes,
 *     casos mais urgentes de envio" (a planilha antiga escrevia "URGENTE//" no motivo).
 *
 * Rodar:  node tests/vendas-prioridade.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const html = readFileSync(join(raiz, 'index.html'), 'utf8');
const api  = await import(pathToFileURL(join(raiz, 'functions', 'api', 'shopify-rascunhos.js')).href);

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  X ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ok ${nome}`);
}

console.log('\n1) Rascunho de R$ 0 e troca: fica fora da conta, mas a tela sabe que existe');
{
  const drafts = [
    { id: 1, name: '#D2750', created_at: '2026-09-10T14:05:00-03:00', status: 'completed', total_price: '548.75', order_id: 901, customer: { first_name: 'Isabelle', last_name: 'Ferreira' }, line_items: [{ quantity: 1, title: 'Macaquinho Amplo', variant_title: 'Preto / M' }] },
    { id: 2, name: '#D2748', created_at: '2026-09-10T10:30:00-03:00', status: 'completed', total_price: '0.00',   order_id: 902, customer: { first_name: 'Leticia' }, line_items: [] },
    { id: 3, name: '#D2752', created_at: '2026-09-11T09:00:00-03:00', status: 'open',      total_price: '199.00', order_id: null, customer: null, shipping_address: { name: 'Ana' }, line_items: [] },
    { id: 4, name: '#D2600', created_at: '2026-08-30T09:00:00-03:00', status: 'completed', total_price: '300.00', order_id: 903, customer: { first_name: 'Fora' }, line_items: [] },
  ];
  const pedidos = { '901': { name: '#9048', financial_status: 'paid', fulfillment_status: null, cancelled_at: null } };
  const r = api.montarLista(drafts, pedidos, '2026-09-01', '2026-09-30');
  ok('so os do periodo e com valor entram', r.rascunhos.map(x => x.numero), ['#D2752', '#D2750']);
  ok('a troca de R$ 0 e contada a parte', r.ocultos_zero, 1);
  ok('total soma so o que vale', r.total, 747.75);
  ok('o rascunho concluido traz o pedido gerado', r.rascunhos[1].pedido, { id: 901, numero: '#9048', pago: true, enviado: false, cancelado: false });
  ok('o aberto nao tem pedido', r.rascunhos[0].pedido, null);
  ok('cliente sai do endereco quando nao ha cadastro', r.rascunhos[0].cliente, 'Ana');
  ok('mais novo primeiro', r.rascunhos[0].criado_em > r.rascunhos[1].criado_em, true);
}

console.log('\n2) A leitura da Shopify segue a paginacao e usa updated_at_min');
{
  const chamadas = [];
  const fetchFalso = async (url) => {
    chamadas.push(url);
    const pag2 = url.includes('page_info=xyz');
    return {
      ok: true,
      json: async () => ({ draft_orders: [{ id: pag2 ? 2 : 1 }] }),
      headers: { get: h => (h === 'link' && !pag2) ? '<https://loja/admin/api/2024-04/draft_orders.json?limit=250&page_info=xyz>; rel="next"' : null },
    };
  };
  const lista = await api.listarRascunhos('loja', 'tok', '2026-09-01T00:00:00-03:00', fetchFalso);
  ok('duas paginas viraram uma lista', lista.map(x => x.id), [1, 2]);
  ok('a primeira chamada filtra por updated_at_min', /updated_at_min=2026-09-01/.test(chamadas[0]), true);
  ok('a segunda segue o Link', /page_info=xyz/.test(chamadas[1]), true);
}

console.log('\n3) A tela VENDAS existe e e so leitura');
ok('pill Vendas ao lado das outras', /atd-pill-vendas[\s\S]{0,80}atdShowSub\('vendas'\)/.test(html), true);
ok('atdShowSub conhece vendas', /\['kanban', 'sac', 'retorno', 'estorno', 'vendas'\]/.test(main), true);
ok('abrir a aba busca na Shopify', /else if \(sub === 'vendas'\) vndCarregar\(\);/.test(main), true);
ok('a aba le /api/shopify-rascunhos', /fetch\(`\/api\/shopify-rascunhos\?desde=\$\{desde\}&ate=\$\{ate\}`/.test(main), true);
{
  const ini = main.indexOf('function vndPeriodo'), fim = main.indexOf('function retGetConfig');
  ok('nada da aba grava no Supabase', /salvarNuvem|saveLocal/.test(main.slice(ini, fim)), false);
}
ok('a nota explica as trocas de R$ 0 ocultas', /nao entra|não entra/.test(main), true);

console.log('\n3b) Comissao da Marcelly: 5% do total, calculada no sistema');
ok('a taxa e 5%', /const VND_COMISSAO = 0\.05;/.test(main), true);
ok('a metrica existe na tela', /id="vnd-comissao"/.test(html), true);
ok('e sai do total que conta (sem as trocas de R$ 0 e sem o que a dona tirou)', /set\('vnd-comissao', fmtBRL\(totalContam \* VND_COMISSAO\)\);/.test(main), true);

console.log('\n3c) A dona marca o rascunho que nao e venda da Marcelly, e a comissao recalcula');
{
  // Em 11/09/2026 a Marcelly apontou 3 rascunhos de setembro que nao fez. A Shopify nao diz
  // quem criou, entao a excecao e marcada a mao e fica na nuvem (chave vendas-comissao).
  const ini = main.indexOf('const VND_EXCL_KEY'), fim = main.indexOf('function vndPeriodo');
  const trecho = main.slice(ini, fim);
  ok('a lista de excluidos mora na chave vendas-comissao', /const VND_EXCL_KEY = 'vendas-comissao';/.test(main), true);
  ok('marcar grava pela mesclagem (varios aparelhos)', /salvarListaCompartilhada\(VND_EXCL_KEY, 'excluidos', cfg\)/.test(trecho), true);
  ok('desmarcar registra o id em removidos (senao a mesclagem traz de volta)', /cfg\.removidos = \[\.\.\.\(cfg\.removidos \|\| \[\]\), \{ id: String\(id\)/.test(trecho), true);
  ok('a comissao sai so do que conta', /set\('vnd-comissao', fmtBRL\(totalContam \* VND_COMISSAO\)\);/.test(main), true);
  ok('as vendas e o total tambem', /set\('vnd-qtd', contam\.length\);[\s\S]{0,80}set\('vnd-total', fmtBRL\(totalContam\)\);/.test(main), true);
  ok('a tela mostra quantas ficaram de fora', /id="vnd-fora"/.test(html) && /set\('vnd-fora'/.test(main), true);
  ok('cada linha tem o botao', /onclick="vndToggleComissao\('\$\{r\.id\}'\)"/.test(main), true);
}

console.log('\n4) Prioridade no SAC');
ok('o formulario tem o URGENTE', /id="sac-urgente"/.test(html), true);
ok('sacAdd grava urgente', /rastreio, urgente, status: 'pendente'/.test(main), true);
ok('o card de prioridade existe', /id="sac-prioridade-card"/.test(html), true);
ok('urgente pendente vai para o topo da lista', /const ua = \(a\.urgente && a\.status !== 'resolvido'\) \? 1 : 0/.test(main), true);
ok('marcar urgente carimba o item (mesclagem entre aparelhos)', /function sacUrgenteToggle\(id\) \{[\s\S]{0,160}carimbarItem\(t\);/.test(main), true);
ok('resolvido some do card de prioridade', /\.filter\(t => t\.urgente && t\.status !== 'resolvido'\)/.test(main), true);
ok('no card, o mais antigo primeiro (esta esperando ha mais tempo)', /\.sort\(\(a, b\) => \(a\.criado_em \|\| ''\)\.localeCompare\(b\.criado_em \|\| ''\)\); \/\/ o mais antigo primeiro/.test(main), true);
ok('o Kanban mostra o selo', /c\.tipo === 'sac' && c\.t\.urgente && !isConcl/.test(main), true);
ok('a tabela ganhou a coluna (colspan acompanha)', /colspan="7"/.test(main) && /colspan="3" style="text-align:left;padding:4px 4px 2px;color:#9a8870/.test(html), true);

console.log(falhas ? `\nX ${falhas} de ${total} falharam\n` : `\n${total}/${total} passaram\n`);
process.exit(falhas ? 1 : 0);
