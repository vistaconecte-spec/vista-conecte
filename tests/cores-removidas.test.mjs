/**
 * Teste das cores do modelo na aba Configuracoes (main.js).
 *
 * POR QUE ISTO EXISTE: em 09/11/2026 a Barbara tentou tirar uma cor e cadastrar outra na
 * Calca Pantalona Viscolycra e "nao estava indo":
 *   - o x tirava a cor da nuvem, mas o data.js devolvia a cor no proximo desenho
 *     (Rosa Baby voltava sempre);
 *   - modelo com tamanhos proprios (G1) ignorava as cores cadastradas na tela, entao a cor
 *     nova sumia e o proximo x a apagava da nuvem.
 * Agora a retirada fica gravada em `coresRemovidas`.
 *
 * Rodar:  node tests/cores-removidas.test.mjs
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
const { chaveCor, coresCatalogo, coresDoModelo, mesclarModelo, nomeCorDigitada } = new Function(`
  ${pedaco('const COR_DIGITADA_NORM', 'function addCor()')}
  ${pedaco('function chaveCor(c)', '// Nome canônico da cor')}
  ${pedaco('function coresCatalogo(def, saved)', '// Cores a exibir/calcular')}
  ${pedaco('function coresDoModelo(def, saved)', '// Necessidade de UMA leva')}
  ${pedaco('function mesclarModelo(nuvem, dom, tocado)', '// Leitura com nova tentativa')}
  return { chaveCor, coresCatalogo, coresDoModelo, mesclarModelo, nomeCorDigitada };
`)();

const def = { cores: ['Preto', 'Nude', 'Rosa Baby'], tamanhos: ['PP','P','M','G','GG','G1'], aberto: {} };

ok('sem retirada: data.js inteiro', coresDoModelo(def, { cores: ['Preto', 'Nude', 'Rosa Baby'] }), ['Preto', 'Nude', 'Rosa Baby']);
ok('cor tirada nao volta do data.js',
  coresDoModelo(def, { cores: ['Preto', 'Nude'], coresRemovidas: ['Rosa Baby'] }), ['Preto', 'Nude']);
ok('cor cadastrada aparece em modelo com G1',
  coresDoModelo(def, { cores: ['Preto', 'Nude', 'Rosa Baby', 'Pistache'] }), ['Preto', 'Nude', 'Rosa Baby', 'Pistache']);
ok('cor tirada e cadastrada de novo volta',
  coresDoModelo(def, { cores: ['Preto', 'Nude', 'Rosa Baby'], coresRemovidas: [] }), ['Preto', 'Nude', 'Rosa Baby']);
ok('cor tirada com pedido aberto continua na conta',
  coresDoModelo({ ...def, aberto: { 'Rosa Baby': [0, 1, 0, 0, 0, 0] } }, { cores: ['Preto', 'Nude'], coresRemovidas: ['Rosa Baby'] }),
  ['Preto', 'Nude', 'Rosa Baby']);
ok('retirada ignora acento/caixa', coresCatalogo({ cores: ['Fúcsia', 'Preto'] }, { coresRemovidas: ['FUCSIA'] }), ['Preto']);

const t = (cores) => ({ est: new Set(), prod: new Set(), prod2: new Set(), cfg: true, status: false, cores });
const nuvem = { cores: ['Preto', 'Nude', 'Rosa Baby'], est: {}, prod: {} };
const dom = { cores: ['Preto', 'Nude'], coresRemovidas: ['Rosa Baby'], est: {}, prod: {} };
ok('mexeu nas etiquetas: retirada sobe', mesclarModelo(nuvem, dom, t(true)).coresRemovidas, ['Rosa Baby']);
ok('nao mexeu nas etiquetas: retirada da nuvem fica',
  mesclarModelo({ ...nuvem, coresRemovidas: ['Uva'] }, dom, t(false)).coresRemovidas, ['Uva']);


// Calca Boho, 09/11/2026: "Preta" digitada com a linha "Preto" (1 peca no M) no estoque
const boho = { cores: ['Nude', 'Mescla'], aberto: {} };
const salvoBoho = { cores: ['Nude', 'Mescla', 'Marrom'], est: { Preto: [0, 0, 1, 0, 0, 0] } };
ok('Preta digitada vira Preto', nomeCorDigitada('Preta', boho, salvoBoho), 'Preto');
ok('preta minuscula vira Preto mesmo sem linha', nomeCorDigitada('preta', boho, {}), 'Preto');
ok('grafia do modelo vence (marrom -> Marrom)', nomeCorDigitada('marrom', boho, salvoBoho), 'Marrom');
ok('cor nova de verdade fica como digitada', nomeCorDigitada('Pistache', boho, salvoBoho), 'Pistache');
const nuvemBoho = { cores: ['Nude', 'Mescla', 'Marrom'], est: { Nude: [1,0,0,0,0,0], Preto: [0,0,1,0,0,0], Marrom: [0,0,0,0,0,0] }, prod: {} };
const domBoho = { cores: ['Nude', 'Mescla', 'Pistache'], coresRemovidas: [], est: { Nude: [1,0,0,0,0,0], Pistache: [0,0,0,0,0,0] }, prod: {} };
const mBoho = mesclarModelo(nuvemBoho, domBoho, t(true));
ok('linha que nunca foi etiqueta (Preto com estoque) fica', mBoho.est.Preto, [0,0,1,0,0,0]);
ok('cor tirada (Marrom) sai do estoque', 'Marrom' in mBoho.est, false);
ok('cor do catalogo tirada sai mesmo fora da nuvem.cores',
  'Uva' in mesclarModelo({ cores: ['Nude'], est: { Uva: [0,0,0,0,0,0] }, prod: {} }, { cores: ['Nude'], coresRemovidas: ['Uva'], est: {}, prod: {} }, t(true)).est, false);
ok('tela desatualizada recarrega sozinha', /recarregarQuandoOcioso\(\); \}/.test(main) && /location\.reload\(\);\s*\}, 3000\)/.test(main), true);

ok('tirar cor com peca pergunta antes', /function removerCor[\s\S]{0,300}pecasDaCor[\s\S]{0,300}confirm\(/.test(main), true);
const { pecasDaCor } = new Function('chaveCor', `${pedaco('function pecasDaCor(saved, cor)', 'function removerCor(')} return { pecasDaCor };`)(chaveCor);
ok('conta pecas do Azul (2 no G)', pecasDaCor({ est: { Azul: [0,0,0,2,0] }, prod: { Azul: [0,0,0,0,0] } }, 'azul'), 2);
ok('cor sem peca nao pergunta', pecasDaCor({ est: { Azul: [0,0,0,0,0] } }, 'Azul'), 0);

const salvar = pedaco('function salvarModelo()', '// Só as cores FIXAS');
ok('salvarModelo grava coresRemovidas', /coresRemovidas:/.test(salvar), true);
ok('renderModelo nao ignora mais as cores salvas em modelo com tamanhos',
  /coresDoModelo\(def, def\.tamanhos \? null : d\)/.test(main), false);

console.log(`\n${total - falhas}/${total} ok`);
if (falhas) process.exit(1);
