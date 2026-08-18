/**
 * Teste do PAGAMENTO POR ETAPA — card do topo da aba COSTURA (main.js).
 *
 * POR QUE ISTO EXISTE: é dinheiro de gente na tela. O card diz quanto ela recebe pelo que
 * JÁ FOI CORTADO (está na máquina) e quanto vem pelo que ESTÁ SENDO CORTADO (previsão).
 * O que estes testes travam:
 *   1. cada etapa no seu bloco — o que está no corte nunca entra no total do que já é dela;
 *   2. o R$ por peça sai da Precificação (cstValorPeca), o MESMO do card de faturamento;
 *   3. modelo sem valor cadastrado avisa em vez de somar R$ 0,00 em silêncio;
 *   4. sem nada em nenhuma etapa o card some (display:none), não fica bloco vazio;
 *   5. o formato é o mesmo do alerta da aba CORTE (blocoCompactoHTML), um cartão por modelo.
 *
 * Rodar:  node tests/costura-pagamento.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const html = readFileSync(join(raiz, 'index.html'), 'utf8');

function extrair(nome) {
  const i = main.indexOf(`function ${nome}(`);
  if (i < 0) throw new Error(`função ${nome} não encontrada em main.js`);
  const fim = main.indexOf('\n}', i);
  return main.slice(i, fim + 2);
}

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

// Levas de mentira: Saia na máquina (já cortada), Vestido e 2ª leva da Saia ainda no corte.
const MODELOS = {
  'saia-midi':     { nome: 'Saia Midi',     tecido: 'Viscolycra' },
  'vestido-amplo': { nome: 'Vestido Amplo', tecido: 'Linho' },
  'sem-preco':     { nome: 'Sem Preço',     tecido: 'Malha' },
};
const salvos = {
  'saia-midi':     { status: 'Em costura', prod:  { Preto: [0, 2, 3, 0, 0] },
                     status2: 'Em corte',  prod2: { Areia: [1, 1, 1, 1, 1] } },
  'vestido-amplo': { status: 'Em corte',   prod:  { Verde: [0, 0, 4, 0, 0] } },
  'sem-preco':     { status: 'Em costura', prod:  { Cru:   [0, 0, 2, 0, 0] } },
};
const VALOR = { 'saia-midi': 4.5, 'vestido-amplo': 6, 'sem-preco': 0 };

function montar(cadastrados) {
  const el = { innerHTML: '', style: { display: '' } };
  new Function(
    'MODELOS', 'CONJUNTO_PECAS', 'loadLocal', 'tamanhosDe', 'document', 'cstValorPeca', 'finBRL',
    extrair('blocoCompactoHTML') + '\n' + extrair('cstLevasDe') + '\n'
      + extrair('renderPagamentoCostura') + '; renderPagamentoCostura();'
  )(MODELOS, {},
    k => (cadastrados[k.replace('vc:', '')] || null),
    () => ['PP', 'P', 'M', 'G', 'GG'],
    { getElementById: id => (id === 'costura-pagamento' ? el : null) },
    key => VALOR[key] || 0,
    v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  return el;
}

const el = montar(salvos);
const out = el.innerHTML;

console.log('\n1) O card mora no topo da aba COSTURA');
ok('o elemento existe no index.html, acima do "vem por aí"',
   html.indexOf('id="costura-pagamento"') > 0 && html.indexOf('id="costura-pagamento"') < html.indexOf('id="costura-corte"'), true);
ok('e nasce escondido, como todo aviso da tela', /id="costura-pagamento" style="display:none/.test(html), true);
ok('renderCostura chama o card', /renderPagamentoCostura\(\); \/\//.test(main), true);

console.log('\n2) Duas etapas, cada uma no seu bloco');
ok('o que já foi cortado vem primeiro',
   out.indexOf('já foi cortado') < out.indexOf('está sendo cortado'), true);
ok('e são dois blocos, na cor da etapa (teal na máquina, roxo no corte)',
   [out.includes('#0891b2'), out.includes('#7C3AED')], [true, true]);

console.log('\n3) A conta: peças × R$ da Precificação');
// Na máquina: Saia 5 × 4,50 = 22,50 | Sem Preço 2 × 0 = 0 → 7 peças, R$ 22,50
ok('o topo do bloco "já cortado" soma peças e reais', /7 peças · R\$ 22,50/.test(out), true);
// No corte: Saia 2ª leva 5 × 4,50 = 22,50 | Vestido 4 × 6 = 24,00 → 9 peças, R$ 46,50
ok('o topo do bloco "sendo cortado" idem', /9 peças · R\$ 46,50/.test(out), true);
ok('a 2ª leva aparece marcada, sem se juntar à leva 1', /Saia Midi \(2ª leva\)/.test(out), true);
ok('cada cartão mostra o valor da leva', [/R\$ 22,50/.test(out), /R\$ 24,00/.test(out)], [true, true]);
ok('e a conta que gerou ele', /5 × R\$ 4,50/.test(out), true);
ok('a leva do corte NÃO entra no total do que já é dela',
   out.slice(0, out.indexOf('está sendo cortado')).includes('Vestido Amplo'), false);

console.log('\n4) Sem valor na Precificação avisa, não soma zero calado');
ok('o cartão do modelo sem preço diz o que falta', /sem valor na Precificação/.test(out), true);

console.log('\n5) Nada em nenhuma etapa = card some');
const vazio = montar({});
ok('sem leva nenhuma o card fica escondido', [vazio.style.display, vazio.innerHTML], ['none', '']);

console.log('\n6) Mesmo formato do alerta da aba CORTE');
ok('os dois usam blocoCompactoHTML — um desenho só para as duas telas',
   (main.match(/blocoCompactoHTML\(/g) || []).length >= 3, true);
ok('o alerta do corte também passou a chamar o helper',
   /return blocoCompactoHTML\(r, titulo, resumo,/.test(main), true);

console.log(falhas === 0 ? `\n✓ ${total}/${total} passaram` : `\n✗ ${falhas} de ${total} falharam`);
process.exit(falhas === 0 ? 0 : 1);
