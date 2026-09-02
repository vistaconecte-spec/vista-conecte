/**
 * Teste do status da leva que "voltava para o corte" (main.js).
 *
 * POR QUE ISTO EXISTE: em 01/09/2026 a dona transferiu modelos para a costura e eles
 * voltaram sozinhos para o corte. Causa: o ciclo de 1 minuto (pedidos da Shopify) redesenhava
 * a tela com `if (!estEditado && !prodEditado && MODELOS[modeloAtual]) renderModelo(...)` —
 * faltavam `prod2Editado` e `cfgEditado`, que o ciclo de 15 segundos já respeitava. O status
 * escolhido no dropdown só existia no DOM até o autoSave de 800ms subir; o redesenho no meio
 * dessa janela devolvia o select ao valor salvo ("Em corte") e o save seguinte gravava esse
 * valor velho na nuvem.
 *
 * Correção em duas pontas: as duas guardas passaram a ser iguais, e o dropdown de status
 * grava na hora (marcarStatusEditado), sem passar pela espera do autoSave.
 *
 * Rodar:  node tests/status-nao-volta.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz  = join(dirname(fileURLToPath(import.meta.url)), '..');
const main  = readFileSync(join(raiz, 'main.js'), 'utf8');
const html  = readFileSync(join(raiz, 'index.html'), 'utf8');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

const pedaco = (ini, fim) => {
  const a = main.indexOf(ini);
  const b = main.indexOf(fim, a);
  if (a < 0 || b < 0) throw new Error('trecho não encontrado: ' + ini);
  return main.slice(a, b);
};

// ── laboratório: salvarModelo REAL, com DOM e nuvem de mentira ────────────────
const fonte = [
  pedaco('function salvarModelo', '// Só as cores FIXAS são gravadas'),
  pedaco('function getCoresTags', 'function buildSidebar'),
].join('\n');

function montar({ salvo, statusDOM, status2DOM, temLeva2DOM = true }) {
  const store = new Map();
  store.set('vc:calca-flare', JSON.stringify(salvo));
  const nuvem = {};

  const el = v => ({ value: v, textContent: '', style: {}, classList: { add() {}, remove() {}, contains: () => false } });
  const campos = {
    'prod-status':     el(statusDOM),
    'prod-prazo':      el(''),
    'prod2-prazo':     el(''),
    'preco-m':         el('19.00'),
    'cfg-nome':        el('Calça Flare Canelada'),
    'cfg-tecido':      el('Canelado'),
    'cfg-consumo':     el('1.4'),
    'cfg-componentes': el(''),
    'cfg-obs':         el(''),
    'model-title':     el(''),
    'model-sub':       el(''),
    'save-ind':        el(''),
    'btn-salvar':      el(''),
  };
  // O bloco da 2ª leva pode nem estar na tela (modelo sem leva 2)
  if (temLeva2DOM) campos['prod2-status'] = el(status2DOM);

  const documento = {
    getElementById: id => campos[id] || null,
    querySelectorAll: () => [],           // tabelas vazias: o teste é sobre o status
  };

  const ctx = {
    document: documento,
    MODELOS: { 'calca-flare': { nome: 'Calça Flare Canelada', cores: ['Preto'] } },
    saveLocal: (k, v) => store.set(k, JSON.stringify(v)),
    loadLocal: k => (store.has(k) ? JSON.parse(store.get(k)) : null),
    salvarNuvem: (k, d) => { nuvem[k] = d; },
    showSaved: () => {}, buildSidebar: () => {}, esconderBtnSalvar: () => {},
  };
  const api = new Function('ctx', `
    const { document, MODELOS, saveLocal, loadLocal, salvarNuvem,
            showSaved, buildSidebar, esconderBtnSalvar } = ctx;
    let modeloAtual = 'calca-flare';
    let estEditado = false, prodEditado = false, prod2Editado = false, cfgEditado = true;
    let saveTimer = null, _ultimoSaveTs = 0;
    ${fonte}
    return { salvarModelo };
  `)(ctx);

  return { api, lido: () => JSON.parse(store.get('vc:calca-flare')), nuvem };
}

const ANTES = {
  leva2: true,
  est:   { Preto: [1, 0, 0, 0, 0] },
  prod:  { Preto: [0, 0, 0, 0, 0] },
  prod2: { Preto: [2, 0, 0, 0, 0] },
  status: '', status_at: null,
  status2: 'Em corte', status2_at: '2026-08-28T11:07:47.679Z',
};

console.log('\n1) O caso da dona: dropdown em "Em costura" é o que vai para a nuvem');
{
  const lab = montar({ salvo: ANTES, statusDOM: '', status2DOM: 'Em costura' });
  lab.api.salvarModelo();
  const d = lab.lido();
  ok('a 2ª leva foi para a costura', d.status2, 'Em costura');
  ok('e a nuvem recebeu o mesmo valor', lab.nuvem['calca-flare'].status2, 'Em costura');
  ok('o carimbo de entrada na etapa é novo', d.status2_at !== ANTES.status2_at, true);
}

console.log('\n2) Status que não mudou preserva o carimbo (é ele que separa uma rodada da outra)');
{
  const lab = montar({ salvo: ANTES, statusDOM: '', status2DOM: 'Em corte' });
  lab.api.salvarModelo();
  ok('continua em corte', lab.lido().status2, 'Em corte');
  ok('com o carimbo original', lab.lido().status2_at, ANTES.status2_at);
}

console.log('\n3) TODO redesenho automático usa a MESMA guarda das 4 flags');
{
  const AS_4 = ['cfgEditado', 'estEditado', 'prod2Editado', 'prodEditado'];
  // Só interessa quem redesenha SOZINHO (timer/realtime). Redesenho depois de um clique dela
  // é o efeito esperado do clique e continua sem guarda.
  const automaticos = {
    'realtime do Supabase':      pedaco('function iniciarRealtime', 'async function sincronizarNuvem'),
    'ciclo de 15s':              pedaco('async function sincronizarNuvem', 'const fmt ='),
    'ciclo de 1 min (Shopify)':  pedaco('// 3. Atualiza pedidos Shopify', '// 3b. Sincroniza estoque'),
    'baixa automática de envio': pedaco('async function _baixaImediataDeProcessados', '\n}\n'),
  };
  for (const [nome, src] of Object.entries(automaticos)) {
    const m = src.match(/(?:else )?if \(([^)]*?)\) renderModelo\(modeloAtual\)/);
    const flags = m ? AS_4.filter(f => m[1].includes('!' + f)).sort() : null;
    ok(`${nome} trava nas 4 flags`, flags, AS_4);
  }
}

console.log('\n4) O dropdown de status grava na hora, sem a espera do autoSave');
{
  ok('status da leva 1 chama marcarStatusEditado',
     /id="prod-status"[^>]*onchange="marcarStatusEditado\(\)"/.test(html), true);
  ok('status da 2ª leva também',
     /id="prod2-status"[^>]*onchange="marcarStatusEditado\(\)"/.test(html), true);
  const fn = pedaco('function marcarStatusEditado', '\n}');
  ok('marcarStatusEditado salva direto', /salvarModelo\(\)/.test(fn), true);
  ok('e não devolve o valor para a fila de 800ms', /autoSave\(\)/.test(fn), false);
  ok('campo de texto continua com autoSave (não salva a cada tecla)',
     /function marcarCfgEditado\(\)\s*\{[^}]*autoSave\(\)/.test(main), true);
}

console.log('\n5) Voltar ao INÍCIO limpa TODAS as flags e não grava fora de um modelo');
{
  const bloco = pedaco('dashItem.onclick', 'modeloAtual = \'__dashboard__\'');
  ok('só salva se a tela aberta for um modelo de verdade', /MODELOS\[modeloAtual\] &&/.test(bloco), true);
  ok('cfgEditado também é zerado', /cfgEditado = false/.test(bloco), true);
}

console.log(falhas === 0 ? `\n✓ ${total}/${total} passaram\n` : `\n✗ ${falhas} de ${total} falharam\n`);
process.exit(falhas === 0 ? 0 : 1);
