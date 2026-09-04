/**
 * Teste da sessão vencida com a tela aberta (main.js + functions/api/_middleware.js).
 *
 * POR QUE ISTO EXISTE: em 04/09/2026 a dona relatou "no celular as informações estão todas
 * diferentes". O cookie de sessão dura 12h e a aba do celular fica aberta muito mais que
 * isso. Quando a sessão vencia, /api/shopify-orders passava a responder 401 e o código
 * fazia `if (!res.ok) return;` — calado. Os pedidos CONGELAVAM na última leitura boa,
 * enquanto o estoque continuava sincronizando pelo Supabase (que não usa sessão). A tela
 * ficava metade de hoje, metade de ontem, sem nada avisando — e "Recalcular" gravava a
 * produção em cima dos pedidos velhos, levando o erro para o computador pela nuvem.
 *
 * Rodar:  node tests/sessao-vencida.test.mjs
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

// ── laboratório: as funções REAIS do main.js com DOM e rede de mentira ───────
const pedaco = (ini, fim) => {
  const a = main.indexOf(ini);
  const b = main.indexOf(fim, a);
  if (a < 0 || b < 0) throw new Error('trecho não encontrado: ' + ini);
  return main.slice(a, b);
};
const fonte = pedaco('async function carregarPedidosShopify', '// Trava antes de gravar produção');

// DOM mínimo: o que interessa é QUAIS faixas existem depois de cada resposta.
function domFalso() {
  const nodes = new Map();
  const novo = () => {
    const el = {
      id: '', style: { cssText: '', paddingTop: '' }, innerHTML: '', offsetHeight: 40,
      onclick: null, appendChild(){}, insertBefore(){},
      remove() { nodes.delete(el.id); },
    };
    return el;
  };
  const body = novo();
  return {
    nodes,
    doc: {
      body,
      getElementById: id => nodes.get(id) || null,
      querySelector: () => body,
      createElement: () => novo(),
      registrar(el) { nodes.set(el.id, el); },
    },
  };
}

function montar({ status = 200, derrubarRede = false } = {}) {
  const { nodes, doc } = domFalso();
  // insertBefore é o ponto em que a faixa entra na página de verdade — é aí que ela
  // passa a existir para o getElementById.
  doc.body.insertBefore = el => doc.registrar(el);
  doc.body.appendChild  = el => doc.registrar(el);

  const MODELOS = {
    'saia': { nome: 'Saia', cores: ['Preto'], aberto: { 'Preto': [0, 0, 3, 0, 0] } },
  };
  const ctx = {
    document: doc,
    window: {},
    fetch: async () => {
      if (derrubarRede) throw new Error('rede caiu');
      if (status !== 200) return { ok: false, status };
      return { ok: true, status: 200, json: async () => ({ pedidos: { saia: { 'Preto': [0, 0, 1, 0, 0] } } }) };
    },
    MODELOS,
    CONJUNTO_PECAS: {},
    corCanonica: (_m, c) => c,
    tamanhosDe: () => ['PP', 'P', 'M', 'G', 'GG'],
    verificarLeituraPedidos: () => {},
    ehPerfilDeUmaAba: () => false,
    estEditado: false, prodEditado: false, cfgEditado: false,
    modeloAtual: 'saia',
    salvarModelo: () => {},
    location: { reload: () => {} },
    console,
    Date,
  };
  const fn = new Function(...Object.keys(ctx), fonte + `
    return { carregarPedidosShopify, leituraDePedidosFresca,
             temFaixaSessao: () => !!document.getElementById('faixa-sessao'),
             temFaixaPedidos: () => !!document.getElementById('faixa-pedidos') };`);
  return { api: fn(...Object.values(ctx)), MODELOS, nodes };
}

console.log('\n1) Sessão vencida (401): avisa e NÃO finge que está atualizado');
{
  const { api, MODELOS } = montar({ status: 401 });
  await api.carregarPedidosShopify();
  ok('faixa vermelha de sessão aparece', api.temFaixaSessao(), true);
  ok('pedidos antigos não são apagados da tela', MODELOS.saia.aberto['Preto'], [0, 0, 3, 0, 0]);
  ok('leitura é considerada NÃO confiável', api.leituraDePedidosFresca(), false);
}

console.log('\n2) Perfil sem acesso (403) cai no mesmo aviso');
{
  const { api } = montar({ status: 403 });
  await api.carregarPedidosShopify();
  ok('faixa de sessão aparece', api.temFaixaSessao(), true);
}

console.log('\n3) Servidor com erro (500): faixa de pedidos desatualizados');
{
  const { api } = montar({ status: 500 });
  await api.carregarPedidosShopify();
  ok('avisa que os pedidos não atualizaram', api.temFaixaPedidos(), true);
  ok('não confunde com sessão vencida', api.temFaixaSessao(), false);
  ok('leitura não é confiável', api.leituraDePedidosFresca(), false);
}

console.log('\n4) Rede caiu no meio (4G do celular)');
{
  const { api } = montar({ derrubarRede: true });
  await api.carregarPedidosShopify();
  ok('avisa em vez de engolir o erro', api.temFaixaPedidos(), true);
}

console.log('\n5) Leitura boa: sem faixa e leitura confiável');
{
  const { api, MODELOS } = montar({ status: 200 });
  await api.carregarPedidosShopify();
  ok('pedidos atualizados', MODELOS.saia.aberto['Preto'], [0, 0, 1, 0, 0]);
  ok('nenhuma faixa de erro', [api.temFaixaSessao(), api.temFaixaPedidos()], [false, false]);
  ok('leitura confiável', api.leituraDePedidosFresca(), true);
}

// ── middleware: sessão deslizante ────────────────────────────────────────────
console.log('\n6) Middleware renova o cookie de quem está usando o app');
{
  const { onRequest } = await import('../functions/api/_middleware.js');
  const { assinarSessao } = await import('../functions/_sessao.js');
  const env = { SESSION_SECRET: 'segredo-de-teste' };

  const chamar = async (token, pathname = '/api/shopify-orders') => {
    const req = new Request('https://x.dev' + pathname, {
      headers: token ? { Cookie: 'vc_sessao=' + token } : {},
    });
    return onRequest({ request: req, env, next: async () => new Response('{}', { status: 200 }) });
  };
  const cookieDe = r => (r.headers.get('Set-Cookie') || '');

  const quaseVencendo = await assinarSessao('dona', env.SESSION_SECRET, 1);   // falta 1h
  const r1 = await chamar(quaseVencendo);
  ok('deixa passar', r1.status, 200);
  ok('manda cookie novo quando está perto de vencer', cookieDe(r1).includes('vc_sessao='), true);
  ok('cookie renovado continua HttpOnly/Secure', /HttpOnly/.test(cookieDe(r1)) && /Secure/.test(cookieDe(r1)), true);
  ok('resposta com cookie nunca vai para cache', r1.headers.get('Cache-Control'), 'no-store');

  const novinha = await assinarSessao('dona', env.SESSION_SECRET, 12);        // falta 12h
  const r2 = await chamar(novinha);
  ok('sessão recém-criada não é renovada à toa', cookieDe(r2), '');

  const vencida = await assinarSessao('dona', env.SESSION_SECRET, -1);        // venceu 1h atrás
  const r3 = await chamar(vencida);
  ok('sessão vencida continua sendo 401', r3.status, 401);
  ok('401 não ganha cookie novo', cookieDe(r3), '');

  const oficina = await assinarSessao('corte', env.SESSION_SECRET, 1);
  const r4 = await chamar(oficina, '/api/shopify-orders');
  ok('perfil de oficina continua barrado no que não é dele', r4.status, 403);
  const r5 = await chamar(oficina, '/api/molde');
  ok('e a rota liberada dele passa e renova', [r5.status, cookieDe(r5).includes('vc_sessao=')], [200, true]);
}

console.log(falhas === 0 ? `\n✓ ${total}/${total} passaram\n` : `\n✗ ${falhas} de ${total} falharam\n`);
process.exit(falhas === 0 ? 0 : 1);
