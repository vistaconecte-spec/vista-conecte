/**
 * Teste do MOLDE na aba CORTE (main.js + functions/api/molde.js).
 *
 * POR QUE ISTO EXISTE: a modelista subia o molde novo na aba MODELAGEM e DEPOIS mandava o
 * mesmo arquivo no WhatsApp, porque o cortador não alcançava nada de lá. O botão "Molde"
 * na ficha resolve isso — mas só se ele abrir o molde CERTO.
 *
 * São duas listas escritas por gente diferente: a CONFECÇÃO é fixa no data.js
 * ('macacao-amplo' → "Macacão Amplo") e a MODELAGEM é do Supabase, digitada pela
 * modelista. O casamento é por NOME, e o que estes testes travam é o NÃO-casamento:
 * empate ou parecença fraca precisam devolver null. Molde errado na mesa é pior do que
 * molde nenhum — ele corta o tecido inteiro em cima do papel.
 *
 * Rodar:  node tests/molde.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz  = join(dirname(fileURLToPath(import.meta.url)), '..');
const main  = readFileSync(join(raiz, 'main.js'), 'utf8');
const html  = readFileSync(join(raiz, 'index.html'), 'utf8');
const molde = readFileSync(join(raiz, 'functions/api/molde.js'), 'utf8');
const mid   = readFileSync(join(raiz, 'functions/api/_middleware.js'), 'utf8');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

// Recorta do main.js as duas peças que dão para rodar fora do navegador
const trecho = (de, ate) => {
  const i = main.indexOf(de);
  if (i < 0) throw new Error(`${de} não encontrado em main.js`);
  return main.slice(i, main.indexOf(ate, i));
};
const fonte = trecho('const moldeNorm', 'const moldeData')
            + trecho('function moldeAuto(', '\n// Vínculo salvo');
const { moldeNorm, moldeAuto } = new Function(fonte + '; return { moldeNorm, moldeAuto };')();

console.log('\n1) Normalizar nome: acento, caixa e pontuação não podem separar duas listas');
ok('acento sai', moldeNorm('Macacão Amplo'), 'macacao amplo');
ok('caixa e pontuação também', moldeNorm('CALÇA  PANTALONA/MOLETOM'), 'calca pantalona moletom');
ok('vazio não quebra', moldeNorm(null), '');

const lista = [
  { id: 1, title: 'Macacão Amplo' },
  { id: 2, title: 'Macacão Manga Longa' },
  { id: 3, title: 'Calça Pantalona Moletom' },
  { id: 4, title: 'Calça Pantalona Viscolycra' },
  { id: 5, title: 'Vestido Sereia' },
];
const achou = nome => { const m = moldeAuto(nome, lista); return m ? m.id : null; };

console.log('\n2) O que DEVE casar');
ok('nome igual', achou('Macacão Amplo'), 1);
ok('só o acento diferente', achou('Macacao Amplo'), 1);
ok('caixa diferente', achou('VESTIDO SEREIA'), 5);
ok('as duas pantalonas não se confundem', [achou('Calça Pantalona Moletom'), achou('Calça Pantalona Viscolycra')], [3, 4]);

console.log('\n3) O que NÃO pode casar (molde errado é pior que molde nenhum)');
ok('nome que não existe na modelagem', achou('Sherpa Zíper'), null);
ok('parecença fraca: só uma palavra em comum', achou('Calça Flare Canelada'), null);
ok('empate entre duas pastas igualmente parecidas',
   moldeAuto('Calça Pantalona', lista), null);
ok('lista vazia', moldeAuto('Macacão Amplo', []), null);
ok('sem lista nenhuma (ainda não chegou do servidor)', moldeAuto('Macacão Amplo', null), null);
ok('modelo sem nome', achou(''), null);
ok('duas pastas com o MESMO título: não dá para escolher por ele',
   moldeAuto('Top V', [{ id: 8, title: 'Top V' }, { id: 9, title: 'Top V' }]), null);

console.log('\n4) O botão está na ficha da aba CORTE, e o selo diz qual versão está no sistema');
const corte = main.slice(main.indexOf('function renderCorte()'), main.indexOf('// ─── ABA COSTURA'));
ok('cada ficha tem o botão do molde', /onclick="crtAbrirMolde\('\$\{l\.key\}'\)"/.test(corte), true);
ok('e o selo da versão, para ele conferir o papel da mesa',
   /\$\{moldeSeloHTML\(l\.key\)\}/.test(corte), true);
ok('a lista de moldes é buscada ao desenhar a aba', /moldeCarregarLista\(\);/.test(corte), true);
ok('o modal existe no index.html', /id="modal-molde"/.test(html) && /id="molde-corpo"/.test(html), true);

console.log('\n5) A busca não vira uma requisição por render (a aba redesenha de minuto em minuto)');
const carregar = main.slice(main.indexOf('async function moldeCarregarLista('), main.indexOf('// Selo do molde'));
ok('tem TTL', /Date\.now\(\) - _moldeListaEm < MOLDE_LISTA_TTL/.test(carregar), true);
ok('não busca duas vezes ao mesmo tempo', /if \(_moldeBuscando\) return _moldeLista;/.test(carregar), true);
ok('erro também espera o TTL (senão o 403 vira 1 requisição por segundo)',
   /_moldeListaEm = Date\.now\(\); \/\/ erro também espera/.test(carregar), true);
ok('e só redesenha a aba na PRIMEIRA vez (redesenho a cada 5 min piscaria a tela)',
   /if \(primeiraVez && modeloAtual === '__corte__'\) renderCorte\(\);/.test(carregar), true);

console.log('\n6) O vínculo escolhido fica salvo, sem apagar o do outro aparelho');
const gravar = main.slice(main.indexOf('async function moldeGravarVinculo('), main.indexOf('// Casa pelo NOME'));
ok('lê a nuvem antes de gravar', /const naNuvem = await carregarNuvem\(MOLDE_VINCULO_KEY\);/.test(gravar), true);
ok('e funde com o que já estava lá', /\.\.\.\(\(naNuvem && naNuvem\.vinculos\) \|\| \{\}\), \.\.\.moldeVinculos\(\)/.test(gravar), true);
ok('grava por REST (é o caminho que o perfil do corte alcança)',
   /await salvarNuvemREST\(MOLDE_VINCULO_KEY, dados\);/.test(gravar), true);
ok('e o vínculo salvo tem prioridade sobre o palpite pelo nome',
   /const id = moldeVinculos\(\)\[key\];[\s\S]{0,120}return _moldeLista\.find/.test(main), true);

console.log('\n7) O endpoint do molde é só leitura e não carrega dinheiro');
// Sem os comentários: eles citam de propósito o que o CÓDIGO não pode ter.
const moldeCodigo = molde.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok('recusa o que não for GET', /if \(request\.method !== 'GET'\)/.test(moldeCodigo), true);
ok('não busca valorAjuste em lugar nenhum', /valorAjuste/.test(moldeCodigo), false);
ok('nem usa select=* (coluna nova em projects vazaria sozinha)', /select=\*/.test(moldeCodigo), false);
ok('a versão do molde é calculada no servidor, pela data de envio',
   /function versionar\(arquivos\)/.test(molde) && /atual: i === porData\.length - 1/.test(molde), true);
ok('createdAt sem fuso ganha o Z (senão a hora do envio sai 3h adiantada)',
   /\/\(\[zZ\]\|\[\+-\]\\d\{2\}:\?\\d\{2\}\)\$\//.test(molde), true);
ok('a oficina alcança o molde e o download, e só por GET',
   /\['\/api\/molde', new Set\(\['GET'\]\)\]/.test(mid)
   && /\['\/api\/modelagem-storage', new Set\(\['GET', 'HEAD'\]\)\]/.test(mid), true);

console.log(`\n${falhas ? '✗' : '✓'} ${total - falhas}/${total} passaram\n`);
process.exit(falhas ? 1 : 0);
