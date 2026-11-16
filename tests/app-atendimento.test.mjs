/**
 * App Vi Atendimento (16/11/2026): a tela de conversas (whatsapp.html) instalável no celular da
 * Bárbara e da Marcelly, com senha só do atendimento.
 *
 * O que estes testes travam: o perfil 'atendimento' alcança só as conversas e os casos; não vê
 * pedido, estoque nem financeiro; não aprova dinheiro; a sessão dura 30 dias (as outras 12 h);
 * e a mesma página continua funcionando dentro do painel.
 *
 * Rodar:  node tests/app-atendimento.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(raiz, 'whatsapp.html'), 'utf8');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const sessao = await import(pathToFileURL(join(raiz, 'functions', '_sessao.js')).href);
const mw = await import(pathToFileURL(join(raiz, 'functions', 'api', '_middleware.js')).href);
const login = await import(pathToFileURL(join(raiz, 'functions', 'api', 'login.js')).href);

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  X ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ok ${nome}`);
}

const SEGREDO = 'segredo-de-teste';
const env = { SESSION_SECRET: SEGREDO };
async function chamar(perfil, metodo, caminho, corpo) {
  const token = await sessao.assinarSessao(perfil, SEGREDO);
  const headers = { Cookie: 'vc_sessao=' + token };
  if (corpo) headers['Content-Type'] = 'application/json';
  const request = new Request('https://x' + caminho, { method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined });
  let passou = false;
  const r = await mw.onRequest({ request, env, next: async () => { passou = true; return new Response('{}'); } });
  return passou ? 'passa' : r.status;
}

console.log('\n1) O que a senha do atendimento alcança');
ok('lista e conversa', await chamar('atendimento', 'GET', '/api/whatsapp?acao=conversas'), 'passa');
ok('responder a cliente', await chamar('atendimento', 'POST', '/api/whatsapp', { acao: 'enviar', tel: '1', texto: 'oi' }), 'passa');
ok('abrir caso e assistente', await chamar('atendimento', 'POST', '/api/casos', { acao: 'ferramenta', nome: 'abrir_caso', input: {} }), 'passa');
ok('pedir aprovação de dinheiro', await chamar('atendimento', 'POST', '/api/casos', { acao: 'executar', tipo: 'pedir_aprovacao' }), 'passa');
ok('aprovar dinheiro é só da dona', await chamar('atendimento', 'POST', '/api/casos', { acao: 'decidir', id: 'x', decisao: 'aprovado' }), 403);
ok('a dona continua aprovando', await chamar('dona', 'POST', '/api/casos', { acao: 'decidir', id: 'x', decisao: 'aprovado' }), 'passa');
ok('pedidos da Shopify fora', await chamar('atendimento', 'GET', '/api/shopify-orders?parte=abertos'), 403);
ok('financeiro fora', await chamar('atendimento', 'GET', '/api/mp-movimentos'), 403);
ok('estoque fora', await chamar('atendimento', 'GET', '/api/modelos'), 403);

console.log('\n2) Sessão de 30 dias no app, 12 h no resto');
ok('horas por perfil', [sessao.horasDoPerfil('atendimento'), sessao.horasDoPerfil('dona'), sessao.horasDoPerfil('corte')], [720, 12, 12]);
const tok = await sessao.assinarSessao('atendimento', SEGREDO);
const lido = await sessao.lerSessao(new Request('https://x/', { headers: { Cookie: 'vc_sessao=' + tok } }), SEGREDO);
ok('token do atendimento vale ~30 dias', Math.round((lido.exp - Date.now()) / 86400e3), 30);
const hash = '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8'; // sha256('password')
const rl = await login.onRequestPost({ request: new Request('https://x/api/login', { method: 'POST', body: JSON.stringify({ senha: 'password' }) }),
  env: { SESSION_SECRET: SEGREDO, SENHA_DONA_HASH: 'outra', SENHA_ATENDIMENTO_HASH: hash } });
ok('senha do atendimento entra como atendimento', (await rl.json()).perfil, 'atendimento');
ok('cookie do app com 30 dias', /Max-Age=2592000/.test(rl.headers.get('Set-Cookie') || ''), true);

console.log('\n3) A página vira app fora do painel e continua igual dentro dele');
ok('manifesto e ícones', html.includes('rel="manifest" href="/atendimento.webmanifest"') && html.includes('apple-touch-icon'), true);
const man = JSON.parse(readFileSync(join(raiz, 'atendimento.webmanifest'), 'utf8'));
ok('manifesto abre direto nas conversas', [man.start_url, man.display, man.short_name], ['/whatsapp?app=1', 'standalone', 'Atendimento']);
ok('ícones existem', man.icons.every(i => existsSync(join(raiz, i.src.slice(1)))), true);
ok('modo app só fora do iframe', /const MODO_APP = !new URLSearchParams\(location\.search\)\.has\('embed'\) && window\.top === window/.test(html), true);
ok('sem sessão: tela de senha no app, aviso do painel no iframe', (html.match(/throw semSessao\(\)/g) || []).length === 3 && html.includes("if (MODO_APP) { mostrarLogin();"), true);
ok('atualização automática não apaga a senha sendo digitada', html.includes("if (!$('login').hidden) return;"), true);
ok('painel manda o perfil do atendimento para o app', main.includes("if (perfil === 'atendimento') { location.replace('/whatsapp?app=1'); return; }"), true);
ok('página do app nunca vem do cache', /\/whatsapp\s+Cache-Control: no-store/.test(readFileSync(join(raiz, '_headers'), 'utf8')), true);

console.log(`\n${total - falhas}/${total} passaram`);
if (falhas) process.exit(1);
