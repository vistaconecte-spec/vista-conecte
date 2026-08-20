/**
 * Teste da tabela de medidas que vai para a descrição do produto
 * (functions/api/shopify-medidas.js + functions/api/modelagem-list.js + main.js).
 *
 * POR QUE ISTO EXISTE: a API da Shopify não atualiza pedaço de descrição — ela grava o
 * body_html inteiro. Se a montagem do bloco errar, o que se perde é o texto de venda
 * escrito à mão de cada produto que está no ar. Os casos aqui travam justamente isso:
 * o texto de venda sobrevive, o bloco antigo (inclusive o legado da Calça Flare, que não
 * tem marca de fim) é trocado e não duplicado, e modelo sem medida NÃO publica bloco vazio.
 *
 * Rodar:  node tests/modelagem-medidas.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MARCA_INI, MARCA_FIM, montarTabelaHtml, aplicarBloco, semBlocoMedidas,
  temBlocoMedidas, tamanhosUsados, linhasValidas,
} from '../functions/api/shopify-medidas.js';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const idx  = readFileSync(join(raiz, 'index.html'), 'utf8');
const api  = readFileSync(join(raiz, 'functions/api/modelagem-list.js'), 'utf8');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

const TAMANHOS = ['PP', 'P', 'M', 'G', 'GG', 'G1'];
const LINHAS = [
  { nome: 'Comprimento',  valores: { PP: '113cm', P: '116cm', M: '118cm', G: '120cm', GG: '122cm' } },
  { nome: 'Entre pernas', valores: { PP: '85cm',  P: '88cm',  M: '88cm',  G: '87cm',  GG: '92cm'  } },
  { nome: 'Cintura',      valores: { PP: '60cm',  P: '64cm',  M: '72cm',  G: '76cm',  GG: '80cm'  } },
];

console.log('\n1) O bloco sai com o que a modelista preencheu');
const bloco = montarTabelaHtml(LINHAS, TAMANHOS);
ok('abre e fecha com as marcas', [bloco.startsWith(MARCA_INI), bloco.endsWith(MARCA_FIM)], [true, true]);
ok('cada medida virou uma linha', (bloco.match(/<tr>/g) || []).length, 4); // cabeçalho + 3 medidas
ok('tamanho sem nenhum valor não vira coluna', bloco.includes('<th>G1</th>'), false);
ok('tamanhos usados', tamanhosUsados(LINHAS, TAMANHOS), ['PP', 'P', 'M', 'G', 'GG']);
ok('valor preenchido aparece', bloco.includes('<td>113cm</td>'), true);

console.log('\n2) Linha pela metade não estraga a tabela');
const comBuracos = [
  { nome: 'Busto',  valores: { PP: '88', G: '96' } },
  { nome: '',       valores: { PP: '10' } },          // linha em branco da planilha
  { nome: 'Barra',  valores: { PP: '  ', P: '' } },   // só espaço: não é medida
];
ok('linha sem nome fica de fora', linhasValidas(comBuracos).map(l => l.nome), ['Busto']);
const b2 = montarTabelaHtml(comBuracos, TAMANHOS);
ok('tamanho sem valor na única linha válida não vira coluna', b2.includes('<th>P</th>'), false);
ok('buraco no meio vira traço, não célula vazia', b2.includes('<td>-</td>'), false); // PP e G preenchidos; sem coluna vazia sobrando

console.log('\n3) O texto de venda do produto sobrevive');
const vendaHtml = '<p>A <strong>Calça Flare Canelada</strong> é o curinga do guarda-roupa.</p>\n<ul>\n<li>Modelagem flare</li>\n</ul>';
const novo = aplicarBloco(vendaHtml, bloco);
ok('texto de venda continua inteiro', novo.includes(vendaHtml), true);
ok('tabela entra no topo', novo.startsWith(MARCA_INI), true);
ok('descrição vazia também funciona', aplicarBloco('', bloco), bloco);
ok('null não vira "null" na loja', aplicarBloco(null, bloco), bloco);

console.log('\n4) Republicar troca a tabela, não empilha outra');
const doisNoAr = aplicarBloco(novo, montarTabelaHtml(LINHAS, TAMANHOS));
ok('continua com UMA marca de início', (doisNoAr.match(new RegExp(MARCA_INI.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g')) || []).length, 1);
ok('continua com UMA tabela', (doisNoAr.match(/<table>/g) || []).length, 1);
ok('e o texto de venda segue lá', doisNoAr.includes(vendaHtml), true);

console.log('\n5) O bloco legado (Calça Flare publicada à mão, sem marca de fim) é trocado');
// trecho real do que está no ar em 20/08/2026 no produto 8133973573741
const legado = `${MARCA_INI}
<p><strong>Tabela de medidas (peça pronta, em cm)</strong></p>
<table>
<thead><tr>
<th>Medida</th>
<th>PP</th>
</tr></thead>
<tbody>
<tr>
<td>Comprimento</td>
<td>113cm</td>
</tr>
</tbody>
</table>
<p>A <strong>Calça Flare Canelada</strong> é o curinga do guarda-roupa.</p>`;
ok('reconhece que já tem tabela', temBlocoMedidas(legado), true);
const trocado = aplicarBloco(legado, bloco);
ok('sobrou só uma tabela', (trocado.match(/<table>/g) || []).length, 1);
ok('o parágrafo de venda que vinha DEPOIS da tabela ficou', trocado.includes('curinga do guarda-roupa'), true);
ok('a tabela nova é a que ficou', trocado.includes('<td>118cm</td>'), true);
ok('sem sobra do cabeçalho antigo solto', semBlocoMedidas(legado).startsWith('<p>A <strong>Calça Flare'), true);

console.log('\n6) Sem medida não publica bloco vazio (apagaria a tabela que está no ar)');
ok('nenhuma linha → bloco vazio', montarTabelaHtml([], TAMANHOS), '');
ok('linhas só em branco → bloco vazio', montarTabelaHtml([{ nome: '', valores: {} }], TAMANHOS), '');
ok('o endpoint recusa publicar sem medidas',
  /if \(!bloco\) return new Response\(JSON\.stringify\(\{ erro: 'modelo sem medidas preenchidas'/.test(
    readFileSync(join(raiz, 'functions/api/shopify-medidas.js'), 'utf8')), true);

console.log('\n7) Nada é gravado na loja sem dry-run e confirmação');
const apiMed = readFileSync(join(raiz, 'functions/api/shopify-medidas.js'), 'utf8');
ok('só grava com ?apply=1', /const apply = new URL\(request\.url\)\.searchParams\.get\('apply'\) === '1'/.test(apiMed), true);
ok('lê o body_html atual antes de gravar', /fields=id,title,body_html/.test(apiMed), true);
ok('a tela pede confirmação antes do apply', /confirm\('Vai gravar a tabela de medidas/.test(main), true);
ok('a prévia roda sem apply', main.indexOf("fetch('/api/shopify-medidas', {") < main.indexOf("fetch('/api/shopify-medidas?apply=1'"), true);

console.log('\n8) Modelo sem medidas aparece como alerta na aba MODELAGEM');
ok('a lista traz a coluna medidas do banco', /select=id,title,category,status,createdAt,valorAjuste,medidas/.test(api), true);
ok('e devolve semMedidas por projeto', /semMedidas: !temMedidas\(p\.medidas\)/.test(api), true);
const temMedidas = new Function(
  api.slice(api.indexOf('function temMedidas'), api.indexOf('\n}', api.indexOf('function temMedidas'))) + '\n}'
  + '; return temMedidas;')();
ok('projeto sem nada', temMedidas(null), false);
ok('JSON quebrado não vira "tem medida"', temMedidas('{isso não é json'), false);
ok('só observação preenchida não conta', temMedidas(JSON.stringify({ __obs: 'ver com a modelista' })), false);
ok('linha salva sem valor não conta', temMedidas(JSON.stringify({ Busto: {} })), false);
ok('linha só com espaço não conta', temMedidas(JSON.stringify({ Busto: { PP: '   ' } })), false);
ok('uma medida preenchida basta', temMedidas(JSON.stringify({ Busto: { PP: '88' } })), true);
ok('o card do alerta existe na tela', /id="mdl-alerta-medidas"/.test(idx), true);
ok('a grade marca o modelo sem medidas', /SEM MEDIDAS/.test(main), true);
ok('o alerta é redesenhado junto com a lista', /mdlRenderLista\(\) \{\n  mdlRenderTotalModelista\(\);\n  mdlRenderAlertaMedidas\(\);/.test(main), true);

console.log('\n9) O vínculo modelo → produto aguenta os dois links do mesmo modelo');
ok('o vínculo é uma lista de produtos', /vinculos\[String\(id\)\] = lista/.test(main), true);
ok('mora em vc_modelos, sem tabela nova', /const MDL_LOJA_KEY = 'modelagem-produtos'/.test(main), true);
ok('leitura da nuvem que falha não grava por cima', /if \(naNuvem === undefined\) \{ alert\(/.test(main), true);

console.log(falhas ? `\n✗ ${falhas} de ${total} falharam\n` : `\n✓ ${total}/${total} passaram\n`);
process.exit(falhas ? 1 : 0);
