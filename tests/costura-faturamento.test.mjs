/**
 * Teste do FATURAMENTO DA COSTURA (main.js).
 *
 * POR QUE ISTO EXISTE: aqui o que está em jogo é quanto se paga a uma pessoa. Um erro não
 * aparece na tela como bug — aparece como leva cobrada duas vezes, ou como leva entregue que
 * nunca entrou na conta. O que estes testes travam:
 *   1. leva sai de "Em costura" = entrega, e vira valor a pagar UMA vez só;
 *   2. o valor é congelado na entrega (mexer na Precificação depois não reescreve o combinado);
 *   3. leva que volta pra costura com carimbo novo fecha a rodada anterior, sem juntar as duas;
 *   4. leva sem peça nenhuma não vira cobrança;
 *   5. o aparelho da costureira só LÊ: não sincroniza e não marca pago;
 *   6. nada disso lança no Fluxo de Caixa — que já cobra corte+costura pelas vendas.
 *
 * Rodar:  node tests/costura-faturamento.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');

function extrair(nome) {
  const i = main.indexOf(`function ${nome}(`);
  if (i < 0) throw new Error(`função ${nome} não encontrada em main.js`);
  const fim = main.indexOf('\n}', i);
  return main.slice(i, fim + 2);
}

const F = new Function(extrair('cstFatAplicar') + '\n' + extrair('cstFatEntregar')
  + '\n' + extrair('flxCustoModelo')
  + '; return { cstFatAplicar, cstFatEntregar, flxCustoModelo };')();

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

const vazio = () => ({ abertas: {}, aPagar: {}, pagas: [] });
const AGORA = '2026-08-15T12:00:00.000Z';
const naMaquina = { 'saia-midi|1': { ref: 'r1', nome: 'Saia Midi', pecas: 10, unit: 4.5, desde: 'r1' } };

console.log('\n1) Entrar em costura ainda não é cobrança');
const d1 = F.cstFatAplicar(vazio(), naMaquina, AGORA);
ok('a leva entra no retrato', Object.keys(d1.abertas), ['saia-midi|1']);
ok('e nada vai para "a pagar" ainda', Object.keys(d1.aPagar).length, 0);
ok('rodar de novo sem mudança não gera gravação', F.cstFatAplicar(d1, naMaquina, AGORA), null);

console.log('\n2) Sair de "Em costura" É a entrega');
const d2 = F.cstFatAplicar(d1, {}, AGORA);
ok('some do retrato', Object.keys(d2.abertas).length, 0);
ok('e vira uma linha a pagar', Object.keys(d2.aPagar), ['saia-midi|1|r1']);
ok('com peças × valor da época', [d2.aPagar['saia-midi|1|r1'].pecas, d2.aPagar['saia-midi|1|r1'].unit, d2.aPagar['saia-midi|1|r1'].valor], [10, 4.5, 45]);
ok('e a data da entrega', d2.aPagar['saia-midi|1|r1'].entregue_em, AGORA);
ok('passar de novo não cobra duas vezes', F.cstFatAplicar(d2, {}, AGORA), null);

console.log('\n3) O valor é congelado na entrega');
// a Precificação subiu de 4,50 para 9,00 DEPOIS da entrega
const d3 = F.cstFatAplicar(d2, { 'saia-midi|1': { ref: 'r2', nome: 'Saia Midi', pecas: 10, unit: 9, desde: 'r2' } }, AGORA);
ok('a leva já entregue continua valendo o que valia', d3.aPagar['saia-midi|1|r1'].valor, 45);
ok('e a rodada nova entra pelo valor novo', d3.abertas['saia-midi|1'].unit, 9);

console.log('\n4) Leva que volta pra costura fecha a rodada anterior');
const d4 = F.cstFatAplicar(d3, { 'saia-midi|1': { ref: 'r3', nome: 'Saia Midi', pecas: 4, unit: 9, desde: 'r3' } }, AGORA);
ok('a rodada r2 vira cobrança própria', d4.aPagar['saia-midi|1|r2'].valor, 90);
ok('sem se misturar com a r1', [d4.aPagar['saia-midi|1|r1'].valor, Object.keys(d4.aPagar).length], [45, 2]);
ok('e a r3 fica aberta com as peças novas', d4.abertas['saia-midi|1'].pecas, 4);

console.log('\n5) O que não pode virar cobrança');
const semPeca = F.cstFatAplicar({ abertas: { 'x|1': { ref: 'r', nome: 'X', pecas: 0, unit: 5 } }, aPagar: {}, pagas: [] }, {}, AGORA);
ok('leva sem peça nenhuma some sem cobrar', [Object.keys(semPeca.abertas).length, Object.keys(semPeca.aPagar).length], [0, 0]);
const jaPaga = F.cstFatAplicar(
  { abertas: { 'y|1': { ref: 'r', nome: 'Y', pecas: 3, unit: 5 } }, aPagar: {}, pagas: [{ id: 'y|1|r', valor: 15 }] }, {}, AGORA);
ok('leva que já foi paga não volta a aparecer em aberto', Object.keys(jaPaga.aPagar).length, 0);

console.log('\n6) O valor por peça é o da COSTURA — nunca o do corte');
// A linha "Em corte" mostra quanto ELA vai receber para costurar aquelas peças; se um dia
// alguém trocar por c.corte, o número vira o que se paga ao cortador e ninguém percebe.
const fnValor = /function cstValorPeca\(key\) \{[\s\S]*?\n\}/.exec(main)[0];
ok('cstValorPeca lê o campo costura', fnValor.includes('c.costura'), true);
ok('e nunca o campo corte (viraria o que se paga ao cortador)', /c\.corte/.test(fnValor), false);
ok('a tela avisa que o valor do corte é previsão do que ela recebe',
   /\['Em corte', 'previsão do que vai receber', totalCorte\]/.test(main), true);
ok('e o bloco "vem por aí" diz de onde vem o número',
   /pelo valor de <b>costura<\/b> da peça — é a previsão do que ela vai receber, não o que se paga pelo corte/.test(main), true);
const pc = { global: { custoMetro: 12 }, modelos: { 'saia-midi': { costura: 4.5, corte: 2, consumo: 1 }, 'blusa': { costura: 3 } } };
ok('a peça em corte vale a COSTURA dela (4,50), não o corte (2,00)', F.flxCustoModelo(pc, 'saia-midi').costura, 4.5);
ok('modelo sem valor cadastrado devolve 0 (a tela avisa)', F.flxCustoModelo(pc, 'nao-cadastrado').costura, 0);

console.log('\n7) A costureira só LÊ; e nada vai para o Fluxo de Caixa');
ok('sincronização só roda no app da dona',
   /async function cstFatSincronizar\(\) \{\s*\r?\n\s*if \(ehPerfilOficina\(\)\) return;/.test(main), true);
ok('e recarrega os modelos da nuvem antes de decidir quem saiu da costura (local desatualizado '
   + 'não pode virar "entregue" em massa por engano)',
   /if \(ehPerfilOficina\(\)\) return;[\s\S]{0,400}await carregarTodosNuvem\(\);\s*\r?\n\s*const atuais = cstFatAbertasAgora\(\);/.test(main), true);
ok('marcar pago também tem a trava de perfil',
   /async function cstFatPagar\([^)]*\) \{\s*\r?\n\s*if \(ehPerfilOficina\(\)\) return;/.test(main), true);
ok('e o botão "pago" nem é desenhado para ela',
   /const podePagar = !ehPerfilOficina\(\);/.test(main), true);
const bloco = main.slice(main.indexOf('const CST_FAT_KEY'), main.indexOf('// ─── O QUE FOI REALMENTE CORTADO'));
ok('o faturamento não cria conta a pagar no Fluxo (seria o mesmo custo duas vezes)',
   /flxAdd|flxSalvar|flxLancar|vendasIncluir/.test(bloco), false);
ok('a linha do Supabase é própria, sem tabela nova', /const CST_FAT_KEY  = 'costura-faturamento';/.test(main), true);

console.log('\n8) Mora DENTRO da aba COSTURA, e não em aba própria');
ok('renderCostura desenha o card do faturamento',
   /function renderCostura\(\)[\s\S]*?renderFaturamento\(\);/.test(main), true);
ok('e o card é o mesmo "ver mais" das outras faixas',
   /el\.innerHTML = avisoCardHTML\('ti-cash', 'FATURAMENTO DA COSTURA'/.test(main), true);
ok('sem valor ao lado do título — os números vivem na frase de baixo',
   /avisoCardHTML\('ti-cash', 'FATURAMENTO DA COSTURA', '',/.test(main), true);
ok('e o selo do total nem é desenhado quando vem vazio',
   /\$\{tot \? `<span class="aviso-tot">\$\{tot\}<\/span>` : ''\}/.test(main), true);
ok('não sobrou aba/rota própria de faturamento', /__faturamento__|abrirFaturamento/.test(main), false);
ok('fechado, o resumo tem "na máquina agora (ainda não entregue)" e "em corte"',
   /\['Na máquina agora', 'ainda não entregue', totalAgora\][\s\S]{0,120}\['Em corte', 'previsão do que vai receber', totalCorte\]/.test(main), true);
ok('"entregue e não pago" só entra no resumo quando existe',
   /concat\(totalAPagar \? \[\['Entregue e não pago'/.test(main), true);
ok('o valor do corte é só do corte (o tecido em compra não entra nele)',
   /const totalCorte  = vindo\.filter\(l => l\.etapa === 'Em corte'\)/.test(main), true);
const idx = readFileSync(join(raiz, 'index.html'), 'utf8');
ok('o lugar dele no HTML fica logo abaixo do que vem por aí',
   idx.indexOf('id="costura-corte"') < idx.indexOf('id="faturamento-lista"')
   && idx.indexOf('id="faturamento-lista"') < idx.indexOf('FICHAS EM COSTURA'), true);
ok('e o painel avulso sumiu', /panel-faturamento/.test(idx), false);
ok('e nunca grava por cima sem conseguir ler antes',
   /const nuvem = await carregarNuvem\(CST_FAT_KEY\);\s*\r?\n\s*if \(nuvem === undefined\) return;/.test(main), true);

console.log('\n9) A leva que JÁ FOI PAGA e volta pra costura vira cobrança de novo');
// BUG DE 18/08/2026 (relatado pela Bárbara: "troco o status e o faturamento some").
// O id da cobrança era 'chave|leva|carimbo'. Sem carimbo — e 'Em costura' não era carimbado
// quando a troca vinha pelo dropdown da tela do modelo — TODA rodada da mesma leva caía no
// mesmo id, batia em "já contabilizada" e era descartada calada.
const semRef = { 'saia-midi|1': { ref: '', nome: 'Saia Midi', pecas: 10, unit: 4.5, desde: '' } };
const rodada1 = F.cstFatAplicar({ abertas: semRef, aPagar: {}, pagas: [] }, {}, AGORA);
ok('1a rodada vira cobrança', Object.values(rodada1.aPagar).map(p => p.valor), [45]);

// a dona marcou pago: sai de aPagar e entra em pagas
const paga9 = { abertas: semRef, aPagar: {}, pagas: Object.values(rodada1.aPagar).map(p => ({ ...p, pago_em: AGORA })) };
const rodada2 = F.cstFatAplicar(paga9, {}, AGORA);
ok('2a rodada da MESMA leva não some (era o bug)', rodada2 !== null && Object.keys(rodada2.aPagar).length, 1);
ok('e não mexe no que já foi pago', rodada2.pagas.length, 1);
ok('os dois registros têm id diferente',
   Object.keys(rodada2.aPagar)[0] !== rodada2.pagas[0].id, true);

// COM carimbo, reler a mesma rodada continua não duplicando
const comRef = { 'saia-midi|1': { ref: 'r9', nome: 'Saia Midi', pecas: 10, unit: 4.5, desde: 'r9' } };
const r1 = F.cstFatAplicar({ abertas: comRef, aPagar: {}, pagas: [] }, {}, AGORA);
const r2 = F.cstFatAplicar({ abertas: comRef, aPagar: r1.aPagar, pagas: [] }, {}, AGORA);
ok('com carimbo, a MESMA rodada relida não duplica', Object.keys(r2.aPagar).length, 1);

console.log('\n10) Os dois caminhos de troca de status carimbam igual');
// Eram listas diferentes: o botão do card carimbava 'Em costura', o dropdown da tela não —
// e um save da tela apagava o carimbo posto pelo botão.
const listaSalvar = (main.match(/status_at: \[([^\]]*)\]\.includes\(statusVal\)/) || [])[1] || '';
const listaBotao  = (main.match(/saved\.status_at\s*= \[([^\]]*)\]\.includes\(novoStatus\)/) || [])[1] || '';
ok('salvarModelo carimba Em costura', /Em costura/.test(listaSalvar), true);
ok('confirmarStatus também', /Em costura/.test(listaBotao), true);
ok('e a leva 2 idem',
   /status2_at: \['Comprando tecido', 'Em corte', 'Em costura'\]/.test(main), true);

console.log('\n11) Pagar TODAS de uma vez');
// Ela acerta com a costureira por semana: seis botoes seguidos e onde se esquece um.
const tudo = main.slice(main.indexOf('async function cstFatPagarTudo'),
                        main.indexOf('\n}', main.indexOf('async function cstFatPagarTudo')));
ok('o aparelho da costureira nao paga nada', /if \(ehPerfilOficina\(\)\) return;/.test(tudo), true);
ok('le a nuvem antes (outra leva pode ter sido entregue enquanto a tela estava aberta)',
   tudo.indexOf('await carregarNuvem(CST_FAT_KEY)') < tudo.indexOf('confirm('), true);
ok('leitura falhou -> avisa e NAO grava por cima',
   /if \(nuvem === undefined\) \{ alert\([^)]*\); return; \}/.test(tudo), true);
ok('pergunta antes, com quantidade e total do que vai pagar',
   /confirm\(`Marcar como PAGO \$\{itens\.length\}/.test(tudo) && /finBRL\(total\)/.test(tudo), true);
ok('e o total sai do que veio da nuvem, nao do que estava na tela',
   /const total = itens\.reduce\(\(soma, p\) => soma \+ \(p\.valor \|\| 0\), 0\);/.test(tudo), true);
ok('nada a pagar nao vira gravacao vazia',
   /if \(!itens\.length\) \{ alert\([^)]*\); renderFaturamento\(\); return; \}/.test(tudo), true);
ok('cada leva paga leva a data do pagamento', /itens\.forEach\(p => \{ p\.pago_em = agora; \}\);/.test(tudo), true);
ok('a lista de pagas continua com teto', /slice\(0, CST_PAGAS_MAX\)/.test(tudo), true);
ok('e o "a pagar" fica realmente vazio depois', /d\.aPagar = \{\};/.test(tudo), true);

const cardFat = main.slice(main.indexOf('function renderFaturamento'), main.indexOf('\n}', main.indexOf('function renderFaturamento')));
ok('o botao so aparece para quem pode pagar e com 2+ levas esperando',
   /podePagar && aPagar\.length > 1/.test(cardFat), true);
ok('e mostra o valor do acerto no proprio botao',
   /Pagar todas .{1,3} \$\{finBRL\(totalAPagar\)\}/.test(cardFat), true);

console.log(falhas ? `\n✗ ${total - falhas}/${total} passaram` : `\n✓ ${total}/${total} passaram`);
process.exit(falhas ? 1 : 0);
