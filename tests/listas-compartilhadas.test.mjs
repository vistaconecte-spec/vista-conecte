/**
 * Teste das listas que o SAC e a Expedição preenchem juntos (main.js).
 *
 * POR QUE ISTO EXISTE: em 08 e 09/09/2026 a equipe avisou no grupo que "estou tentando
 * por os pedidos do sac e da wati na lista mas não está indo" e voltou a usar a lista de
 * papel. Cada alteração gravava o array INTEIRO na mesma chave do Supabase: com duas
 * pessoas incluindo ao mesmo tempo, a última gravação apagava o item da outra.
 *
 * Aqui a função REAL de mesclagem do main.js roda contra os casos que apareceram.
 *
 * Rodar:  node tests/listas-compartilhadas.test.mjs
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
const { mesclarListas, carimbarItem } = new Function(`
  ${pedaco('const LISTA_REMOVIDO_DIAS', 'async function salvarListaCompartilhada')}
  return { mesclarListas, carimbarItem };
`)();

const ids = l => l.tickets.map(t => t.id).sort();

console.log('\n' + '1) O caso da equipe: duas pessoas incluindo ao mesmo tempo');
{
  // A Expedição tinha a lista com o ticket 1; o SAC, com o 1 e o 2 recém-digitado.
  // Antes, quem salvasse por último mandava o array inteiro e o outro item sumia.
  const nuvem  = { tickets: [{ id: 'a', criado_em: '2026-09-09T10:00:00Z' }] };
  const local  = { tickets: [{ id: 'a', criado_em: '2026-09-09T10:00:00Z' }] };
  const digitado = { tickets: [{ id: 'a', criado_em: '2026-09-09T10:00:00Z' },
                               { id: 'b', criado_em: '2026-09-09T10:05:00Z' }] };
  ok('o item novo entra sem apagar o que já estava', ids(mesclarListas('tickets', nuvem, local, digitado)), ['a', 'b']);
}
{
  // E o contrário: o item que a OUTRA pessoa incluiu chega pela nuvem e não some.
  const nuvem  = { tickets: [{ id: 'a' }, { id: 'c', criado_em: '2026-09-09T10:06:00Z' }] };
  const local  = { tickets: [{ id: 'a' }] };
  const digitado = { tickets: [{ id: 'a' }, { id: 'b' }] };
  ok('o item da colega sobrevive à minha gravação', ids(mesclarListas('tickets', nuvem, local, digitado)), ['a', 'b', 'c']);
}

console.log('\n' + '2) Excluir de verdade exclui (o item nao volta pela nuvem)');
{
  const nuvem = { tickets: [{ id: 'a' }, { id: 'b' }] };
  const apagou = { tickets: [{ id: 'a' }], removidos: [{ id: 'b', em: new Date().toISOString() }] };
  const r = mesclarListas('tickets', nuvem, apagou);
  ok('o excluído nao ressuscita', ids(r), ['a']);
  ok('e o id fica registrado para os outros aparelhos', r.removidos.map(x => x.id), ['b']);
}
{
  // Exclusão antiga não precisa mais barrar ninguém: a lista de removidos seria eterna.
  const velho = new Date(Date.now() - 200 * 86400000).toISOString();
  const r = mesclarListas('tickets', { tickets: [], removidos: [{ id: 'z', em: velho }] });
  ok('registro de exclusao velho e podado', r.removidos.length, 0);
}

console.log('\n' + '3) Editar o mesmo item: a alteracao mais nova vence');
{
  const nuvem = { tickets: [{ id: 'a', caso: 'antigo', atualizado_em: '2026-09-09T10:00:00Z' }] };
  const meu   = { tickets: [{ id: 'a', caso: 'novo',   atualizado_em: '2026-09-09T10:10:00Z' }] };
  ok('a minha edicao mais nova vence', mesclarListas('tickets', nuvem, meu).tickets[0].caso, 'novo');
  ok('a da colega vence se for mais nova', mesclarListas('tickets', meu, nuvem).tickets[0].caso, 'novo');
}
{
  const t = { id: 'a' };
  carimbarItem(t);
  ok('carimbarItem marca a hora da edicao', typeof t.atualizado_em, 'string');
}

console.log('\n' + '4) A gravacao passa pela mesclagem, nao pelo array inteiro');
for (const [salvar, chave, campo] of [['sacSalvar', 'sac', 'tickets'],
                                      ['retSalvar', 'retorno', 'itens'],
                                      ['estSalvar', 'estorno', 'itens']]) {
  const corpo = pedaco(`function ${salvar}(cfg) {`, `function ${salvar === 'estSalvar' ? 'estAdd' : (salvar === 'retSalvar' ? 'retAdd' : 'sacAdd')}(`);
  ok(`${salvar} mescla em vez de sobrescrever`,
     corpo.includes(`salvarListaCompartilhada('${chave}', '${campo}', cfg)`), true);
  ok(`${salvar} nao manda mais o array inteiro`, corpo.includes(`salvarNuvem('${chave}', cfg)`), false);
}
ok('excluir registra o id em removidos', (main.match(/cfg\.removidos = \[/g) || []).length, 3);
ok('as edicoes carimbam o item', (main.match(/carimbarItem\(t\);/g) || []).length, 8);
ok('leitura da nuvem que falha nao apaga o que foi digitado',
   /if \(daNuvem === undefined\) \{ await salvarNuvem\(chave, cfgDigitado\); return null; \}/.test(main), true);

console.log(falhas ? `${'\n'}X ${falhas} de ${total} falharam${'\n'}` : `${'\n'}${total}/${total} passaram${'\n'}`);
process.exit(falhas ? 1 : 0);
