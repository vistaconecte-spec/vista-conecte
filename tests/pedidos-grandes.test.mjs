/**
 * Teste do card PEDIDOS GRANDES: LIBERAR COM CARINHO (main.js).
 *
 * POR QUE ISTO EXISTE: pedido de 5 peças ou mais é cliente que confiou de verdade na loja,
 * e a Bárbara pediu (21/09/2026) que esses saiam conferidos, embalados impecáveis e com
 * brinde. O card junta os grandes que já podem sair com os grandes travados por falta de
 * peça. Aqui a função REAL que monta essa lista roda sem DOM.
 *
 * Rodar:  node tests/pedidos-grandes.test.mjs
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
  if (!bateu) { falhas++; console.log(`  X ${nome}` + '\n' + `      esperado: ${JSON.stringify(esperado)}` + '\n' + `      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ok ${nome}`);
}

const pedaco = (ini, fim) => {
  const a = main.indexOf(ini), b = main.indexOf(fim, a);
  if (a < 0 || b < 0) throw new Error('trecho nao encontrado: ' + ini);
  return main.slice(a, b);
};
const { listarPedidosGrandes, grandesCompleto, GRANDES_PASSOS } = new Function(`
  const diasDesde = d => Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  ${pedaco('const GRANDES_CHAVE', 'function grandesGetConfig')}
  ${pedaco('function grandesCompleto', 'function grandesSalvar')}
  return { listarPedidosGrandes, grandesCompleto, GRANDES_PASSOS };
`)();

const it = (qtd) => ({ modelKey: 'calca-flare', cor: 'Preto', tam: 2, qtd });

console.log('\n' + '1) Só entra quem tem 5 peças ou mais (o mesmo GRANDE_MIN dos prontos)');
{
  const prontos = [
    { id: 1, numero: '#9001', itens: [it(2), it(2)], dias: 1 },          // 4 peças: não é grande
    { id: 2, numero: '#9002', itens: [it(3), it(2)], dias: 1, valor: '899.90' }, // 5 peças
  ];
  const lista = listarPedidosGrandes(prontos, [], 5);
  ok('4 peças fica de fora, 5 entra', lista.map(p => p.numero), ['#9002']);
  ok('valor vem como número', lista[0].valor, 899.9);
  ok('peças somadas', lista[0].pecas, 5);
  ok('pronto vem marcado', lista[0].pronto, true);
}

console.log('\n' + '2) Prontos primeiro, depois os parados do mais antigo pro mais novo');
{
  const prontos = [{ id: 1, numero: '#P-novo', itens: [it(6)], dias: 2 }];
  const pendentes = [
    { id: 2, numero: '#T-5d',  itens: [it(5)], dias: 5,  faltas: [{ key: 'calca-flare', cor: 'Preto', tam: 2, qtd: 5, falta: 1 }] },
    { id: 3, numero: '#T-20d', itens: [it(7)], dias: 20, faltas: [{ key: 'calca-flare', cor: 'Preto', tam: 2, qtd: 7, falta: 3 }] },
    { id: 4, numero: '#T-peq', itens: [it(2)], dias: 40, faltas: [] }, // pequeno, fora
  ];
  const lista = listarPedidosGrandes(prontos, pendentes, 5);
  ok('ordem: pronto, depois parado mais antigo', lista.map(p => p.numero), ['#P-novo', '#T-20d', '#T-5d']);
  ok('parado carrega as faltas', lista[1].faltas.map(f => f.falta), [3]);
  ok('pronto não tem falta', lista[0].faltas, []);
  ok('id vira texto (chave da marcação compartilhada)', lista.map(p => p.id), ['1', '3', '2']);
}

console.log('\n' + '3) Os três passos do carinho');
{
  ok('são conferido, embalagem e brinde', GRANDES_PASSOS.map(p => p.campo), ['conferido', 'embalagem', 'brinde']);
  ok('dois de três não é completo', grandesCompleto({ conferido: true, embalagem: true }), false);
  ok('os três é completo', grandesCompleto({ conferido: true, embalagem: true, brinde: true }), true);
  ok('sem marcação nenhuma', grandesCompleto({}), false);
}

console.log('\n' + '4) Lista vazia não quebra');
{
  ok('sem pedidos', listarPedidosGrandes([], [], 5), []);
  ok('undefined', listarPedidosGrandes(undefined, undefined, 5), []);
}

console.log(`\n${total - falhas}/${total} passaram`);
if (falhas) process.exit(1);
