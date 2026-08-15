/**
 * Teste do "o que foi realmente cortado" (aba CORTE, main.js).
 *
 * POR QUE ISTO EXISTE: a ficha sempre mostrou só o que foi PEDIDO. O que sai da mesa
 * quase nunca é igual (rolo que rendeu menos, defeito, encaixe que não fechou), e a dona
 * precisa ver os dois números lado a lado. O que estes testes travam é o que NÃO pode
 * acontecer:
 *   1. o que o cortador digitou sumir quando a dona salvar o modelo (por isso o dado mora
 *      numa linha própria: salvarModelo remonta o JSON do modelo a partir da tela dela e
 *      descarta qualquer campo que não esteja lá);
 *   2. a anotação de uma rodada antiga reaparecer quando a leva volta para o corte;
 *   3. gravar por cima da nuvem quando a leitura falhou;
 *   4. o redesenho automático apagar o que ele está digitando.
 *
 * Rodar:  node tests/corte-realizado.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');

// Extrai funções top-level pelo nome (terminam com "}" na coluna 0)
function extrair(nome) {
  const i = main.indexOf(`function ${nome}(`);
  if (i < 0) throw new Error(`função ${nome} não encontrada em main.js`);
  const fim = main.indexOf('\n}', i);
  return main.slice(i, fim + 2);
}
const nomes = ['crtRef', 'crtTudo', 'crtRegistro', 'crtCortadoCor', 'crtDifHTML'];
const fonte = nomes.map(extrair).join('\n');
// loadLocal e CORTE_KEY entram por fora: o teste não tem localStorage nem navegador
const comBanco = banco => new Function('loadLocal', 'CORTE_KEY',
  fonte + `; return { ${nomes.join(', ')} };`)(k => banco[k] || null, 'corte-realizado');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

const RODADA = '2026-08-14T11:00:00.000Z';
const banco = {
  'vc:corte-realizado': {
    levas: {
      'macacao-amplo|1': { ref: RODADA, cores: { Preto: [4, 6, 6, 4, 2], Militar: [0, 0, 3, 0, 0] }, at: RODADA },
      'flat|1':          { ref: RODADA, cores: { 'Off White': [1, 2, 3] }, at: RODADA },
    },
  },
};
const F = comBanco(banco);

console.log('\n1) A anotação vale só para a rodada de corte em que foi feita');
ok('mesma rodada: devolve o que ele anotou',
   F.crtRegistro('macacao-amplo', 1, RODADA).cores.Preto, [4, 6, 6, 4, 2]);
ok('a leva voltou para o corte (carimbo novo) → ficha abre em branco',
   F.crtRegistro('macacao-amplo', 1, '2026-08-20T09:00:00.000Z'), null);
ok('leva 2 do mesmo modelo é outro registro',
   F.crtRegistro('macacao-amplo', 2, RODADA), null);
ok('modelo sem nada anotado',
   F.crtRegistro('vestido-amplo', 1, RODADA), null);
ok('sem carimbo dos dois lados ainda casa (null e "" são a mesma coisa)',
   F.crtRef(null) === F.crtRef('') && F.crtRef(undefined) === F.crtRef(''), true);

console.log('\n2) Número de tamanhos: nunca escorrega de coluna');
const reg = F.crtRegistro('macacao-amplo', 1, RODADA);
ok('roupa PP-GG: 5 posições', F.crtCortadoCor(reg, 'Preto', 5), [4, 6, 6, 4, 2]);
ok('cor sem nada anotado vem zerada, no tamanho certo',
   F.crtCortadoCor(reg, 'Marsala', 5), [0, 0, 0, 0, 0]);
// Calçado (Flat) usa 34-40 = 7 posições; registro antigo com 3 não pode faltar coluna
ok('registro mais curto que a grade completa com zero à direita',
   F.crtCortadoCor(F.crtRegistro('flat', 1, RODADA), 'Off White', 7), [1, 2, 3, 0, 0, 0, 0]);
ok('sem registro nenhum devolve a grade zerada',
   F.crtCortadoCor(null, 'Preto', 5), [0, 0, 0, 0, 0]);

console.log('\n3) Pedido x cortado: a diferença aparece do jeito certo');
ok('nada anotado: traço, e NENHUMA diferença gritando em vermelho',
   F.crtDifHTML(0, 24).includes('—') && !F.crtDifHTML(0, 24).includes('-24'), true);
ok('cortou menos: mostra a falta em vermelho', /#dc2626[\s\S]*-2/.test(F.crtDifHTML(22, 24)), true);
ok('cortou tudo: verde e sem diferença',
   F.crtDifHTML(24, 24).includes('#16a34a') && !/>[-+]\d/.test(F.crtDifHTML(24, 24)), true);
ok('cortou a mais: sinal de + explícito', F.crtDifHTML(26, 24).includes('+2'), true);

console.log('\n4) O que ele digita não pode sumir');
const salvar = main.slice(main.indexOf('function salvarModelo()'), main.indexOf('\n}', main.indexOf('function salvarModelo()')));
ok('salvarModelo (tela da dona) não encosta no dado do corte',
   /cortado|crt[A-Z]|CORTE_KEY/.test(salvar), false);
ok('o dado do corte tem linha própria na tabela',
   /const CORTE_KEY = 'corte-realizado';/.test(main), true);

const gravar = main.slice(main.indexOf('async function crtGravar()'), main.indexOf('\n}', main.indexOf('async function crtGravar()')));
ok('lê a nuvem antes de gravar (a linha é uma só para o sistema inteiro)',
   /await carregarNuvem\(CORTE_KEY\)/.test(gravar), true);
ok('leitura falhou → NÃO grava por cima, tenta de novo',
   /if \(nuvem === undefined\)[\s\S]{0,400}setTimeout\(crtGravar/.test(gravar), true);
ok('mescla só as levas mexidas, não troca o objeto inteiro',
   /dados\.levas\[a\.key \+ '\|' \+ a\.leva\] =/.test(gravar), true);

ok('o ciclo automático de 1 minuto não redesenha enquanto ele digita',
   /if \(modeloAtual === '__corte__'\) \{ if \(!crtOcupado\(\)\) renderCorte\(\); \}/.test(main), true);
ok('crtOcupado cobre digitação recente, não só o salvamento pendente',
   /_crtUltimoInput < \d+/.test(main), true);

console.log('\n5) O que foi cortado vira registro quando a leva sai do corte');
// Antes disso a dona trocava o status para "Em costura" e o que ele tinha anotado sumia
// junto com a ficha — ninguém sabia depois quanto realmente saiu daquela rodada.
const T = new Function(extrair('crtTotalDe') + '; return crtTotalDe;')();
ok('soma todas as cores e tamanhos', T({ Preto: [4, 6, 6, 4, 2], Militar: [0, 2, 3, 1, 0] }), 28);
ok('sem nada anotado dá zero', T({}), 0);
ok('buraco no meio do array não quebra', T({ Preto: [1, , 2] }), 3);

const arq = main.slice(main.indexOf('async function crtArquivarConcluidas'),
                       main.indexOf('\n}', main.indexOf('async function crtArquivarConcluidas')));
ok('só arquiva o que NÃO está mais em corte', /if \(status === 'Em corte'\) continue;/.test(arq), true);
ok('leva 2 lê o status da leva 2', /levaTxt === '2' \? saved\.status2 : saved\.status/.test(arq), true);
ok('nada anotado não vira linha de histórico (só sai da lista)', /total \? \{/.test(arq), true);
ok('guarda a data que ele preencheu', /data:\s*r\.data \|\| ''/.test(arq), true);
ok('guarda os tamanhos do modelo junto (a grade muda com o tempo)',
   /tamanhos: MODELOS\[key\] \? tamanhosDe\(MODELOS\[key\]\) : \[\]/.test(arq), true);
ok('dois aparelhos arquivando a mesma leva não duplicam',
   /!hist\.some\(h => h\.id === s\.reg\.id\)/.test(arq), true);
ok('leitura da nuvem falhou → não grava por cima', /if \(nuvem === undefined\) return;/.test(arq), true);
ok('histórico tem teto', /hist\.slice\(0, CORTE_HIST_MAX\)/.test(arq), true);
ok('e mora na MESMA linha do Supabase (o cortador não alcança endpoint)',
   /await salvarNuvem\(CORTE_KEY, novo\)/.test(arq), true);

console.log('\n6) A data do corte usa o mesmo caminho de gravação dos números');
ok('a barra de data está na ficha', /<input type="date" class="crt-dt"/.test(main), true);
ok('e é lida na hora de gravar', /input\.crt-dt[\s\S]{0,220}data: \(dt && dt\.value\) \|\| ''/.test(main), true);
ok('data não passa pelo ajuste de número nem mexe nos totais',
   /const ehData = inp\.classList\.contains\('crt-dt'\);[\s\S]{0,260}if \(!ehData\) crtAtualizarTotais/.test(main), true);

console.log(`\n${falhas ? '✗' : '✓'} ${total - falhas}/${total} passaram\n`);
process.exit(falhas ? 1 : 0);
