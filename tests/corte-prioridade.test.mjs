/**
 * Teste da ORDEM DE CORTE (aba CORTE, main.js).
 *
 * POR QUE ISTO EXISTE: a lista saía do mais parado para o menos parado, e "parado há mais
 * tempo" não é "mais urgente" — uma leva que ninguém espera ficava na frente de outra que,
 * cortada hoje, faz seis pedidos pagos saírem amanhã. O que estes testes travam:
 *   1. pedido que sai SÓ com esta peça pesa mais que pedido que ainda depende de outra;
 *   2. venda de CONJUNTO conta para as peças dele (senão a Calça Boho parece modelo fraco);
 *   3. o atraso tem teto — 60 dias não pode atropelar tudo o mais;
 *   4. sem dado de prioridade nada quebra: a ordem só volta a ser a antiga.
 *
 * Rodar:  node tests/corte-prioridade.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const orders = readFileSync(join(raiz, 'functions/api/shopify-orders.js'), 'utf8');

function extrair(nome) {
  const i = main.indexOf(`function ${nome}(`);
  if (i < 0) throw new Error(`função ${nome} não encontrada em main.js`);
  const fim = main.indexOf('\n}', i);
  return main.slice(i, fim + 2);
}
const nomes = ['crtEstrelas', 'crtScore', 'crtPrioridadeDe', 'crtCalcularTravados',
               'crtVendasPorPeca', 'crtMotivoHTML', 'diasDesde'];
const fonte = nomes.map(extrair).join('\n');
const criar = (pendentes, conjuntos) => new Function('window', 'CONJUNTO_PECAS',
  fonte + `; return { ${nomes.join(', ')} };`)({ _pedidosPendentes: pendentes }, conjuntos || {});

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

const diasAtras = d => new Date(Date.now() - d * 86400000).toISOString();

console.log('\n1) Pedido parado: quem sai SÓ com esta peça conta separado');
// #1 só falta a calça-flare  → cortar a flare manda o pedido embora
// #2 falta flare E moletom   → cortar a flare sozinha não libera nada ainda
const F = criar([
  { data: diasAtras(12), faltas: [{ key: 'calca-flare' }] },
  { data: diasAtras(3),  faltas: [{ key: 'calca-flare' }, { key: 'moletom-gola-alta' }] },
  { data: diasAtras(1),  faltas: [{ key: 'calca-flare' }] },
]);
const t = F.crtCalcularTravados();
ok('flare: 3 pedidos parados, 2 saem só com ela', [t['calca-flare'].pedidos, t['calca-flare'].sozinho], [3, 2]);
ok('flare: idade do mais antigo', t['calca-flare'].dias, 12);
ok('moletom: 1 parado, nenhum sai só com ele', [t['moletom-gola-alta'].pedidos, t['moletom-gola-alta'].sozinho], [1, 0]);
ok('mesmo pedido não conta duas vezes na mesma peça',
   F.crtCalcularTravados({}).length, undefined);

console.log('\n2) A ordem: destravar pedido pesa mais que antiguidade');
const score = (o, est) => F.crtScore(o, est || 0);
ok('2 pedidos que saem só com ela > 2 pedidos que ainda dependem de outra peça',
   score({ sozinho: 2, pedidos: 2, dias: 0 }) > score({ sozinho: 0, pedidos: 2, dias: 0 }), true);
ok('1 pedido destravado > 5 dias de espera sem ninguém na fila',
   score({ sozinho: 1, pedidos: 1, dias: 0 }) > score({ sozinho: 0, pedidos: 0, dias: 5 }), true);
ok('atraso tem teto: 60 dias não vale mais que 30',
   score({ sozinho: 0, pedidos: 0, dias: 60 }), score({ sozinho: 0, pedidos: 0, dias: 30 }));
ok('campeã de vendas sobe mesmo sem pedido travado',
   score({ sozinho: 0, pedidos: 0, dias: 0 }, 3) > 0, true);
ok('mas não passa na frente de quem destrava pedido',
   score({ sozinho: 2, pedidos: 2, dias: 0 }, 0) > score({ sozinho: 0, pedidos: 0, dias: 0 }, 3), true);

console.log('\n3) Estrelas: comparação com o campeão da própria loja');
ok('metade do campeão = 3 estrelas', F.crtEstrelas(700, 1344), 3);
ok('um quarto = 2 estrelas',         F.crtEstrelas(340, 1344), 2);
ok('10% = 1 estrela',                F.crtEstrelas(140, 1344), 1);
ok('quase nada = nenhuma',           F.crtEstrelas(20, 1344), 0);
ok('sem venda nenhuma não quebra',   F.crtEstrelas(0, 0), 0);

console.log('\n4) Venda de CONJUNTO é venda das peças dele');
const G = criar([], { 'conjunto-boho': ['calca-boho', 'blusa-boho'] });
ok('conjunto distribui para as duas peças',
   G.crtVendasPorPeca({ 'conjunto-boho': 40, 'calca-boho': 5 }),
   { 'calca-boho': 45, 'blusa-boho': 40 });
ok('modelo comum passa direto', G.crtVendasPorPeca({ 'calca-flare': 880 }), { 'calca-flare': 880 });

console.log('\n5) Sem dado de prioridade, nada quebra');
ok('modelo sem nada: score 0 (cai no critério antigo, o mais parado no topo)',
   F.crtPrioridadeDe('vestido-amplo', {}).score, 0);
ok('e sem selo na tela', F.crtMotivoHTML(F.crtPrioridadeDe('vestido-amplo', {})), '');
const motivoFlare = F.crtMotivoHTML(F.crtPrioridadeDe('calca-flare', { travados: t, vendas: {}, vendas_max: 0 }));
ok('a tarja é a palavra + quantos pedidos esperam o modelo, e nada mais',
   motivoFlare, '<div class="crt-motivo"><b>PRIORIDADE</b> · 3 pedidos esperando este modelo</div>');
ok('singular certo',
   F.crtMotivoHTML({ score: 1, sozinho: 1, pedidos: 1, dias: 9, estrelas: 3, unidades: 900 }),
   '<div class="crt-motivo"><b>PRIORIDADE</b> · 1 pedido esperando este modelo</div>');
// O detalhe saiu da TELA, não da CONTA: apagar esses campos mudaria a ordem da fila.
ok('nada de "saem só com esta peça" na tela',  /saem só com/.test(motivoFlare), false);
ok('nada de "mais antigo há" na tela',         /mais antigo/.test(motivoFlare), false);
ok('nada de estrelas na tela',                 /★/.test(motivoFlare), false);
ok('mas eles continuam mandando na ordem',
   F.crtScore({ sozinho: 2, pedidos: 2, dias: 10 }, 2) > F.crtScore({ sozinho: 0, pedidos: 2, dias: 0 }, 0), true);
ok('modelo que vende muito e não tem ninguém na fila: sem tarja, mas ainda pontua',
   [F.crtMotivoHTML({ score: 18, pedidos: 0, estrelas: 3 }), F.crtScore({ pedidos: 0 }, 3) > 0], ['', true]);

console.log('\n5b) A prioridade é escrita em VERMELHO (é o que manda fazer antes)');
const css = readFileSync(join(raiz, 'style.css'), 'utf8');
const bloco = css.slice(css.indexOf('.crt-pos {'), css.indexOf('.crt-motivo b'));
ok('número da fila em vermelho',      /\.crt-pos-1 \{ background: #dc2626/.test(bloco), true);
ok('linha do motivo em vermelho',     /\.crt-motivo \{[^}]*color: #dc2626/.test(bloco), true);
ok('sem sobrar roxo nesse pedaço',    /#7C3AED/.test(bloco), false);

console.log('\n5c) Só DUAS fichas levam a tarja — lista em que tudo é prioridade não prioriza nada');
ok('corta a lista de prioritárias em 2',
   /levas\.filter\(l => l\.p\.pedidos > 0\)[\s\S]{0,160}\.slice\(0, 2\)/.test(main), true);
ok('e só entra quem tem pedido esperando',
   /const prioritarias = levas\.filter\(l => l\.p\.pedidos > 0\)/.test(main), true);
ok('da terceira em diante volta a fila antiga (mais parado no topo)',
   /levas\.filter\(l => !marcadas\.has\(l\)\)\.sort\(\(a, b\) => \(b\.dias \?\? -1\) - \(a\.dias \?\? -1\)\)/.test(main), true);
ok('número e tarja só aparecem na ficha marcada',
   /\$\{l\.prioritaria \? crtMotivoHTML\(l\.p\) : ''\}/.test(main), true);

console.log('\n6) O cortador continua sem acesso a pedido/cliente');
const mid = readFileSync(join(raiz, 'functions/api/_middleware.js'), 'utf8');
ok('a allowlist do perfil corte continua VAZIA', /const CORTE_LIBERA = new Set\(\[\]\);/.test(mid), true);
ok('a prioridade é gravada no Supabase, não servida por /api',
   /await salvarNuvemREST\(CORTE_PRIO_KEY, novo\)/.test(main), true);
ok('e o perfil corte nem calcula (só lê)',
   /async function crtSincronizarPrioridade\(\) \{\s*\r?\n\s*if \(ehPerfilCorte\(\)\) return;/.test(main), true);

console.log('\n7) O volume de vendas usa o parser já testado dos pedidos');
ok('a busca mora no shopify-orders.js (mesmo PRODUCT_MAP da distribuição)',
   /searchParams\.get\('vendas'\)/.test(orders), true);
ok('usa parseLineItemMulti com a quantidade TOTAL (peça enviada continua sendo venda)',
   /parseLineItemMulti\(item, o\.name, naoMapeados, true\)/.test(orders), true);
ok('só pedido pago', /financial_status=paid/.test(orders), true);
ok('cancelado fora', /filter\(o => !o\.cancelled_at\)/.test(orders), true);
ok('janela com teto de 365 dias', /Math\.min\(diasPedidos, 365\)/.test(orders), true);

console.log(`\n${falhas ? '✗' : '✓'} ${total - falhas}/${total} passaram\n`);
process.exit(falhas ? 1 : 0);
