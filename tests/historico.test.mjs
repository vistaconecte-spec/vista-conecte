/**
 * Teste do histórico de versões (main.js).
 *
 * POR QUE ISTO EXISTE: em 11/08/2026 a dona desfez sem querer 7 trocas de etiqueta e só
 * deu para reconstruir porque havia cópias do estoque tiradas por acaso naquela noite.
 * Nenhuma tela do sistema guardava o "como estava antes".
 *
 * Como salvarNuvem é o funil de TUDO (modelos, financeiro, fluxo de caixa, precificação,
 * atendimento, avisos), gravar a versão ali cobre o sistema inteiro. O que estes testes
 * travam é o que NÃO pode acontecer:
 *   1. o histórico atrapalhar/segurar o salvamento de verdade;
 *   2. o histórico ser baixado no carregamento da página (a tabela é a mesma);
 *   3. restaurar apagar o estado atual (tem que dar para voltar de novo).
 *
 * Rodar:  node tests/historico.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const html = readFileSync(join(raiz, 'index.html'), 'utf8');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}
const trecho = (ini, fim) => main.slice(main.indexOf(ini), main.indexOf(fim, main.indexOf(ini)));

console.log('\n1) Toda gravação do sistema vira versão');
ok('o histórico é gravado dentro de salvarNuvem (funil de tudo)',
   /async function salvarNuvem\(key, dados\) \{[\s\S]{0,200}registrarVersao\(key, dados\)/.test(main), true);
ok('salvarNuvem continua sendo o único ponto de gravação',
   (main.match(/async function salvarNuvem\(/g) || []).length, 1);

console.log('\n2) O histórico NUNCA atrapalha o salvamento de verdade');
const reg = trecho('async function registrarVersao', '\nasync function salvarNuvem');
ok('grava o dado primeiro, histórico depois',
   /await salvarNuvemREST\(key, dados\);\s*\r?\n\s*registrarVersao/.test(main), true);
ok('sem await: não segura a tela', /\n  registrarVersao\(key, dados\);/.test(main), true);
ok('qualquer erro do histórico é engolido', /catch \(_\) \{\}/.test(reg), true);
ok('não guarda histórico do próprio histórico', /if \(ehChaveHistorico\(key\)\) return;/.test(reg), true);

console.log('\n3) O histórico não é baixado no carregamento da página');
const carga = trecho('async function carregarTodosNuvem', '\nasync function salvarNuvemREST');
ok('a consulta exclui as linhas hist:', /id=not\.like\.\$\{encodeURIComponent\(HIST_PREFIXO \+ '\*'\)\}/.test(carga), true);
ok('e ainda ignora se alguma escapar', /if \(ehChaveHistorico\(row\.id\)\) return;/.test(carga), true);

console.log('\n4) Não duplica versão igual, e não cresce sem limite');
ok('versão idêntica à última não é gravada',
   /if \(v\.length && JSON\.stringify\(v\[0\]\.d\) === novo\) return;/.test(reg), true);
ok('mais nova primeiro', /v\.unshift\(/.test(reg), true);
ok('corta no limite', /v\.slice\(0, HIST_MAX\)/.test(reg), true);
ok('limite é um número razoável', /const HIST_MAX = (\d+)/.test(main) && Number(RegExp.$1) >= 10 && Number(RegExp.$1) <= 100, true);

console.log('\n5) Restaurar não perde o estado de agora');
const rest = trecho('async function restaurarVersao', '\n// ─');
ok('pede confirmação', /confirm\(/.test(rest), true);
ok('restaura passando por salvarNuvem — então o estado atual vira versão também',
   /await salvarNuvem\(key, ver\.d\)/.test(rest), true);
ok('avisa que dá para voltar de novo', /voltar depois/.test(rest), true);
ok('grava local antes, pra tela não piscar dado velho', /saveLocal\('vc:' \+ key, ver\.d\)/.test(rest), true);

console.log('\n6) Serve para QUALQUER tela, não só modelo');
ok('abrirHistorico recebe a chave', /async function abrirHistorico\(key, titulo\)/.test(main), true);
ok('modelo re-renderiza; as outras telas recarregam',
   /if \(MODELOS\[key\]\) \{ modeloAtual = key; renderModelo\(key\); \}\s*\r?\n\s*else location\.reload\(\)/.test(rest), true);
ok('o botão existe na barra do modelo', /onclick="abrirHistorico\(modeloAtual/.test(html), true);
ok('a janela do histórico existe no HTML', /id="modal-historico"/.test(html) && /id="hist-corpo"/.test(html), true);

console.log('\n7) A lista diz o que mudou, não só o horário');
const resumo = trecho('function resumirDiferenca', '\n// Abre o histórico');
['est', 'prod', 'prod2'].forEach(c => ok(`compara ${c}`, resumo.includes(`'${c}'`), true));
ok('mostra a diferença por cor e tamanho', /\$\{nome\} \$\{cor\} \$\{rot\(i\)\}/.test(resumo), true);
ok('também pega campos de configuração', /'nome', 'tecido', 'consumo', 'preco'/.test(resumo), true);
ok('tamanho único não vira "PP"', /tamanhoUnico\) \? 'Único'/.test(resumo), true);

// A conta do resumo, exercitada de verdade
const resumir = new Function(
  main.slice(main.indexOf('function resumirDiferenca'), main.indexOf('\n}', main.indexOf('function resumirDiferenca'))) + '\n}'
  + '; return resumirDiferenca;')();
globalThis.MODELOS = { m: { nome: 'M', tamanhos: ['PP','P','M','G','GG'] } };
ok('descreve uma troca de etiqueta',
   resumir({ est: { Preto: [0,0,0,1,0] } }, { est: { Preto: [0,0,0,0,1] } }, 'm'),
   'estoque Preto G -1 · estoque Preto GG +1');
ok('descreve baixa de estoque',
   resumir({ est: { Nude: [2,0,0,0,0] } }, { est: { Nude: [1,0,0,0,0] } }, 'm'),
   'estoque Nude PP -1');
ok('descreve mudança de configuração',
   resumir({ nome: 'A' }, { nome: 'B' }, 'm'), 'nome: "A" → "B"');
ok('sem diferença conhecida não inventa', resumir({ x: 1 }, { x: 1 }, 'm'), 'outros campos');
ok('a versão mais antiga não vira despejo de tudo',
   resumir(null, { est: { Preto: [1,2,3,4,5] }, nome: 'X' }, 'm'),
   'primeira versão guardada — ponto de partida');

console.log(`\n${falhas === 0 ? '✓ TODOS OS TESTES PASSARAM' : '✗ ' + falhas + ' FALHA(S)'} — ${total - falhas}/${total}\n`);
process.exit(falhas === 0 ? 0 : 1);
