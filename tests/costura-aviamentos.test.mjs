/**
 * Teste do card AVIAMENTOS A COMPRAR, na aba COSTURA (main.js).
 *
 * O que estes testes travam:
 *   1. só a dona cadastra/marca comprado/edita data/remove — oficina (corte/costura) só lê;
 *   2. renderCostura desenha o card, no mesmo formato "ver mais" do faturamento;
 *   3. nunca grava por cima sem conseguir ler a nuvem antes;
 *   4. o card some para a oficina quando não há nada pendente nem comprado.
 *
 * Rodar:  node tests/costura-aviamentos.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const idx  = readFileSync(join(raiz, 'index.html'), 'utf8');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

console.log('\n1) Só a dona edita — oficina só lê');
ok('gravar tem a trava de perfil antes de qualquer coisa',
   /async function avmGravar\(mutar\) \{\s*\r?\n\s*if \(ehPerfilOficina\(\)\) return;/.test(main), true);
ok('adicionar, marcar comprado, editar data e remover passam todos por avmGravar',
   ['avmAdicionar', 'avmComprado', 'avmData', 'avmRemover'].every(fn => {
     const i = main.indexOf(`async function ${fn}(`);
     const fim = main.indexOf('\n}', i);
     return main.slice(i, fim).includes('avmGravar');
   }), true);
ok('o formulário de adicionar só é desenhado para quem pode editar',
   /const podeEditar = !ehPerfilOficina\(\);/.test(main.slice(main.indexOf('function renderAviamentos'))), true);

console.log('\n2) Nunca grava por cima sem ler antes');
ok('avmGravar lê a nuvem e desiste se a leitura falhar',
   /const nuvem = await carregarNuvem\(AVM_KEY\);\s*\r?\n\s*if \(nuvem === undefined\) \{ alert/.test(main), true);

console.log('\n3) Mora dentro da aba COSTURA, card fechado igual ao faturamento');
ok('renderCostura desenha o card dos aviamentos',
   /function renderCostura\(\)[\s\S]*?renderAviamentos\(\);/.test(main), true);
ok('usa o mesmo formato "ver mais" (avisoCardHTML)',
   /el\.innerHTML = avisoCardHTML\('ti-shopping-bag', 'AVIAMENTOS A COMPRAR'/.test(main), true);
ok('a chave da nuvem é própria, sem tabela nova', /const AVM_KEY = 'costura-aviamentos';/.test(main), true);
ok('o lugar dele no HTML fica logo abaixo do faturamento',
   idx.indexOf('id="faturamento-lista"') < idx.indexOf('id="aviamentos-lista"')
   && idx.indexOf('id="aviamentos-lista"') < idx.indexOf('FICHAS EM COSTURA'), true);

console.log('\n4) Some para quem só lê quando não há nada a mostrar');
ok('sem item nenhum e sem poder editar, o card fica vazio',
   /if \(!podeEditar && d\.itens\.length === 0\) \{ el\.innerHTML = ''; return; \}/.test(main), true);

console.log(falhas ? `\n✗ ${total - falhas}/${total} passaram` : `\n✓ ${total}/${total} passaram`);
process.exit(falhas ? 1 : 0);
