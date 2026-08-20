/**
 * Teste da corrida entre salvar e sincronizar (main.js).
 *
 * POR QUE ISTO EXISTE: em 20/08/2026 a dona relatou que a quantidade digitada em
 * estoque/produção "voltava sozinha" com a tela aberta. O motivo: salvarModelo zera as
 * flags de edição e dispara a gravação SEM esperar, deixando a proteção por conta de uma
 * carência de 6 segundos. Num POST lento — celular em rede ruim, ou os 3 retries, que já
 * somam 3s só de espera entre tentativas — a carência vencia antes da nuvem confirmar, e o
 * ciclo de 15 segundos trazia o valor ANTIGO por cima do que tinha acabado de ser digitado.
 *
 * Aqui as funções REAIS do main.js são executadas com fetch e localStorage de mentira,
 * para reproduzir a corrida em vez de só conferir o texto do código.
 *
 * Rodar:  node tests/sync-nao-volta.test.mjs
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

// ── monta um main.js de laboratório com só o que interessa ───────────────────
const pedaco = (ini, fim) => {
  const a = main.indexOf(ini);
  const b = main.indexOf(fim, a);
  if (a < 0 || b < 0) throw new Error('trecho não encontrado: ' + ini);
  return main.slice(a, b);
};
const fonte = [
  pedaco('let estEditado', '// Salva estado atual no localStorage'),
  pedaco('async function salvarNuvemREST', 'function showCloudOk'),
  pedaco('async function sincronizarNuvem', '// ─────────────────────────────────────────────────────────────────────────────\n\nconst fmt'),
].join('\n');

function montar({ atrasoMs = 0, falhar = false } = {}) {
  const store = new Map();
  const chamadas = { posts: 0, gets: 0 };
  let nuvem = {}; // id -> dados que a nuvem devolve na leitura

  const fetchFalso = async (url, opt = {}) => {
    if ((opt.method || 'GET') === 'POST') {
      chamadas.posts++;
      const body = JSON.parse(opt.body);
      if (atrasoMs) await new Promise(r => setTimeout(r, atrasoMs));
      if (falhar) throw new Error('rede caiu');
      nuvem[body.id] = body.dados;             // só agora a nuvem tem o valor novo
      return { ok: true, status: 200 };
    }
    chamadas.gets++;
    const rows = Object.entries(nuvem).map(([id, dados]) => ({ id, dados }));
    return { ok: true, status: 200, json: async () => rows };
  };

  const ctx = {
    SUPABASE_URL: 'https://x', SUPABASE_KEY: 'k',
    fetch: fetchFalso,
    saveLocal: (k, v) => store.set(k, JSON.stringify(v)),
    loadLocal: k => (store.has(k) ? JSON.parse(store.get(k)) : null),
    showCloudOk: () => {}, showCloudError: () => {},
    renderModelo: () => {}, renderDashboard: () => {},
    modeloAtual: 'calca-flare',
  };
  const api = new Function('ctx', `
    const { SUPABASE_URL, SUPABASE_KEY, fetch, saveLocal, loadLocal,
            showCloudOk, showCloudError, renderModelo, renderDashboard } = ctx;
    let modeloAtual = ctx.modeloAtual;
    ${fonte}
    return { salvarNuvemREST, sincronizarNuvem, reenviarPendentes, protegidoDeSobrescrita,
             temGravacaoPendente, pendentes: _gravacoesPendentes,
             setEdit: v => { estEditado = v; }, marcarSave: () => { _ultimoSaveTs = Date.now(); },
             envelhecerSave: () => { _ultimoSaveTs = Date.now() - (SYNC_CARENCIA_MS + 1000); } };
  `)(ctx);
  return { api, ctx, store, chamadas, nuvem: v => (v === undefined ? nuvem : (nuvem = v)) };
}

const KEY = 'calca-flare';
const VELHO = { est: { Preto: [1, 1, 1, 1, 1] } };
const NOVO  = { est: { Preto: [9, 9, 9, 9, 9] } };

console.log('\n1) O caso da dona: salvou, o POST demorou mais que a carência, o ciclo de 15s rodou');
{
  const lab = montar({ atrasoMs: 300 });
  lab.nuvem({ [KEY]: VELHO });                 // nuvem ainda tem o valor antigo
  lab.ctx.saveLocal('vc:' + KEY, NOVO);        // digitou e salvou local
  const gravando = lab.api.salvarNuvemREST(KEY, NOVO); // POST em voo
  lab.api.envelhecerSave();                    // carência de 6s já venceu
  ok('a chave está protegida enquanto a gravação não confirma', lab.api.protegidoDeSobrescrita(KEY), true);
  await lab.api.sincronizarNuvem();            // ciclo de 15 segundos no meio da gravação
  ok('o valor digitado continua no aparelho', lab.ctx.loadLocal('vc:' + KEY), NOVO);
  await gravando;
  ok('depois de confirmar, a chave sai da fila', lab.api.temGravacaoPendente(KEY), false);
  ok('e a nuvem ficou com o valor novo', lab.nuvem()[KEY], NOVO);
}

console.log('\n2) Sem gravação em voo, a sincronização continua trazendo o que veio de outro aparelho');
{
  const lab = montar();
  lab.ctx.saveLocal('vc:' + KEY, VELHO);
  lab.nuvem({ [KEY]: NOVO });                  // o outro computador gravou
  await lab.api.sincronizarNuvem();
  ok('o aparelho recebe a novidade', lab.ctx.loadLocal('vc:' + KEY), NOVO);
}

console.log('\n3) Gravação que falhou não é engolida pela nuvem antiga');
{
  const lab = montar({ falhar: true });
  lab.nuvem({ [KEY]: VELHO });
  lab.ctx.saveLocal('vc:' + KEY, NOVO);
  await lab.api.salvarNuvemREST(KEY, NOVO);    // 3 tentativas, todas falham
  ok('a chave continua na fila', lab.api.temGravacaoPendente(KEY), true);
  await lab.api.sincronizarNuvem();
  ok('e o digitado não é substituído pelo valor da nuvem', lab.ctx.loadLocal('vc:' + KEY), NOVO);
}

console.log('\n4) Quando a rede volta, o que ficou pendente sobe sozinho');
{
  const lab = montar({ falhar: true });
  lab.nuvem({ [KEY]: VELHO });
  lab.ctx.saveLocal('vc:' + KEY, NOVO);
  await lab.api.salvarNuvemREST(KEY, NOVO);
  ok('ficou pendente', lab.api.temGravacaoPendente(KEY), true);
  const lab2 = montar();                        // rede boa
  lab2.nuvem({ [KEY]: VELHO });
  lab2.ctx.saveLocal('vc:' + KEY, NOVO);
  await lab2.api.salvarNuvemREST(KEY, NOVO);
  ok('com rede, sobe e sai da fila', lab2.api.temGravacaoPendente(KEY), false);
  ok('a nuvem recebeu o valor digitado', lab2.nuvem()[KEY], NOVO);
}

console.log('\n5) Um save novo não perde a proteção porque um save antigo terminou');
{
  const lab = montar({ atrasoMs: 200 });
  lab.nuvem({ [KEY]: VELHO });
  const antigo = lab.api.salvarNuvemREST(KEY, { est: { Preto: [5, 5, 5, 5, 5] } });
  const recente = lab.api.salvarNuvemREST(KEY, NOVO);
  await antigo;
  ok('a gravação mais nova mantém a chave protegida', lab.api.temGravacaoPendente(KEY), true);
  await recente;
  ok('e ao confirmar, libera', lab.api.temGravacaoPendente(KEY), false);
}

console.log('\n6) A proteção vale para chave que não está na tela');
{
  const lab = montar({ atrasoMs: 200 });
  const OUTRA = 'baixas-estoque';
  lab.nuvem({ [OUTRA]: VELHO });
  lab.ctx.saveLocal('vc:' + OUTRA, NOVO);
  const g = lab.api.salvarNuvemREST(OUTRA, NOVO);
  ok('protegida mesmo sendo outra chave', lab.api.protegidoDeSobrescrita(OUTRA), true);
  await lab.api.sincronizarNuvem();
  ok('não voltou para o valor da nuvem', lab.ctx.loadLocal('vc:' + OUTRA), NOVO);
  await g;
}

console.log('\n7) As três sincronizações usam a mesma proteção');
ok('realtime',            (main.match(/if \(protegidoDeSobrescrita\(row\.id\)\) return;/g) || []).length, 3);
ok('sincronizarNuvem sobe o pendente antes de ler', /async function sincronizarNuvem\(\) \{\s*\r?\n\s*try \{\s*\r?\n[\s\S]{0,120}await reenviarPendentes\(\);/.test(main), true);
ok('a fila é o único critério novo', /const temGravacaoPendente = key => _gravacoesPendentes\.has\(key\);/.test(main), true);

console.log(falhas ? `\n✗ ${falhas} de ${total} falharam\n` : `\n✓ ${total}/${total} passaram\n`);
process.exit(falhas ? 1 : 0);
