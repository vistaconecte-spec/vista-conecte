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

console.log('\n4) Etapa 2: pedido ao lado da conversa');
const cli = await import(pathToFileURL(join(raiz, 'functions', '_cliente.js')).href);
ok('busca a cliente pelas duas grafias do celular', cli.buscaPorTelefone('5562993161442'), 'phone:+556293161442 OR phone:+5562993161442');
const agora = Date.parse('2026-11-16T15:00:00Z');
const pedido = (name, criado, fin, ful, extra = {}) => ({ name, createdAt: criado, processedAt: criado, cancelledAt: null, displayFinancialStatus: fin,
  displayFulfillmentStatus: ful, tags: [], totalPriceSet: { shopMoney: { amount: '186.12' } }, lineItems: { nodes: [{ quantity: 1, title: 'Vestido', variantTitle: 'Preto / M' }] }, fulfillments: [], ...extra });
const contas = [
  { orders: { nodes: [pedido('#9525', '2026-11-05T12:00:00Z', 'PAID', 'UNFULFILLED'), pedido('#9001', '2026-10-01T12:00:00Z', 'PAID', 'UNFULFILLED')] } },
  { orders: { nodes: [pedido('#9374', '2026-10-19T12:00:00Z', 'PAID', 'FULFILLED', { tags: ['troca-de-9100'],
    fulfillments: [{ createdAt: '2026-11-03T12:00:00Z', trackingInfo: [{ number: 'AP690836759BR', company: 'Correios', url: 'https://rastreio/x' }] }] }),
    pedido('#9525', '2026-11-05T12:00:00Z', 'PAID', 'UNFULFILLED')] } },
];
const lista = cli.resumirPedidos(contas, agora);
ok('junta as contas, sem repetir, mais novo primeiro', lista.map(p => p.numero), ['#9525', '#9374', '#9001']);
ok('não enviado mostra os dias úteis de 10', [lista[0].envio, lista[0].prazo], ['não enviado', { dias_uteis: 7, de: 10, atrasado: false }]);
ok('atrasado marcado', lista[2].prazo.atrasado, true);
ok('enviado mostra rastreio, prazo de saída e troca', [lista[1].envio, lista[1].rastreio[0].codigo, lista[1].prazo.no_prazo, lista[1].troca], ['enviado', 'AP690836759BR', true, true]);
ok('pagamento e itens em português', [lista[0].pagamento, lista[0].itens[0], lista[0].data], ['pago', '1x Vestido (Preto / M)', '05/11/2026']);
ok('no máximo 6 pedidos', cli.resumirPedidos([{ orders: { nodes: Array.from({ length: 9 }, (_, i) => pedido('#' + (9000 + i), `2026-11-0${i + 1}T12:00:00Z`, 'PAID', 'FULFILLED')) } }], agora).length, 6);
const apiW = readFileSync(join(raiz, 'functions', 'api', 'whatsapp.js'), 'utf8');
ok('rota ?acao=cliente na API das conversas (o perfil do atendimento alcança)', apiW.includes("if (acao === 'cliente')") && await chamar('atendimento', 'GET', '/api/whatsapp?acao=cliente&tel=5562993161442') === 'passa', true);
ok('botão Pedido no topo da conversa', html.includes('data-acao="pedido"') && html.includes("b.dataset.acao === 'pedido' ? abrirPedido()"), true);
ok('trocar de conversa fecha o painel', /abrirPedido\(\) : mudarVi\(b\.dataset\.acao\)\); \}\);\n  fecharPedido\(\);/.test(html), true);
ok('resposta de outra conversa não entra no painel', html.includes('if (!est.aberta || est.aberta.chave !== c.chave) return;'), true);

console.log(`\n${total - falhas}/${total} passaram`);
if (falhas) process.exit(1);
