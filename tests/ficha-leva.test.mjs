/**
 * Teste da FICHA: uma leva por folha (main.js, gerarFicha).
 *
 * POR QUE ISTO EXISTE (29/08/2026): a ficha desenhava a leva 1 e a 2ª leva na MESMA folha,
 * em duas seções, e somava as duas no "TOTAL GERAL". A produção se perdia — as duas levas
 * podem estar em ETAPAS diferentes (a leva 1 já em costura e a 2ª ainda no corte), então o
 * papel misturava o que é para cortar agora com o que não é, e o total não era o total de
 * nada. Hoje cada leva tem a sua folha.
 *
 * Este teste RODA a gerarFicha de verdade, com o DOM e a nuvem de mentira, e confere o HTML
 * que sairia na impressora — regex sobre o código não pegaria a soma errada.
 *
 * Rodar:  node tests/ficha-leva.test.mjs
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
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

const i = main.indexOf('async function gerarFicha(');
const src = main.slice(i, main.indexOf('\n}', i) + 2);

const DEF = {
  nome: 'Calça Pantalona Moletom', tecido: 'Moletom', consumo: 1.3,
  componentes: '2 Frentes – 2 Costas', obs: '',
  cores: ['Preto', 'Nude'], aberto: {},
};
// Leva 1: 10 peças em duas cores. 2ª leva: 7 peças só no Preto.
// Somadas dariam 17 — o número que a folha NÃO pode mais mostrar.
const SALVO = {
  nome: 'Calça Pantalona Moletom',
  status: 'Em costura', prazo: '2026-09-01',
  status2: 'Em corte',  prazo2: '2026-09-20',
  prod:  { Preto: [1, 2, 3, 0, 0], Nude: [4, 0, 0, 0, 0] },
  prod2: { Preto: [0, 0, 0, 7, 0], Nude: [0, 0, 0, 0, 0] },
};

// Roda a ficha com o DOM de mentira e devolve o HTML que iria para a impressora.
async function ficha(leva, salvo = SALVO, piloto = false, def = DEF) {
  let saida = null;
  const fn = new Function(
    'MODELOS', 'loadLocal', 'coresDoModelo', 'tamanhosDe', 'document', 'urlToBase64', 'modeloAtual', 'window', 'ehPiloto',
    src + '; return gerarFicha;'
  )(
    { 'calca-pantalona': def },
    k => (k === 'vc:calca-pantalona' ? salvo : null),
    def => def.cores,
    () => ['PP', 'P', 'M', 'G', 'GG'],
    { getElementById: () => null, querySelectorAll: () => [] },
    async () => null,
    null,
    { open: () => ({ document: { write: h => { saida = h; }, close: () => {} } }) },
    () => piloto
  );
  await fn('calca-pantalona', leva);
  return saida;
}

const f1 = await ficha(1);
const f2 = await ficha(2);

console.log('\n1) Cada folha traz UMA leva — nunca as duas somadas');
ok('a folha da leva 1 conta só as peças dela', /10 peças/.test(f1), true);
ok('a folha da 2ª leva conta só as peças dela', /7 peças/.test(f2), true);
ok('nenhuma das duas mostra a soma das levas',
   /17 peças/.test(f1) || /17 peças/.test(f2), false);
ok('e a linha final não se chama mais TOTAL GERAL (não é o total do modelo)',
   /TOTAL GERAL/.test(f1) || /TOTAL GERAL/.test(f2), false);
ok('a folha não tem mais faixa de seção separando leva de leva',
   /section-hd/.test(f1) || /section-hd/.test(f2), false);
ok('o 7 da 2ª leva não aparece na folha da leva 1',
   />7</.test(f1), false);

console.log('\n2) A folha diz QUAL leva é (duas fichas do mesmo modelo ficariam idênticas)');
ok('leva 1 sai marcada como principal', /Leva principal/.test(f1), true);
ok('2ª leva sai marcada como 2ª', /2ª leva de produção/.test(f2), true);

console.log('\n3) Status e prazo são os DAQUELA leva');
ok('a leva 1 traz o status dela', /Status <strong>Em costura<\/strong>/.test(f1), true);
ok('a 2ª leva traz o status dela', /Status <strong>Em corte<\/strong>/.test(f2), true);
ok('e cada uma traz o prazo dela (a 2ª leva tem prazo2 próprio)',
   [/01\/09\/2026/.test(f1), /20\/09\/2026/.test(f2)], [true, true]);
ok('a folha não fala do status da outra leva', /Status 2ª leva/.test(f1), false);

console.log('\n4) Cor zerada na 2ª leva não vira linha (tecido que ninguém pediu)');
ok('o Nude está na folha da leva 1 (tem 4 peças)', /Nude/.test(f1), true);
ok('e some da folha da 2ª leva (tem 0)', /Nude<\/td>/.test(f2), false);
// A faixa "Cores" é o que ele lê antes de separar o rolo: prometer cor que não está na
// tabela abaixo manda buscar tecido à toa.
ok('e some também da faixa de cores do topo, não só da tabela',
   /<span class="cor-tag">Nude<\/span>/.test(f2), false);
ok('mas continua na faixa da leva 1', /<span class="cor-tag">Nude<\/span>/.test(f1), true);

console.log('\n5) Sem leva no argumento, vale a que está EM CORTE');
// A regra vem da Bárbara: a ficha é o papel do corte, então quem manda é o status "Em corte".
const auto = await ficha(undefined);
ok('escolheu a 2ª leva, que é a que está em corte', /2ª leva de produção/.test(auto), true);
ok('e com ela veio o número da 2ª leva', /7 peças/.test(auto), true);

const soLeva1 = await ficha(undefined, { ...SALVO, status: 'Em corte', status2: '' });
ok('leva 1 em corte e 2ª sem status → sai a leva 1', /Leva principal/.test(soLeva1), true);

const semStatus = await ficha(undefined, { ...SALVO, status: '', status2: '' });
ok('nenhuma com status → cai na leva 1', /Leva principal/.test(semStatus), true);

const so2 = await ficha(undefined, { ...SALVO, status: '', status2: 'Comprando tecido' });
ok('só a 2ª tem status → sai a 2ª', /2ª leva de produção/.test(so2), true);

console.log('\n6) Cada botão de ficha manda a leva do SEU card');
const corte   = main.slice(main.indexOf('function renderCorte()'), main.indexOf('// ─── ABA COSTURA'));
const costura = main.slice(main.indexOf('function renderCostura()'), main.indexOf('// ─── FATURAMENTO DA COSTURA'));
const html    = readFileSync(join(raiz, 'index.html'), 'utf8');
ok('a ficha da aba CORTE sai com a leva daquele card',
   /gerarFicha\('\$\{l\.key\}',\$\{l\.leva\}\)/.test(corte), true);
ok('a da aba COSTURA também', /gerarFicha\('\$\{l\.key\}',\$\{l\.leva\}\)/.test(costura), true);
ok('e a 2ª leva da tela do modelo tem botão próprio (o de cima é o da principal)',
   /onclick="gerarFicha\(modeloAtual,2\)"/.test(html), true);

console.log('\n7) Peça em pilotagem sai carimbada como PILOTO');
// "Peça em pilotagem não pode ser confundida com peça de produção na hora de mandar
// corte/compra" (comentário do grupo PILOTOS, no data.js). Piloto tem molde de UM tamanho e
// se corta UMA peça — cortar a grade inteira achando que é produção é rolo perdido.
const pil = await ficha(1, { ...SALVO, status: 'Em corte' }, true);
ok('a folha do piloto carimba no cabeçalho, não só na observação do rodapé',
   /class="ficha-piloto">Piloto — peça de prova</.test(pil), true);
// Piloto se corta UMA peça, então o singular é o caso comum justamente nesta folha.
const uma = await ficha(1, { ...SALVO, prod: { Preto: [0, 0, 1, 0, 0] }, prod2: {} }, true);
ok('uma peça só sai no singular, não "1 peças"', /1 peça</.test(uma), true);
ok('e a peça de produção não ganha carimbo nenhum', /class="ficha-piloto"/.test(f1), false);
ok('o carimbo é moldura, não tarja pintada (a folha é de pouca tinta)',
   /\.ficha-piloto \{[^}]*border: 2px solid #000/.test(pil)
   && !/\.ficha-piloto \{[^}]*background/.test(pil), true);

// No piloto, tecido e consumo ficam vazios DE PROPÓSITO (data.js): número chutado aqui vira
// metragem errada na compra. "0m" seria um número — e o cortador separa rolo por ele.
const PILOTO_DEF = { ...DEF, tecido: '', consumo: 0 };
const semDados = await ficha(1, { ...SALVO, tecido: '', consumo: 0 }, true, PILOTO_DEF);
// Sem regex: o valor impresso ao lado do rotulo, lido na unha. A folha traz um comentario
// HTML que cita "0m" ao explicar a regra, e um /0m/ solto casaria com ele em vez do numero.
const valorDe = (html, rotulo) => {
  const marca = '<div class="item-label">' + rotulo + '</div>';
  const i = html.indexOf(marca);
  if (i < 0) return null;
  const abre = '<div class="item-val">';
  const j = html.indexOf(abre, i);
  if (j < 0) return null;
  const ini = j + abre.length;
  return html.slice(ini, html.indexOf('<', ini));
};
ok('sem consumo definido a folha diz travessão, não "0m"', valorDe(semDados, 'Consumo / Peça'), '—');
ok('e o tecido em branco também vira travessão', valorDe(semDados, 'Tecido'), '—');
ok('mas a peça de produção continua mostrando os números dela',
   [valorDe(f1, 'Tecido'), valorDe(f1, 'Consumo / Peça')], ['Moletom', '1.3m']);

console.log('\n8) Quem decide se é piloto é o grupo PILOTOS da barra lateral');
// Sem flag nova no modelo: quando o piloto é aprovado a chave muda de grupo e o carimbo
// some sozinho. Uma flag separada dependeria de alguém lembrar de apagá-la.
const dataJs = readFileSync(join(raiz, 'data.js'), 'utf8');
const iP = main.indexOf('function ehPiloto(');
const ehPilotoReal = new Function('SIDEBAR_ESTRUTURA',
  main.slice(iP, main.indexOf('\n}', iP) + 2) + '; return ehPiloto;');
const ESTRUTURA = new Function(dataJs + '; return SIDEBAR_ESTRUTURA;')();
const eh = ehPilotoReal(ESTRUTURA);
ok('a coleção nova de 28/08 é piloto', [eh('vestido-sereia'), eh('top-laco')], [true, true]);
ok('peça de produção não é', [eh('calca-pantalona'), eh('macacao-amplo')], [false, false]);
ok('chave que não existe não quebra', eh('nao-existe'), false);
ok('aprovado o piloto, a chave muda de grupo e o carimbo some sozinho',
   ehPilotoReal(ESTRUTURA.map(g => g.titulo === 'PILOTOS'
     ? { ...g, modelos: g.modelos.filter(k => k !== 'top-laco') } : g))('top-laco'), false);
ok('e sem o grupo PILOTOS nada é piloto (não explode)',
   ehPilotoReal(ESTRUTURA.filter(g => g.titulo !== 'PILOTOS'))('top-laco'), false);

console.log(`\n${falhas ? '✗' : '✓'} ${total - falhas}/${total} passaram\n`);
process.exit(falhas ? 1 : 0);
