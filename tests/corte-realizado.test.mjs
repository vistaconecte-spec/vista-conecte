/**
 * Teste do "o que foi realmente cortado" (aba CORTE + ficha impressa, main.js).
 *
 * POR QUE ISTO EXISTE: a ficha diz o que foi PEDIDO; o que sai da mesa quase nunca é igual
 * (rolo que rendeu menos, defeito, encaixe que não fechou).
 *
 * MUDANÇA DE 18/08/2026: o cortador NÃO digita mais nada no app — ele disse que não tem
 * tempo (corta em pé, com o papel na mesa). O número agora vai a caneta, na coluna
 * "Cortado" da ficha IMPRESSA. O que estes testes travam:
 *   1. o app não voltar a pedir o número na tela (campo que ninguém preenche não fica
 *      vazio: fica errado, e a dona decide produção em cima dele);
 *   2. a coluna do papel existir e sair VAZIA — em todas as linhas e no total;
 *   3. o que já foi anotado ANTES não se perder: leva pendente ainda vira histórico
 *      quando sai do corte, e o card JÁ CORTADO continua mostrando as antigas;
 *   4. nada disso gravar por cima da nuvem quando a leitura falha.
 *
 * Rodar:  node tests/corte-realizado.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const css  = readFileSync(join(raiz, 'style.css'), 'utf8');

// Extrai funções top-level pelo nome (terminam com "}" na coluna 0)
function extrair(nome) {
  const i = main.indexOf(`function ${nome}(`);
  if (i < 0) throw new Error(`função ${nome} não encontrada em main.js`);
  const fim = main.indexOf('\n}', i);
  return main.slice(i, fim + 2);
}
const nomes = ['crtRef', 'crtTudo'];
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
    },
  },
};
const F = comBanco(banco);

const corte = extrair('renderCorte'); // só o corpo dela: o resto do arquivo tem campo à vontade

console.log('\n1) A aba CORTE não pede mais o número (ele não tem tempo de digitar)');
ok('nenhum campo digitável na ficha da aba', /<input/.test(corte), false);
ok('nem a barra DATA DO CORTE', /crt-databar|class="crt-dt"/.test(main), false);
ok('e o caminho de gravação do que foi cortado não existe mais',
   /function crtInput\(|function crtGravar\(|function crtAtualizarTotais\(/.test(main), false);
ok('sem input, o ciclo de 1 minuto redesenha a aba direto (nada digitado para perder)',
   /if \(modeloAtual === '__corte__'\) renderCorte\(\);/.test(main), true);
ok('o CSS do campo foi junto — regra órfã vira mistério na próxima leitura',
   /crt-in\b|crt-cel|crt-rot|crt-lin-cut/.test(css), false);
ok('a tabela da aba mostra o PEDIDO, sem a linha CORTOU', /CORTOU/.test(corte), false);
ok('e a tela diz onde anotar agora', /coluna <b>Cortado<\/b> da ficha impressa/.test(corte), true);
ok('o nome do modelo abre a ficha dele — atalho da dona para a grade daquele modelo',
   /class="dash-link" onclick="selectModel\(null,'\$\{l\.key\}'\)/.test(corte), true);
ok('e o aparelho da oficina NÃO ganha esse atalho (a tela do modelo tem pedido e preço)',
   /const podeAbrir = !ehPerfilOficina\(\);/.test(corte) && corte.includes('${podeAbrir'), true);

console.log('\n2) A coluna do papel: existe e sai VAZIA');
const ficha = main.slice(main.indexOf('async function gerarFicha('), main.indexOf('function gerarFichaConfeccao'));
ok('cada TAMANHO tem seu par de colunas: o pedido e a casa em branco ao lado',
   /<th colspan="2" class="sz-th">' \+ s \+ '<\/th>/.test(ficha) && /<th class="sub-ped">Pedido<\/th><th class="cut-th">Cortado<\/th>/.test(ficha), true);
ok('a divisória forte fica ENTRE tamanhos, não em volta de cada casa',
   /.prod-table .sz-th, .prod-table .sub-hd .sub-ped, .prod-table .ped-cell { border-left: 2px solid #111/.test(ficha)
   && !/.cut-cell {[^}]*#C4A882/.test(ficha), true);
ok('e a casa em branco vem colada no número daquele tamanho, não no fim da linha',
   /\$\{v \|\| '—'\}<\/td><td class="cut-cell"><\/td>/.test(ficha), true);
ok('cada linha de cor tem a célula em branco — sem nada interpolado dentro',
   /<td class="cut-cell"><\/td>/.test(ficha), true);
ok('não existe mais coluna Total por linha — só o par de cada tamanho',
   (ficha.match(/<th class="sub-ped">Pedido<\/th>/g) || []).length, 1);
ok('em tamanho único a coluna Total continua (senão a ficha fica sem quantidade)',
   ficha.includes("tu ? '<th colspan=\"2\" class=\"sz-th\">Total</th>' :"), true);
ok('e nenhum emoji no cabeçalho da ficha', /\p{Extended_Pictographic}/u.test(ficha), false);
ok('o TOTAL GERAL também tem onde escrever', /<td class="cut-cell cut-cell-tot"><\/td>/.test(ficha), true);
ok('o colspan das faixas conta o dobro de colunas (senão a faixa fica curta)',
   /const colSpan = tu \? 3 : SZ_FICHA\.length \* 2 \+ 1;/.test(ficha), true);
ok('a célula é branca e alta o bastante para escrever a caneta',
   (() => { const m = ficha.match(/\.cut-cell \{([^}]*)\}/);
      return !!m && /background: #fff/.test(m[1])
             && (parseInt((m[1].match(/height: (\d+)px/) || [])[1], 10) || 0) >= 30; })(), true);
ok('e imprime com a moldura visível (print-color-adjust já está ligado)',
   /print-color-adjust: exact/.test(ficha), true);

console.log('\n2b) A ficha imprime com POUCA TINTA (29/08/2026)');
// O cortador imprime uma ficha por leva na impressora DELE e o cartucho acabava: as faixas
// pretas de ponta a ponta e a tarja dourada eram retângulos cheios. Estes testes travam o
// que a folha não pode voltar a ter — nenhum `background` fora do branco, nas TRÊS folhas
// que saem da aba CORTE (ficha do modelo, Ficha total do tecido, folha do molde).
const corpo = nome => {
  const i = main.indexOf(nome);
  if (i < 0) throw new Error(`${nome} não encontrada em main.js`);
  return main.slice(i, main.indexOf('\n}', i) + 2);
};
const fundosDe = txt => (txt.match(/background:\s*#[0-9a-fA-F]{3,6}/g) || [])
  .map(s => s.replace(/\s+/g, '').toLowerCase())
  .filter(s => s !== 'background:#fff' && s !== 'background:#ffffff');
const fichaModelo = corpo('async function gerarFicha(');
const fichaTotal  = corpo('function gerarFichaCorteTotal()');
const folhaMolde  = corpo('function moldeImprimir()');
ok('a ficha do modelo não tem nenhum fundo que não seja branco', fundosDe(fichaModelo), []);
ok('a Ficha total do tecido também não', fundosDe(fichaTotal), []);
ok('e a folha do molde nasce com a mesma regra', fundosDe(folhaMolde), []);
ok('sumiu a zebra das linhas de cor (pintava metade da tabela)',
   /#faf8f5/.test(fichaModelo) || /#faf8f5/.test(fichaTotal), false);
ok('nem sobrou o dourado da marca em texto ou faixa',
   /C4A882/i.test(fichaModelo) || /C4A882/i.test(fichaTotal) || /C4A882/i.test(folhaMolde), false);
ok('o traço preto continua segurando o desenho no lugar do fundo',
   /border-bottom: 3px solid #000/.test(fichaModelo) && /border-bottom:3px solid #000/.test(folhaMolde), true);

console.log('\n3) O que foi anotado ANTES continua legível');
ok('a linha própria do Supabase continua sendo a fonte',
   /const CORTE_KEY = 'corte-realizado';/.test(main), true);
ok('leva pendente antiga ainda é lida', F.crtTudo().levas['macacao-amplo|1'].cores.Preto, [4, 6, 6, 4, 2]);
ok('banco vazio não quebra a leitura', comBanco({}).crtTudo(), { levas: {} });
ok('sem carimbo dos dois lados ainda casa (null e "" são a mesma coisa)',
   F.crtRef(null) === F.crtRef('') && F.crtRef(undefined) === F.crtRef(''), true);
const salvar = main.slice(main.indexOf('function salvarModelo()'), main.indexOf('\n}', main.indexOf('function salvarModelo()')));
ok('salvarModelo (tela da dona) não encosta no dado do corte',
   /cortado|crt[A-Z]|CORTE_KEY/.test(salvar), false);

console.log('\n4) Leva pendente que sai do corte ainda vira histórico');
const T = new Function(extrair('crtTotalDe') + '; return crtTotalDe;')();
ok('soma todas as cores e tamanhos', T({ Preto: [4, 6, 6, 4, 2], Militar: [0, 2, 3, 1, 0] }), 28);
ok('sem nada anotado dá zero', T({}), 0);
ok('buraco no meio do array não quebra', T({ Preto: [1, , 2] }), 3);

const arq = main.slice(main.indexOf('async function crtArquivarConcluidas'),
                       main.indexOf('\n}', main.indexOf('async function crtArquivarConcluidas')));
ok('só arquiva o que NÃO está mais em corte', /if \(status === 'Em corte'\) continue;/.test(arq), true);
ok('leva 2 lê o status da leva 2', /levaTxt === '2' \? saved\.status2 : saved\.status/.test(arq), true);
ok('nada anotado não vira linha de histórico (só sai da lista)', /total \? \{/.test(arq), true);
ok('guarda a data que ele tinha preenchido', /data:\s*r\.data \|\| ''/.test(arq), true);
ok('guarda os tamanhos do modelo junto (a grade muda com o tempo)',
   /tamanhos: MODELOS\[key\] \? tamanhosDe\(MODELOS\[key\]\) : \[\]/.test(arq), true);
ok('dois aparelhos arquivando a mesma leva não duplicam',
   /!hist\.some\(h => h\.id === s\.reg\.id\)/.test(arq), true);
ok('leitura da nuvem falhou → não grava por cima', /if \(nuvem === undefined\) return;/.test(arq), true);
ok('histórico tem teto', /hist\.slice\(0, CORTE_HIST_MAX\)/.test(arq), true);
ok('e mora na MESMA linha do Supabase (o cortador não alcança endpoint)',
   /await salvarNuvem\(CORTE_KEY, novo\)/.test(arq), true);
ok('o card JÁ CORTADO continua na aba, mostrando as levas antigas',
   /JÁ CORTADO/.test(main) && /crtHistoricoHTML\(\)/.test(corte), true);

console.log(`\n${falhas ? '✗' : '✓'} ${total - falhas}/${total} passaram\n`);
process.exit(falhas ? 1 : 0);
