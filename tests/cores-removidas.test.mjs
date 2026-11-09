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
const { chaveCor, coresCatalogo, coresDoModelo, mesclarModelo } = new Function(`
  ${pedaco('function chaveCor(c)', '// Nome canônico da cor')}
  ${pedaco('function coresCatalogo(def, saved)', '// Cores a exibir/calcular')}
  ${pedaco('function coresDoModelo(def, saved)', '// Necessidade de UMA leva')}
  ${pedaco('function mesclarModelo(nuvem, dom, tocado)', '// Leitura com nova tentativa')}
  return { chaveCor, coresCatalogo, coresDoModelo, mesclarModelo };
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

const salvar = pedaco('function salvarModelo()', '// Só as cores FIXAS');
ok('salvarModelo grava coresRemovidas', /coresRemovidas:/.test(salvar), true);
ok('renderModelo nao ignora mais as cores salvas em modelo com tamanhos',
  /coresDoModelo\(def, def\.tamanhos \? null : d\)/.test(main), false);

console.log(`\n${total - falhas}/${total} ok`);
if (falhas) process.exit(1);
