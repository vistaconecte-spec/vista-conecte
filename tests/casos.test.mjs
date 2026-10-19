/**
 * Testes da aba CASOS (assistente da Marcelly, 19/10/2026).
 *
 * POR QUE ISTO EXISTE: em 19/10/2026 havia casos fechados como "resolvido" sem a ação ter
 * acontecido (652, 654/680, 531, 621). A aba nova só deixa fechar com ação registrada, segura
 * dinheiro para a Bárbara, barra texto fora do tom da loja e, no primeiro dia, não grava nada.
 *
 * Rodar:  node tests/casos.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(raiz, 'main.js'), 'utf8');
const html = readFileSync(join(raiz, 'index.html'), 'utf8');
const mid = readFileSync(join(raiz, 'functions', 'api', '_middleware.js'), 'utf8');
const C = await import(pathToFileURL(join(raiz, 'functions', '_casos.js')).href);
const api = await import(pathToFileURL(join(raiz, 'functions', 'api', 'casos.js')).href);

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  X ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ok ${nome}`);
}

console.log('\n1) Tom da mensagem à cliente');
ok('texto limpo passa', C.problemasDoTexto('Oi Ana, seu pedido sai amanhã com prioridade, te mando o rastreio assim que gerar'), []);
ok('travessão', C.problemasDoTexto('Oi — tudo bem').includes('tem travessão'), true);
ok('hífen solto vira travessão', C.problemasDoTexto('Oi - tudo bem').includes('tem travessão'), true);
ok('palavra com hífen não é travessão', C.problemasDoTexto('Oi, segue o guarda-roupa novo'), []);
ok('dois-pontos', C.problemasDoTexto('Seu pedido: 9186').includes('tem dois-pontos'), true);
ok('link não conta como dois-pontos', C.problemasDoTexto('Segue o link https://vistaconecte.com.br/x'), []);
ok('cancelar', C.problemasDoTexto('Se quiser podemos cancelar').includes('usa a palavra cancelar'), true);
ok('desculpas', C.problemasDoTexto('Pedimos desculpas pela demora').includes('pede desculpas'), true);
ok('etapa da produção', C.problemasDoTexto('Sua peça está na costura').includes('conta etapa da produção'), true);
ok('frase de robô', C.problemasDoTexto('Boa notícia, chegou').includes('frase de robô'), true);
ok('vazio', C.problemasDoTexto('  '), ['texto vazio']);
ok('promete estorno', C.prometeDinheiro('Vou fazer o estorno hoje'), true);
ok('promete frete grátis', C.prometeDinheiro('a troca vai com frete grátis'), true);
ok('não promete dinheiro', C.prometeDinheiro('Seu pedido saiu hoje'), false);

console.log('\n2) Janela de 24h e cliente sem resposta');
const agora = Date.parse('2026-10-19T15:00:00Z');
const h = n => new Date(agora - n * 3600e3).toISOString();
ok('janela aberta', C.janelaAberta([{ role: 'user', created_at: h(3) }], agora).aberta, true);
ok('janela fechada', C.janelaAberta([{ role: 'user', created_at: h(30) }, { role: 'assistant', created_at: h(1) }], agora).aberta, false);
ok('sem mensagem da cliente = fechada', C.janelaAberta([{ role: 'assistant', created_at: h(1) }], agora).aberta, false);
const msgs = [
  { wa_id: '1', role: 'user', texto: 'cadê meu pedido?', created_at: h(5) },
  { wa_id: '2', role: 'user', texto: 'oi', created_at: h(6) }, { wa_id: '2', role: 'assistant', texto: 'Oi!', created_at: h(5) },
  { wa_id: '3', role: 'user', texto: 'Muito obrigada 🙏🏼', created_at: h(5) },
  { wa_id: '4', role: 'user', texto: 'e o rastreio?', created_at: h(0.5) },
  { wa_id: '5', role: 'user', texto: 'quero trocar', created_at: h(4) }, { wa_id: '5', role: 'assistant', texto: '[contexto interno] x', created_at: h(3) },
  { wa_id: '6', role: 'user', texto: '❤️', created_at: h(9) },
];
ok('só quem espera de verdade', C.semResposta(msgs, { agora }).map(x => x.wa_id), ['1', '5']);
// Caso real de 19/10/2026 (Karina, #8893): a Marcelly respondeu e a cliente mandou mais uma 30 s depois.
const karina = [
  { wa_id: 'k', role: 'user', texto: 'Tô merecendo brindes viu???', created_at: '2026-10-19T16:23:44Z' },
  { wa_id: 'k', role: 'operador', texto: 'pode deixar que vou pedir rs', created_at: '2026-10-19T16:24:07Z' },
  { wa_id: 'k', role: 'user', texto: 'pra não ficar com avaliação negativa no Reclame aqui!', created_at: '2026-10-19T16:24:35Z' },
];
const kk = C.semResposta(karina, { agora: Date.parse('2026-10-19T19:30:00Z') })[0];
ok('Karina aparece como conversa em andamento, não sem resposta', kk.situacao.startsWith('conversa em andamento'), true);
ok('diz que foi a equipe e a hora em Brasília', [kk.loja_falou_antes.quem, kk.loja_falou_antes.em_brt, kk.ultima_cliente_brt, kk.equipe_falou_nas_ultimas_24h], ['equipe (atendente humana)', '19/10 13:24', '19/10 13:24', true]);
ok('sem fala da loja continua sem resposta', C.semResposta([{ wa_id: 'z', role: 'user', texto: 'cadê?', created_at: h(5) }], { agora })[0].situacao, 'sem resposta da loja');
ok('conversa vai em horário de Brasília', C.conversaParaAssistente(karina)[1], { quem: 'equipe', em_brt: '19/10 13:24', texto: 'pode deixar que vou pedir rs' });
const respKarina = [{ type: 'tool_use', name: 'responder', id: 't1', input: { texto: 'x', acoes: [
  { tipo: 'pedir_aprovacao', texto: 'brinde: pedido' },
  { tipo: 'mensagem', texto: 'Karina, entendo a sua frustração, o pedido está como prioridade' }] } }];
ok('mensagem com frase de robô volta para revisão antes da tela', C.revisarResposta(respKarina), [{ indice: 1, problemas: ['frase de robô'] }]);
ok('só a mensagem à cliente é revisada', C.revisarResposta([{ type: 'tool_use', name: 'responder', id: 't', input: { texto: 'x', acoes: [{ tipo: 'anotar', texto: 'nota: x' }] } }]), []);
ok('tela devolve uma vez e depois mostra o aviso', main.includes('&& !revisou') && main.includes('Ajuste antes de enviar, o texto'), true);
ok('instrução manda tratar promessa da equipe como pendência', /Promessa da equipe é pendência/.test(C.SISTEMA), true);
ok('agradecimento não é pendência', [C.ehSoAgradecimento('ok obrigada!'), C.ehSoAgradecimento('🙏🏻'), C.ehSoAgradecimento('Eu que agradeço'), C.ehSoAgradecimento('Sim, pode ser o M'), C.ehSoAgradecimento('obrigada, e o rastreio?')], [true, true, true, false, false]);

console.log('\n3) Pedidos citados e prazo de 10 dias úteis');
ok('campo pedido solto + # no resumo', C.numerosDePedido('9142', 'cliente cita #9186 e pedido 9201'), ['9142', '9186', '9201']);
ok('CEP e valor não viram pedido', C.numerosDePedido(null, 'CEP 88010-000, paguei 20190 reais em 12345'), []);
const p = C.prazoDoPedido('2026-10-01T12:00:00-03:00', Date.parse('2026-10-19T12:00:00-03:00'));
ok('dias úteis contam sem feriado de 12/10', p.dias_uteis_desde_pagamento, 11);
ok('passou do prazo', p.passou_do_prazo, true);
const e = C.prazoDoPedido('2026-09-22T17:25:37-03:00', Date.now(), '2026-10-02T10:00:00-03:00');
ok('enviado conta até a etiqueta', [e.dias_uteis_ate_envio, e.saiu_no_prazo], [8, true]);

console.log('\n4) Só fecha com ação feita, e dinheiro espera a Bárbara');
const log = { acoes: [], aprovacoes: [] };
ok('sem ação não fecha', C.podeFechar(652, log).ok, false);
log.acoes.push({ caso_id: 652, tipo: 'fechar' });
ok('fechar não conta como ação', C.podeFechar(652, log).ok, false);
log.acoes.push({ caso_id: 652, tipo: 'mensagem' });
ok('com mensagem enviada fecha', C.podeFechar(652, log).ok, true);
log.aprovacoes.push({ caso_id: 652, status: 'pendente' });
ok('dinheiro pendente segura', C.podeFechar(652, log), { ok: false, motivo: 'tem pedido esperando a decisão da Bárbara' });
log.aprovacoes[0].status = 'aprovado';
ok('aprovado e não feito segura', C.podeFechar(652, log).ok, false);
ok('aprovado libera mensagem com dinheiro', C.aprovacaoLiberada(652, log), true);
log.aprovacoes[0].status = 'feito';
ok('feito libera', C.podeFechar(652, log).ok, true);
ok('outro caso não herda', C.aprovacaoLiberada(531, log), false);

console.log('\n5) Ferramentas no formato estrito');
const semFolga = o => o.type !== 'object' || (o.additionalProperties === false
  && JSON.stringify(Object.keys(o.properties).sort()) === JSON.stringify([...(o.required || [])].sort())
  && Object.values(o.properties).every(v => semFolga(v.items || v)));
ok('todo objeto fecha e exige todos os campos', C.FERRAMENTAS.every(f => f.strict && semFolga(f.input_schema)), true);
ok('responder existe', C.FERRAMENTAS.some(f => f.name === 'responder'), true);
ok('servidor e tela cobrem as ferramentas', [...C.FERRAMENTAS_SERVIDOR, ...C.FERRAMENTAS_TELA, 'responder'].sort(), C.FERRAMENTAS.map(f => f.name).sort());
ok('modelo escolhido pela Bárbara', C.MODELO, 'claude-haiku-5-5');
ok('prompt sem frase pronta para a cliente', /Oi,? [A-Z]|Olá,? [A-Z]/.test(C.SISTEMA), false);

console.log('\n6) Modo só leitura não envia nem grava nada');
ok('botões liberados pela Bárbara em 19/10/2026', C.SO_LEITURA, false);
ok('trava de emergência pela variável CASOS_SO_LEITURA', [C.soLeitura({ CASOS_SO_LEITURA: '1' }), C.soLeitura({ CASOS_SO_LEITURA: 'sim' }), C.soLeitura({}), C.soLeitura(undefined)], [true, true, false, false]);
const chamadas = [];
globalThis.fetch = async (url, init = {}) => {
  const m = (init.method || 'GET').toUpperCase();
  chamadas.push(m + ' ' + String(url).split('?')[0]);
  const j = o => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (/wati_sac_casos/.test(url)) return j([{ id: 658, wa_id: '5511999990000', nome: 'Priscilla C', pedido: '9142', resumo: 'x', status: 'aberto' }]);
  if (/wati_ia_mensagens/.test(url)) return j([{ role: 'user', created_at: new Date(Date.now() - 3600e3).toISOString() }]);
  if (/vc_modelos/.test(url)) return j([{ dados: { acoes: [{ caso_id: 658, tipo: 'mensagem' }], aprovacoes: [] }, updated_at: '2026-10-19T10:00:00Z' }]);
  return j({});
};
const env = { SUPABASE_SERVICE_ROLE_KEY: 'x', WATI_TOKEN: 'x', SHOPIFY_STORE_DOMAIN: 'x', SHOPIFY_ADMIN_TOKEN: 'x', CASOS_AVISO_WA: '5548000000000', CASOS_SO_LEITURA: '1' };
const r1 = await api._interno.executar(env, { tipo: 'mensagem', caso_id: 658, texto: 'Oi Priscilla, seu pedido já saiu e te mando o rastreio' });
ok('mensagem só simula', [r1.ok, r1.so_leitura, /janela de 24h aberta/.test(r1.simulacao)], [false, true, true]);
const r2 = await api._interno.executar(env, { tipo: 'mensagem', caso_id: 658, texto: 'Pedimos desculpas: vamos cancelar' });
ok('texto fora do tom é barrado antes', /desculpas/.test(r2.erro) && /dois-pontos/.test(r2.erro) && /cancelar/.test(r2.erro), true);
const r3 = await api._interno.executar(env, { tipo: 'mensagem', caso_id: 658, texto: 'Vou fazer o estorno hoje' });
ok('promessa de dinheiro sem aprovação é barrada', /aprovação da Bárbara/.test(r3.erro), true);
const r4 = await api._interno.executar(env, { tipo: 'fechar', caso_id: 658 });
ok('fechar com ação feita só simula', [r4.ok, r4.so_leitura], [false, true]);
const r5 = await api._interno.executar(env, { tipo: 'pedir_aprovacao', caso_id: 658, categoria: 'estorno', valor: 303.99, texto: 'cliente desistiu' });
ok('pedido de dinheiro só simula e mostra o aviso', [r5.so_leitura, /R\$ 303,99/.test(r5.aviso)], [true, true]);
ok('aviso à Bárbara sem dois-pontos', r5.aviso.includes(':'), false);
await api._interno.executar(env, { tipo: 'urgente', caso_id: 658, pedido: '9142' });
await api._interno.executar(env, { tipo: 'anotar', caso_id: 658, pedido: '9142', texto: 'NÃO ESTORNAR' });
ok('nenhuma escrita saiu em só leitura', chamadas.filter(c => !c.startsWith('GET')), []);

console.log('\n6b) Liberado: cada botão faz só o que diz');
const vivas = [];
let logAtual = { acoes: [], aprovacoes: [] };
globalThis.fetch = async (url, init = {}) => {
  const m = (init.method || 'GET').toUpperCase(), u = String(url);
  vivas.push(m + ' ' + u.split('?')[0].replace(/^https:\/\/[^/]+/, '') + (/vc_modelos|wati_sac_casos/.test(u) && m !== 'GET' ? ' ' + String(init.body || '').slice(0, 60) : ''));
  const j = o => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (/sendSessionMessage|sendTemplateMessage/.test(u)) return j({ result: true });
  if (/wati_sac_casos/.test(u) && m === 'GET') return j([{ id: 658, wa_id: '5511999990000', nome: 'Priscilla C', pedido: '9142', resumo: 'x', status: 'aberto' }]);
  if (/wati_ia_mensagens/.test(u) && m === 'GET') return j([{ role: 'user', created_at: new Date(Date.now() - 3600e3).toISOString() }]);
  if (/vc_modelos/.test(u) && m === 'GET') return j([{ dados: JSON.parse(JSON.stringify(logAtual)), updated_at: '2026-10-19T10:00:00Z' }]);
  if (/vc_modelos/.test(u) && m === 'PATCH') { logAtual = JSON.parse(init.body).dados; return j([{ id: 'casos-log' }]); }
  return new Response('', { status: 201 });
};
const envVivo = { ...env, CASOS_SO_LEITURA: '' };
const f0 = await api._interno.executar(envVivo, { tipo: 'fechar', caso_id: 658 });
ok('fechar sem ação continua barrado', [f0.ok, vivas.some(c => !c.startsWith('GET'))], [false, false]);
vivas.length = 0;
const v1 = await api._interno.executar(envVivo, { tipo: 'mensagem', caso_id: 658, texto: 'Oi Priscilla, seu pedido já saiu e te mando o rastreio' });
ok('mensagem enviada na janela aberta', [v1.ok, v1.feito], [true, 'mensagem enviada']);
ok('envio, histórico da Vi e registro, nessa ordem', vivas.filter(c => !c.startsWith('GET')).map(c => c.split(' ').slice(0, 2).join(' ')),
  ['POST /1061955/api/v1/sendSessionMessage/5511999990000', 'POST /rest/v1/wati_ia_mensagens', 'PATCH /rest/v1/vc_modelos']);
ok('registro guarda a mensagem do caso', logAtual.acoes.map(a => [a.caso_id, a.tipo, a.via]), [[658, 'mensagem', 'sessao']]);
vivas.length = 0;
const v2 = await api._interno.executar(envVivo, { tipo: 'fechar', caso_id: 658 });
ok('com a mensagem registrada o caso fecha', v2.ok, true);
ok('fechar grava status resolvido', vivas.some(c => c.startsWith('PATCH /rest/v1/wati_sac_casos {"status":"resolvido"')), true);
vivas.length = 0;
const v3 = await api._interno.executar(envVivo, { tipo: 'pedir_aprovacao', caso_id: 658, categoria: 'estorno', valor: 303.99, texto: 'cliente desistiu' });
ok('pedido de dinheiro entra na fila', [v3.ok, logAtual.aprovacoes.length, logAtual.aprovacoes[0] && logAtual.aprovacoes[0].status], [true, 1, 'pendente']);
ok('e avisa a Bárbara pelo template', vivas.some(c => c.startsWith('POST /1061955/api/v1/sendTemplateMessage')), true);
ok('com dinheiro pendente o caso não fecha', (await api._interno.executar(envVivo, { tipo: 'fechar', caso_id: 658 })).ok, false);

console.log('\n7) Tela abre vazia e a rota nasce protegida');
ok('pílula Casos no Atendimento', html.includes(`atdShowSub('casos')`) && html.includes('id="atd-sub-casos"'), true);
const abrir = main.slice(main.indexOf('async function csAbrir'), main.indexOf('function csRenderTopo'));
ok('abrir a aba não chama a IA', /assistente|ferramenta/.test(abrir.replace(/\/\/.*$/gm, '')), false);
ok('abrir a aba só pede o estado', abrir.includes("/api/casos?estado=1"), true);
ok('blocos da IA voltam sem edição', main.includes("csMsgs.push({ role: 'assistant', content: d.content })"), true);
const csEsc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const csMd = new Function('csEsc', main.slice(main.indexOf('function csMd'), main.indexOf('function csBolha')) + '; return csMd;')(csEsc);
ok('negrito e tópicos viram formatação', csMd('**Fazer agora**\n- **Karina**, #8893 parado\n- outra'),
  '<div><b>Fazer agora</b></div><ul style="margin:2px 0 8px;padding-left:20px"><li style="margin:3px 0"><b>Karina</b>, #8893 parado</li><li style="margin:3px 0">outra</li></ul>');
ok('passos numerados viram lista', /<ol[^>]*><li[^>]*>abrir<\/li><li[^>]*>mandar<\/li><\/ol>/.test(csMd('1. abrir\n2. mandar')), true);
ok('texto da cliente não vira HTML', csMd('- <img src=x onerror=alert(1)> **oi**').includes('<img'), false);
ok('bolha do assistente usa a formatação', main.includes("div.innerHTML = csMd(texto)"), true);
ok('instrução pede tópicos e próximo passo', /sempre em tópicos/.test(C.SISTEMA) && /próximo passo concreto/.test(C.SISTEMA), true);
ok('rota fora do PUBLICO (exige sessão)', /PUBLICO = new Set\([^)]*casos/.test(mid), false);

console.log(`\n${total - falhas}/${total} passaram`);
if (falhas) process.exit(1);
