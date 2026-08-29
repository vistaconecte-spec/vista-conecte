/**
 * Teste do "Excluir modelo" da aba MODELAGEM
 * (functions/api/modelagem-projeto.js + main.js + index.html).
 *
 * POR QUE ISTO EXISTE: o schema `modelagem` do Supabase veio do app antigo SEM foreign key
 * nenhuma. Nada no banco faz cascata: apagar só a linha de `projects` deixaria croquis,
 * arquivos da Audaces, pagamentos, medidas e histórico órfãos — invisíveis na tela e
 * impossíveis de alcançar de novo — e os objetos pendurados no Storage. Quem faz a cascata
 * é o código deste endpoint, então é ele que precisa de guarda: se alguém criar uma tabela
 * nova com `projectId` e esquecer de somar na lista, o teste quebra aqui e não em produção.
 *
 * Os outros dois pontos frágeis também estão cobertos:
 *  - `in.()` vazio é ERRO DE SINTAXE no PostgREST — modelo sem alteração/modelagem interna
 *    não pode montar esse filtro;
 *  - `id` entra direto na URL de um DELETE: se não for número, pode virar outro filtro
 *    (`neq.0`) e varrer a tabela inteira.
 *
 * O endpoint roda de verdade aqui, com `fetch` de mentira, para conferir as chamadas que
 * ele faz ao Supabase — não o texto do código.
 *
 * Rodar:  node tests/modelagem-excluir.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const html = readFileSync(join(raiz, 'index.html'), 'utf8');
const apiSrc = readFileSync(join(raiz, 'functions/api/modelagem-projeto.js'), 'utf8');

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

// Importa como data: URL porque o arquivo é ESM dentro de um package.json sem
// "type":"module" — importar pelo caminho funciona, mas cospe um aviso do Node em toda rodada.
const { onRequest } = await import(
  'data:text/javascript;base64,' + Buffer.from(apiSrc, 'utf8').toString('base64')
);

// ── Supabase de mentira ──────────────────────────────────────────────────────
// Um modelo com filho em TODA tabela que pendura em `projects`, direta ou indiretamente.
const PID = 7;
const RESPOSTAS = {
  [`projects?id=eq.${PID}&select=id,title`]: [{ id: PID, title: 'Calça Flare' }],
  [`project_croquis?projectId=eq.${PID}&select=fileKey`]: [{ fileKey: 'croqui-a.jpg' }, { fileKey: 'croqui-b.jpg' }],
  [`project_files?projectId=eq.${PID}&select=fileKey`]: [{ fileKey: 'foto-c.jpg' }, { fileKey: 'molde-d.adsx' }],
  [`project_changes?projectId=eq.${PID}&select=id`]: [{ id: 11 }, { id: 12 }],
  [`modelagens?projectId=eq.${PID}&select=id`]: [{ id: 21 }],
  'project_change_medias?changeId=in.(11,12)&select=fileKey': [{ fileKey: 'media-e.png' }],
  'modelagem_alteracoes?modelagemId=in.(21)&select=id': [{ id: 31 }],
  'modelagem_files?modelagemId=in.(21)&select=fileKey': [{ fileKey: 'arquivo-f.pdf' }],
  'modelagem_alteracao_medias?alteracaoId=in.(31)&select=fileKey': [{ fileKey: 'media-g.png' }],
};

const SB = 'https://hckzsblwyabmhzbjdjgx.supabase.co';

function montarFetch({ respostas = RESPOSTAS } = {}) {
  const reg = { gets: [], deletes: [], storage: [] };
  globalThis.fetch = async (url, opt = {}) => {
    const metodo = (opt.method || 'GET').toUpperCase();
    const u = String(url);
    if (u.startsWith(`${SB}/storage/`)) {
      reg.storage.push({ metodo, url: u, body: opt.body ? JSON.parse(opt.body) : null });
      return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
    }
    const q = u.replace(`${SB}/rest/v1/`, '');
    if (metodo === 'DELETE') {
      reg.deletes.push(q);
      return { ok: true, status: 204, text: async () => '', json: async () => [] };
    }
    reg.gets.push(q);
    const linhas = respostas[q] || [];
    return { ok: true, status: 200, text: async () => JSON.stringify(linhas), json: async () => linhas };
  };
  return reg;
}

const env = { SUPABASE_SERVICE_ROLE_KEY: 'chave-de-mentira' };
const excluir = body => onRequest({
  env,
  request: new Request('https://vistaconecte.pages.dev/api/modelagem-projeto', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
});
const tabela = q => q.split('?')[0];

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n1) A cascata alcança TODA tabela que pendura no modelo');

let reg = montarFetch();
let res = await excluir({ id: PID, acao: 'projeto-excluir' });
let json = await res.json();
ok('respondeu 200', res.status, 200);
ok('devolve o nome do que foi excluído', json.excluido, 'Calça Flare');

// Lista tirada do próprio schema `modelagem` do Supabase (colunas `projectId`, `changeId`,
// `modelagemId` e `alteracaoId`). Tabela nova pendurada no modelo entra AQUI e no endpoint.
const ESPERADAS = [
  'modelagem_alteracao_medias',
  'modelagem_alteracoes',
  'modelagem_files',
  'modelagem_infos',
  'modelagens',
  'project_change_medias',
  'project_changes',
  'project_croquis',
  'project_fabric_consumption',
  'project_files',
  'project_messages',
  'project_payments',
  'project_pendencias',
  'project_status_history',
  'project_tech_info',
  'projects',
];
const apagadas = [...new Set(reg.deletes.map(tabela))].sort();
ok('nenhuma tabela ficou de fora', ESPERADAS.filter(t => !apagadas.includes(t)), []);
ok('não apagou tabela que não é do modelo', apagadas.filter(t => !ESPERADAS.includes(t)), []);
ok('`projects` é a ÚLTIMA (se falhar no meio, o modelo continua na lista para tentar de novo)',
  tabela(reg.deletes[reg.deletes.length - 1]), 'projects');
ok('a mídia da alteração sai antes da alteração',
  reg.deletes.findIndex(q => tabela(q) === 'project_change_medias') < reg.deletes.findIndex(q => tabela(q) === 'project_changes'), true);

console.log('\n2) Os arquivos saem do Storage — em uma requisição só');
// um DELETE por arquivo estoura o limite de ~50 subrequisições por invocação do plano
// gratuito da Cloudflare num modelo com muita foto
ok('uma única chamada ao Storage', reg.storage.length, 1);
ok('e é um DELETE', reg.storage[0].metodo, 'DELETE');
ok('leva todos os arquivos, dos croquis às mídias das alterações',
  (reg.storage[0].body.prefixes || []).slice().sort(),
  ['arquivo-f.pdf', 'croqui-a.jpg', 'croqui-b.jpg', 'foto-c.jpg', 'media-e.png', 'media-g.png', 'molde-d.adsx']);

console.log('\n3) Modelo vazio não monta `in.()` (erro de sintaxe no PostgREST)');
reg = montarFetch({ respostas: { [`projects?id=eq.${PID}&select=id,title`]: [{ id: PID, title: 'Modelo Novo' }] } });
res = await excluir({ id: PID, acao: 'projeto-excluir' });
ok('respondeu 200', res.status, 200);
ok('nenhum filtro `in.()` vazio', [...reg.gets, ...reg.deletes].filter(q => q.includes('in.()')), []);
ok('sem arquivo, não chama o Storage à toa', reg.storage.length, 0);
ok('`projects` continua sendo a última', tabela(reg.deletes[reg.deletes.length - 1]), 'projects');

console.log('\n4) O id não pode virar filtro — DELETE com id torto não apaga nada');
for (const idTorto of ['neq.0', '0', '-1', 'all', '1;drop', 1.5, '']) {
  reg = montarFetch();
  res = await excluir({ id: idTorto, acao: 'projeto-excluir' });
  ok(`id ${JSON.stringify(idTorto)}: recusado sem apagar nada`,
    { status: res.status, deletes: reg.deletes.length }, { status: 400, deletes: 0 });
}

console.log('\n5) Modelo que não existe não apaga nada');
reg = montarFetch({ respostas: {} });
res = await excluir({ id: PID, acao: 'projeto-excluir' });
ok('404', res.status, 404);
ok('nenhum DELETE disparado', reg.deletes.length, 0);

console.log('\n6) O botão está na tela e pede confirmação de verdade');
ok('botão no cabeçalho do detalhe', /onclick="mdlExcluirModelo\(\)"/.test(html), true);
ok('a função existe', main.includes('async function mdlExcluirModelo()'), true);
const fn = main.slice(main.indexOf('async function mdlExcluirModelo()'), main.indexOf("alert('Erro ao excluir modelo: '"));
ok('confirm() antes de qualquer coisa', fn.includes('if (!confirm('), true);
// confirm() sozinho vira "OK" no automático, e aqui o clique errado perde o croqui e o
// .adsx da modelista, que não existem em nenhum outro lugar
ok('e ainda exige digitar o nome do modelo', fn.includes('prompt(') && fn.includes('!== titulo.trim().toLowerCase()'), true);
ok('cancelar o prompt não exclui', fn.includes('if (digitado === null) return;'), true);
ok('só chama a API depois de conferir o nome',
  fn.indexOf('!== titulo.trim().toLowerCase()') < fn.indexOf("acao: 'projeto-excluir'"), true);
// o acerto com a modelista é guardado por id FORA do banco da modelagem (`modelagem-pagos`)
ok('limpa o pagamento do modelo excluído', fn.includes("saveLocal('vc:' + MDL_PAGOS_KEY"), true);
ok('recarrega a lista depois de excluir', fn.includes('await mdlCarregarLista()'), true);

// regra do CLAUDE.md: mudança em main.js sem bump do ?v= é versão velha servida pelo cache
const vMain = (html.match(/main\.js\?v=(\d+)/) || [])[1];
ok('cache-bust do main.js com data de hoje ou depois', Number(vMain) >= 2026082904, true);

console.log(`\n${falhas ? '✗' : '✓'} ${total - falhas}/${total} asserções passaram`);
process.exit(falhas ? 1 : 0);
