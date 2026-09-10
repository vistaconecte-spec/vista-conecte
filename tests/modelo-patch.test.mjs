/**
 * Teste da gravacao por "patch" do modelo (main.js).
 *
 * POR QUE ISTO EXISTE: o salvamento mandava o modelo INTEIRO a partir da tela. Com dois
 * aparelhos no mesmo modelo, a tela desatualizada de um gravava por cima do que o outro
 * tinha acabado de mudar. Em 09 e 10/09/2026:
 *   - o estoque do Cropped Canelado voltava ao valor velho 10 segundos depois de cada
 *     contagem (historico: Off White [3,1,2,3,2] as 19:20:41, [2,1,2,0,0] as 19:20:51);
 *   - o status do Macacao Amplo voltava de "Comprando tecido".
 *
 * Aqui a funcao REAL mesclarModelo roda contra esses casos.
 *
 * Rodar:  node tests/modelo-patch.test.mjs
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
  if (!bateu) { falhas++; console.log(`  X ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ok ${nome}`);
}

const pedaco = (ini, fim) => {
  const a = main.indexOf(ini), b = main.indexOf(fim, a);
  if (a < 0 || b < 0) throw new Error('trecho nao encontrado: ' + ini);
  return main.slice(a, b);
};
const { mesclarModelo } = new Function(`
  ${pedaco('function mesclarModelo(nuvem, dom, tocado)', 'async function subirModeloMesclado')}
  return { mesclarModelo };
`)();

const nada = () => ({ est: new Set(), prod: new Set(), prod2: new Set(), cfg: false, status: false });

console.log('\n1) O caso do Cropped Canelado: celular com tela velha grava depois da contagem no PC');
{
  // A nuvem ja tem a contagem nova feita no PC.
  const nuvem = { est: { 'Off White': [3, 1, 2, 3, 2], Preto: [0, 0, 6, 0, 0] }, prod: { Preto: [0, 0, 0, 0, 0] },
                  status: 'Em corte', prazo: '2026-09-20', nome: 'Cropped Canelado', est_at: 'A' };
  // O celular esta com a tela VELHA e a pessoa so mexeu no Preto GG.
  const dom   = { est: { 'Off White': [2, 1, 2, 0, 0], Preto: [0, 0, 6, 0, 4] }, prod: { Preto: [0, 0, 0, 0, 0] },
                  status: 'Em corte', prazo: '2026-09-20', nome: 'Cropped Canelado', est_at: 'B' };
  const t = nada(); t.est.add('Preto|4');
  const r = mesclarModelo(nuvem, dom, t);
  ok('a celula tocada no celular entra', r.est.Preto, [0, 0, 6, 0, 4]);
  ok('a contagem do PC NAO e apagada pela tela velha', r.est['Off White'], [3, 1, 2, 3, 2]);
  ok('o carimbo do estoque e o do aparelho que tocou', r.est_at, 'B');
}

console.log('\n2) O caso do Macacao Amplo: status escolhido num aparelho, estoque contado no outro');
{
  const nuvem = { est: { Preto: [5, 5, 5, 5, 5] }, prod: {}, status: 'Em corte', status_at: 'X', prazo: '2026-09-20' };
  const dom   = { est: { Preto: [1, 1, 1, 1, 1] }, prod: {}, status: 'Comprando tecido', status_at: 'Y', prazo: '2026-09-20' };
  const t = nada(); t.status = true;
  const r = mesclarModelo(nuvem, dom, t);
  ok('o status escolhido sobe', r.status, 'Comprando tecido');
  ok('com o carimbo dele', r.status_at, 'Y');
  ok('e o estoque contado no outro aparelho fica intacto', r.est.Preto, [5, 5, 5, 5, 5]);
}
{
  // E o inverso: quem so contou estoque nao devolve o status velho da tela.
  const nuvem = { est: { Preto: [5, 5, 5, 5, 5] }, prod: {}, status: 'Comprando tecido', status_at: 'X' };
  const dom   = { est: { Preto: [5, 9, 5, 5, 5] }, prod: {}, status: 'Em corte', status_at: 'velho' };
  const t = nada(); t.est.add('Preto|1');
  const r = mesclarModelo(nuvem, dom, t);
  ok('a contagem entra', r.est.Preto, [5, 9, 5, 5, 5]);
  ok('o status "Comprando tecido" do outro aparelho NAO volta para "Em corte"', r.status, 'Comprando tecido');
}

console.log('\n3) Configuracao editada: a tela manda (a lista de cores pode ter mudado)');
{
  const nuvem = { est: { Preto: [1, 1, 1, 1, 1], Nude: [2, 2, 2, 2, 2] }, prod: {}, cores: ['Preto', 'Nude'], nome: 'A' };
  const dom   = { est: { Preto: [1, 1, 1, 1, 1] }, prod: {}, cores: ['Preto'], nome: 'B' };
  const t = nada(); t.cfg = true;
  const r = mesclarModelo(nuvem, dom, t);
  ok('cor removida na tela some da grade', Object.keys(r.est), ['Preto']);
  ok('nome editado sobe', r.nome, 'B');
}

console.log('\n4) Casos de borda');
{
  ok('sem nuvem, a tela inteira sobe (como sempre foi)', mesclarModelo(null, { est: { X: [1] } }, nada()).est, { X: [1] });
  const nuvem = { est: { Preto: [1, 1, 1, 1, 1] }, prod: {} };
  const dom   = { est: { Preto: [1, 1, 1, 1, 1], Marrom: [0, 0, 3, 0, 0] }, prod: {} };
  const t = nada(); t.est.add('Marrom|2');
  ok('cor nova na tela entra quando tocada', mesclarModelo(nuvem, dom, t).est.Marrom, [0, 0, 3, 0, 0]);
  const t2 = nada();
  ok('cor nova na tela NAO entra se nao foi tocada (era so tela velha)', mesclarModelo(nuvem, dom, t2).est.Marrom, undefined);
  const t3 = nada(); t3.est.add('*');
  ok('marca "*" (chamada sem celula) sobe a grade toda', mesclarModelo(nuvem, { est: { Preto: [9, 9, 9, 9, 9] }, prod: {} }, t3).est.Preto, [9, 9, 9, 9, 9]);
}

console.log('\n4b) O botao Atualizar do card EM PRODUCAO (10/09/2026, a dona precisava comprar tecido)');
{
  // O botao preenche a grade inteira da leva com o que falta e liga prodEditado, sem passar
  // pelo oninput. Sem a marca '*', a mesclagem achava que nada foi tocado e devolvia a
  // producao antiga da nuvem: tudo permanecia em A PRODUZIR.
  const nuvem = { est: { Cinza: [0, 0, 0, 0, 0, 0] }, prod: { Cinza: [0, 0, 0, 0, 0, 0], Preto: [0, 0, 0, 0, 0, 0] } };
  const dom   = { est: { Cinza: [0, 0, 0, 0, 0, 0] }, prod: { Cinza: [2, 7, 7, 5, 0, 0], Preto: [0, 4, 1, 3, 1, 0] } };
  const t = nada(); t.prod.add('*');
  const r = mesclarModelo(nuvem, dom, t);
  ok('a leva preenchida pelo botao sobe inteira', r.prod, { Cinza: [2, 7, 7, 5, 0, 0], Preto: [0, 4, 1, 3, 1, 0] });
  ok('recalcularProducao marca a grade toda', /prodEditado = true;\n[\s\S]{0,400}_celulasTocadas\.prod\.add\('\*'\);/.test(main), true);
  ok('recalcularProducao2 tambem', /prod2Editado = true;\n\s*_celulasTocadas\.prod2\.add\('\*'\);/.test(main), true);
}
{
  // Trocar prazo (cfg) nao pode subir a grade inteira da tela: so a lista de cores mudando.
  const nuvem = { est: { Preto: [5, 5, 5, 5, 5] }, prod: {}, cores: ['Preto'], prazo: '2026-09-01' };
  const dom   = { est: { Preto: [1, 1, 1, 1, 1] }, prod: {}, cores: ['Preto'], prazo: '2026-09-30' };
  const t = nada(); t.cfg = true;
  const r = mesclarModelo(nuvem, dom, t);
  ok('prazo editado sobe', r.prazo, '2026-09-30');
  ok('mas a grade que a tela nao tocou vem da nuvem', r.est.Preto, [5, 5, 5, 5, 5]);
  ok('trocar status nao liga cfgEditado', /function marcarStatusEditado\(\) \{\n(?:\s*\/\/.*\n)*\s*statusTocado = true;/.test(main), true);
}

console.log('\n5) Os tres caminhos de gravacao passam pelo patch');
ok('salvarModelo sobe mesclado', /subirModeloMesclado\(modeloAtual, data, tocado\)/.test(main), true);
ok('salvarModelo nao manda mais o objeto inteiro direto', /\n  salvarNuvem\(modeloAtual, data\);/.test(main), false);
ok('confirmarStatus sobe so o status', /subirModeloMesclado\(key, saved, \{ est: new Set\(\), prod: new Set\(\), prod2: new Set\(\), cfg: false, status: true \}\)/.test(main), true);
ok('os inputs dizem qual celula foi tocada',
   ['marcarEstEditado(this)', 'marcarProdEditado(this)', 'marcarProd2Editado(this)'].every(f => main.includes(`oninput="${f}`)), true);
ok('o retrato do tocado e tirado ANTES de zerar as flags',
   main.indexOf('const tocado = {') < main.indexOf('limparTocados();\n  estEditado  = false;'), true);

console.log(falhas ? `\nX ${falhas} de ${total} falharam\n` : `\n${total}/${total} passaram\n`);
process.exit(falhas ? 1 : 0);
