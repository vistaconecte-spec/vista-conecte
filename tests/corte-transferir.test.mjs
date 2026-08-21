/**
 * Teste do "Mandar tudo para o corte" (main.js) — a transferência em massa de todas as
 * levas em "Comprando tecido" para "Em corte".
 *
 * POR QUE ISTO EXISTE: o tecido chega junto, então a etapa vira junta. Antes disso a dona
 * abria modelo por modelo e mexia no dropdown; com dez modelos em compra eram dez telas.
 *
 * O que estes testes travam:
 *   1. a quantidade da leva 1 sem nada digitado (que só existia como conta na Ficha de
 *      Compra) ser CONGELADA em `prod` — sem isso a leva troca de status e some das duas
 *      telas de oficina, que só desenham leva com `prod` salvo;
 *   2. a 2ª leva continuar valendo só o que foi digitado (não tem fallback);
 *   3. leva sem peça nenhuma ficar onde está;
 *   4. o carimbo `status_at`/`status2_at` sair igual ao de confirmarStatus/salvarModelo —
 *      é ele que separa uma rodada da outra no faturamento;
 *   5. o botão não aparecer para a oficina (quem confirma etapa é a dona).
 *
 * Rodar:  node tests/corte-transferir.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz  = join(dirname(fileURLToPath(import.meta.url)), '..');
const main  = readFileSync(join(raiz, 'main.js'), 'utf8');
const index = readFileSync(join(raiz, 'index.html'), 'utf8');

// Extrai funções top-level pelo nome (terminam com "}" na coluna 0)
function extrair(nome) {
  const i = main.indexOf(`function ${nome}(`);
  if (i < 0) throw new Error(`função ${nome} não encontrada em main.js`);
  const fim = main.indexOf('\n}', i);
  return main.slice(i, fim + 2);
}
const nomes = ['levasEmCompraParaCorte', 'necessidadeLeva', 'tamanhosDe', 'coresDoModelo', 'chaveCor'];
const fonte = nomes.map(extrair).join('\n');
const comBanco = (MODELOS, banco) => new Function('MODELOS', 'CONJUNTO_PECAS', 'loadLocal',
  fonte + `; return { ${nomes.join(', ')} };`)(MODELOS, { 'conjunto-boho': ['calca-boho'] }, k => banco[k] || null);

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

const MODELOS = {
  'macacao-amplo':  { nome: 'Macacão Amplo',  cores: ['Preto', 'Militar'], aberto: { Preto: [2, 3, 4, 1, 0], Militar: [0, 0, 2, 0, 0] } },
  'saia-midi':      { nome: 'Saia Midi',      cores: ['Off White'],        aberto: { 'Off White': [1, 1, 1, 1, 1] } },
  'sandalia':       { nome: 'Sandália',       cores: ['Preto'],            aberto: { Preto: [0, 0, 0, 0, 0] } },
  'conjunto-boho':  { nome: 'Conjunto Boho',  cores: ['Preto'],            aberto: { Preto: [5, 5, 5, 5, 5] } },
};

const banco = {
  // Leva 1 SEM quantidade digitada: vale Pedidos − Estoque − 2ª leva (o número da Ficha de Compra)
  'vc:macacao-amplo': { status: 'Comprando tecido', est: { Preto: [0, 1, 0, 0, 0] } },
  // Leva 1 com quantidade digitada + 2ª leva também em compra, com o dela digitado
  'vc:saia-midi': {
    status: 'Comprando tecido',  prod:  { 'Off White': [3, 0, 0, 0, 0] },
    status2: 'Comprando tecido', prod2: { 'Off White': [0, 2, 0, 0, 0] },
  },
  // Em compra, mas sem peça nenhuma para produzir (nada pedido, nada digitado)
  'vc:sandalia': { status: 'Comprando tecido' },
  // Conjunto: não é peça de oficina, mesmo em compra
  'vc:conjunto-boho': { status: 'Comprando tecido' },
};

const { levasEmCompraParaCorte } = comBanco(MODELOS, banco);
const levas = levasEmCompraParaCorte();
const por = (key, n) => levas.find(l => l.key === key && l.leva === n);

console.log('\n1) O que entra na transferência');
ok('três levas: a do Macacão e as DUAS da Saia', levas.length, 3);
ok('leva sem peça nenhuma fica de fora (viraria ficha vazia)', !!por('sandalia', 1), false);
ok('conjunto fica de fora — não é peça de oficina', !!por('conjunto-boho', 1), false);

console.log('\n2) A leva 1 sem nada digitado é CONGELADA com a conta da Ficha de Compra');
const mac = por('macacao-amplo', 1);
ok('Pedidos − Estoque, tamanho a tamanho', mac.prod, { Preto: [2, 2, 4, 1, 0], Militar: [0, 0, 2, 0, 0] });
ok('total da leva', mac.total, 11);
ok('marcada para gravar (era só conta, não estava salva)', mac.congelar, true);

console.log('\n3) O que já estava digitado é respeitado');
ok('leva 1 da Saia usa o digitado', por('saia-midi', 1).prod, { 'Off White': [3, 0, 0, 0, 0] });
ok('e não precisa ser regravada', por('saia-midi', 1).congelar, false);
ok('2ª leva vale só o digitado (não tem fallback)', por('saia-midi', 2).prod, { 'Off White': [0, 2, 0, 0, 0] });
ok('nome da leva vem do modelo', por('saia-midi', 2).nome, 'Saia Midi');

console.log('\n4) A gravação em massa');
const grava = main.slice(main.indexOf('async function mandarTudoParaCorte()'), main.indexOf('function abrirCorte(item)'));
ok('carimba as duas levas ao entrar no corte (é o ref do faturamento)',
   /saved\.status_at = agora/.test(grava) && /saved\.status2_at = agora/.test(grava), true);
ok('só grava prod quando a quantidade foi congelada',
   /if \(l\.congelar\) saved\.prod = /.test(grava) && /if \(l\.congelar\) saved\.prod2 = /.test(grava), true);
ok('e mantém as cores que já estavam lá (merge, não troca)',
   /\.\.\.\(saved\.prod \|\| \{\}\), \.\.\.l\.prod/.test(grava), true);
ok('sobe modelo a modelo pelo caminho normal (fila de gravações pendentes)',
   /await salvarNuvem\(key, saved\)/.test(grava), true);
ok('e fecha o valor da rodada como confirmarStatus faz',
   /crtFatSincronizar\(\)/.test(grava) && /cstFatSincronizar\(\)/.test(grava), true);
ok('pede confirmação antes — é mudança de etapa de tudo de uma vez', /if \(!confirm\(/.test(grava), true);

console.log('\n5) Quem pode mandar');
ok('a função sai fora no perfil de oficina', /if \(ehPerfilOficina\(\)\) return;/.test(grava), true);
ok('e o botão da aba CORTE nem é desenhado para ela',
   /\$\{ehPerfilOficina\(\) \? '' : `<button[^`]*mandarTudoParaCorte\(\)/.test(main), true);
ok('o card COMPRANDO TECIDO do painel também tem o botão',
   /onclick="mandarTudoParaCorte\(\)"/.test(index), true);

console.log(falhas ? `\n✗ ${total - falhas}/${total} passaram` : `\n✓ ${total}/${total} passaram`);
process.exit(falhas ? 1 : 0);
