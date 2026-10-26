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
ok('promessa da Marcelly à Karina é achada com o pedido dela', C.promessasDaEquipe(karina, { agora: Date.parse('2026-10-19T19:30:00Z') }),
  [{ em_brt: '19/10 13:24', equipe_disse: 'pode deixar que vou pedir rs', cliente_tinha_pedido: 'Tô merecendo brindes viu???' }]);
ok('fala da Vi não conta como promessa da equipe', C.promessasDaEquipe([{ role: 'assistant', texto: 'vou verificar', created_at: '2026-10-19T16:00:00Z' }], { agora: Date.parse('2026-10-19T19:30:00Z') }), []);
ok('promessa velha (mais de 7 dias) sai', C.promessasDaEquipe([{ role: 'operador', texto: 'vou ver', created_at: '2026-10-01T16:00:00Z' }], { agora: Date.parse('2026-10-19T19:30:00Z') }), []);
const respKarina = [{ type: 'tool_use', name: 'responder', id: 't1', input: { texto: 'x', acoes: [
  { tipo: 'pedir_aprovacao', texto: 'brinde: pedido' },
  { tipo: 'mensagem', texto: 'Karina, entendo a sua frustração, o pedido está como prioridade' }] } }];
ok('mensagem com frase de robô volta para revisão antes da tela', C.revisarResposta(respKarina), [{ indice: 1, problemas: ['frase de robô'] }]);
ok('só a mensagem à cliente é revisada', C.revisarResposta([{ type: 'tool_use', name: 'responder', id: 't', input: { texto: 'x', acoes: [{ tipo: 'anotar', texto: 'nota: x' }] } }]), []);
ok('tela devolve uma vez e depois mostra o aviso', main.includes('&& !revisou') && main.includes('Ajuste antes de enviar, o texto'), true);
ok('instrução manda tratar promessa da equipe como pendência', /Promessa da equipe é pendência/.test(C.SISTEMA), true);
// Conversa vem da Wati: a etiqueta em PDF da Luiza (#9123) não estava no histórico da Vi.
const wati = [
  { eventType: 'ticket', created: '2026-10-19T19:26:00Z' },
  { eventType: 'message', type: 'document', owner: true, operatorName: 'Vi da Vista Conecte', text: '/data/documents/x.pdf', created: '2026-10-19T14:48:00Z' },
  { eventType: 'message', type: 'text', owner: false, operatorName: 'Vi da Vista Conecte', text: 'entrego nos correios com essa etiqueta?', created: '2026-10-19T14:49:00Z' },
  { eventType: 'message', type: 'text', owner: true, operatorName: 'API Token 1061955', text: 'Pra uva, você quer o M?', created: '2026-10-19T16:16:18Z' },
  { eventType: 'message', type: 'image', owner: false, text: 'Mas o pacote está no meu nome.', created: '2026-10-19T14:33:00Z' },
];
ok('documento da equipe entra na conversa', C.watiParaMsg(wati[1]), { role: 'operador', texto: '[a loja enviou um documento (PDF, etiqueta, comprovante)]', created_at: '2026-10-19T14:48:00Z' });
ok('mensagem pela API é da Vi, pela caixa da Wati é da equipe', [C.watiParaMsg(wati[3]).role, C.watiParaMsg(wati[1]).role, C.watiParaMsg(wati[2]).role], ['assistant', 'operador', 'user']);
ok('imagem da cliente leva a legenda', C.watiParaMsg(wati[4]).texto, '[a cliente enviou uma imagem] Mas o pacote está no meu nome.');
ok('evento de ticket fica de fora', C.watiParaMsg(wati[0]), null);
ok('abrir caso lê o WhatsApp antes do histórico da Vi sozinho', /const doZap = wa \? await conversaWhatsapp/.test(readFileSync(join(raiz, 'functions', 'api', 'casos.js'), 'utf8')), true);
// Desde 26/10/2026 a conversa vem do painel (Meta + histórico da Vi, já juntos pelo mesclar do _whatsapp.js).
ok('foto da cliente pela Meta leva a legenda', C.metaParaMsg({ quando: '2026-10-26T14:33:00Z', lado: 'cliente', tipo: 'image', texto: 'Mas o pacote está no meu nome.' }),
  { role: 'user', texto: '[a cliente enviou uma imagem] Mas o pacote está no meu nome.', created_at: '2026-10-26T14:33:00Z' });
ok('documento da equipe pelo painel é da equipe', C.metaParaMsg({ quando: '2026-10-26T14:48:00Z', lado: 'equipe', tipo: 'document', texto: null }),
  { role: 'operador', texto: '[a loja enviou um documento (PDF, etiqueta, comprovante)]', created_at: '2026-10-26T14:48:00Z' });
ok('Vi e template são da loja automática', [C.metaParaMsg({ quando: 'x', lado: 'vi', tipo: 'text', texto: 'Pra uva, você quer o M?' }).role, C.metaParaMsg({ quando: 'x', lado: 'auto', tipo: 'template', texto: '' }).texto],
  ['assistant', '[a loja enviou um template automático]']);
ok('status sem texto fica de fora', C.metaParaMsg({ quando: 'x', lado: 'equipe', tipo: null, texto: null }), null);
ok('agradecimento não é pendência', [C.ehSoAgradecimento('ok obrigada!'), C.ehSoAgradecimento('🙏🏻'), C.ehSoAgradecimento('Eu que agradeço'), C.ehSoAgradecimento('Sim, pode ser o M'), C.ehSoAgradecimento('obrigada, e o rastreio?')], [true, true, true, false, false]);

console.log('\n3) Pedidos citados e prazo de 10 dias úteis');
ok('campo pedido solto + # no resumo', C.numerosDePedido('9142', 'cliente cita #9186 e pedido 9201'), ['9142', '9186', '9201']);
ok('CEP e valor não viram pedido', C.numerosDePedido(null, 'CEP 88010-000, paguei 20190 reais em 12345'), []);
const p = C.prazoDoPedido('2026-10-01T12:00:00-03:00', Date.parse('2026-10-19T12:00:00-03:00'));
ok('dias úteis contam sem feriado de 12/10', p.dias_uteis_desde_pagamento, 11);
ok('passou do prazo', p.passou_do_prazo, true);
const e = C.prazoDoPedido('2026-09-22T17:25:37-03:00', Date.now(), '2026-10-02T10:00:00-03:00');
ok('enviado conta até a etiqueta', [e.dias_uteis_ate_envio, e.saiu_no_prazo], [8, true]);

console.log('\n3b) Voucher no valor pago (regra da Bárbara, 19/10/2026)');
ok('desconto rateado na linha sai do valor (pedido #9250 real)', C.pagoPorItem({ title: 'Calça Pantalona', variant_title: 'Uva / G', price: '169.00', quantity: 1, discount_allocations: [{ amount: '33.05' }] }),
  { item: '1x Calça Pantalona (Uva / G)', preco_cheio: 169, desconto: 33.05, pago: 135.95, pago_por_peca: 135.95 });
ok('duas unidades dividem o pago por peça', C.pagoPorItem({ title: 'Top', price: '59.90', quantity: 2, discount_allocations: [{ amount: '10.00' }, { amount: '1.80' }] }).pago_por_peca, 54);
ok('sem desconto paga o cheio', C.pagoPorItem({ title: 'Saia', price: '159.00', quantity: 1 }).pago, 159);
ok('mensagem de voucher no valor pago não é barrada', C.prometeDinheiro('Lais, seu voucher fica em R$ 135,95, que é o valor que você pagou com o desconto'), false);
ok('estorno continua barrado mesmo falando de voucher', C.prometeDinheiro('em vez do voucher faço o estorno'), true);
ok('desconto sem voucher continua barrado', C.prometeDinheiro('te dou 10% de desconto na próxima'), true);
ok('voucher no valor pago é da Marcelly, acima vai para a Bárbara', /Voucher no valor pago a Marcelly faz sozinha/.test(C.SISTEMA) && /voucher acima do valor pago/.test(C.SISTEMA), true);
ok('instrução manda voucher no valor pago', /Voucher de troca ou devolução é sempre no valor que a cliente PAGOU/.test(C.SISTEMA), true);
ok('instrução manda anotar e fechar o que foi resolvido por fora', /Resolvido por fora/.test(C.SISTEMA), true);

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
const env = { SUPABASE_SERVICE_ROLE_KEY: 'x', META_ACCESS_TOKEN: 'x', SHOPIFY_STORE_DOMAIN: 'x', SHOPIFY_ADMIN_TOKEN: 'x', CASOS_AVISO_WA: '5548000000000', CASOS_SO_LEITURA: '1' };
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
const enviosMeta = [];
let logAtual = { acoes: [], aprovacoes: [] };
globalThis.fetch = async (url, init = {}) => {
  const m = (init.method || 'GET').toUpperCase(), u = String(url);
  vivas.push(m + ' ' + u.split('?')[0].replace(/^https:\/\/[^/]+/, '') + (/vc_modelos|wati_sac_casos/.test(u) && m !== 'GET' ? ' ' + String(init.body || '').slice(0, 60) : ''));
  const j = o => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (/graph\.facebook\.com\/.*\/messages$/.test(u.split('?')[0])) { enviosMeta.push(JSON.parse(init.body)); return j({ messages: [{ id: 'wamid.T' + enviosMeta.length }] }); }
  if (/graph\.facebook\.com\/.*\/media$/.test(u.split('?')[0])) return j({ id: '771' });
  if (/message_templates/.test(u)) return j({ data: [
    { name: 'continuidade_solicitacao_v1', language: 'pt_BR', status: 'APPROVED', components: [{ type: 'BODY', text: 'Olá, {{1}}! Estamos dando continuidade à sua solicitação: {{2}}.' }] },
    { name: 'alerta_interno_vi', language: 'pt_BR', status: 'APPROVED', components: [{ type: 'BODY', text: 'Alerta do sistema Vi (Vista Conecte): {{1}}' }] }] });
  if (/wa_mensagens/.test(u) && m === 'GET') return j([]);
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
  ['POST /v23.0/910542668806764/messages', 'POST /rest/v1/wati_ia_mensagens', 'PATCH /rest/v1/vc_modelos']);
ok('sai pela Meta, para a cliente, pela conta 925', [enviosMeta[0].to, enviosMeta[0].type, enviosMeta[0].messaging_account_id], ['5511999990000', 'text', '925433550103556']);
ok('registro guarda a mensagem do caso', logAtual.acoes.map(a => [a.caso_id, a.tipo, a.via]), [[658, 'mensagem', 'sessao']]);
vivas.length = 0;
const v2 = await api._interno.executar(envVivo, { tipo: 'fechar', caso_id: 658 });
ok('com a mensagem registrada o caso fecha', v2.ok, true);
ok('fechar grava status resolvido', vivas.some(c => c.startsWith('PATCH /rest/v1/wati_sac_casos {"status":"resolvido"')), true);
vivas.length = 0;
const v3 = await api._interno.executar(envVivo, { tipo: 'pedir_aprovacao', caso_id: 658, categoria: 'estorno', valor: 303.99, texto: 'cliente desistiu' });
ok('pedido de dinheiro entra na fila', [v3.ok, logAtual.aprovacoes.length, logAtual.aprovacoes[0] && logAtual.aprovacoes[0].status], [true, 1, 'pendente']);
const aviso = enviosMeta[enviosMeta.length - 1];
ok('e avisa a Bárbara pelo template da Meta', [/avisada no WhatsApp/.test(v3.feito), aviso.to, aviso.template && aviso.template.name], [true, '5548000000000', 'alerta_interno_vi']);
ok('com dinheiro pendente o caso não fecha', (await api._interno.executar(envVivo, { tipo: 'fechar', caso_id: 658 })).ok, false);

console.log('\n6c) Etiqueta em PDF pelo cartão (pedido da Marcelly, 19/10/2026)');
const pdf = new File(['%PDF-1.1 teste'], 'etiqueta-9250.pdf', { type: 'application/pdf' });
vivas.length = 0;
const a1 = await api._interno.executar(envVivo, { tipo: 'mensagem', caso_id: 658, texto: 'Segue a etiqueta, Priscilla', arquivo: pdf });
const doc = enviosMeta[enviosMeta.length - 1];
ok('arquivo vai pela Meta com a legenda', [a1.ok, a1.feito, vivas.some(c => c.startsWith('POST /v23.0/910542668806764/media')), doc.type, doc.document && doc.document.id, doc.document && doc.document.caption],
  [true, 'arquivo enviado', true, 'document', '771', 'Segue a etiqueta, Priscilla']);
ok('registro diz que foi arquivo', logAtual.acoes[logAtual.acoes.length - 1].via, 'arquivo');
const a2 = await api._interno.executar(envVivo, { tipo: 'mensagem', caso_id: 658, texto: '', arquivo: pdf });
ok('arquivo sem texto também vai', a2.ok, true);
const grande = { size: 6 * 1024 * 1024, name: 'grande.pdf' };
ok('arquivo acima de 5 MB é recusado', /grande demais/.test((await api._interno.executar(envVivo, { tipo: 'mensagem', caso_id: 658, texto: 'x', arquivo: grande })).erro), true);
const fetchAntes = globalThis.fetch;
globalThis.fetch = async (url, init) => /wati_ia_mensagens/.test(String(url)) && (!init || !init.method || init.method === 'GET')
  ? new Response(JSON.stringify([{ role: 'user', created_at: '2026-10-10T10:00:00Z' }]), { status: 200 }) : fetchAntes(url, init);
const a3 = await api._interno.executar(envVivo, { tipo: 'mensagem', caso_id: 658, texto: 'segue', assunto: 'etiqueta', arquivo: pdf });
ok('janela fechada: arquivo não vai e explica o caminho', /janela de 24h fechou e arquivo não vai por template/.test(a3.erro), true);
const a4 = await api._interno.executar(envVivo, { tipo: 'mensagem', caso_id: 658, texto: 'segue', assunto: 'a troca do pedido 9142' });
const tpl = enviosMeta[enviosMeta.length - 1].template || {};
ok('janela fechada: vai o template de continuidade pela Meta', [a4.feito, tpl.name, (tpl.components || [])[0] && tpl.components[0].parameters.map(p => p.text)],
  ['template de continuidade enviado', 'continuidade_solicitacao_v1', ['Priscilla', 'a troca do pedido 9142']]);
ok('o histórico da Vi recebe o texto do template', /continuidade à sua solicitação: a troca do pedido 9142/.test(logAtual.acoes[logAtual.acoes.length - 1].texto), true);
globalThis.fetch = fetchAntes;
const fd = new FormData();
fd.append('acao', 'executar'); fd.append('tipo', 'mensagem'); fd.append('caso_id', '658'); fd.append('texto', 'Segue a etiqueta'); fd.append('arquivo', pdf, 'etiqueta-9250.pdf');
const rq = await api.onRequestPost({ request: new Request('https://x/api/casos', { method: 'POST', body: fd }), env: { ...env, CASOS_SO_LEITURA: '1' } });
const rqj = await rq.json();
ok('cartão com arquivo chega como multipart e é entendido', [rqj.so_leitura, /etiqueta-9250\.pdf/.test(rqj.simulacao || '')], [true, true]);
ok('tela manda o arquivo junto do cartão', main.includes("fd.append('arquivo', arq, arq.name)") && main.includes('data-c="arquivo" type="file"'), true);
ok('instrução diz que dá para anexar a etiqueta e que a primeira troca é gratuita', /anexar arquivo/.test(C.SISTEMA) && /primeira troca da cliente é gratuita em até 7 dias/.test(C.SISTEMA), true);

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
console.log('\n7b) Conversa não some quando a página recarrega');
ok('abrir a aba redesenha a conversa salva antes de mostrar vazio', main.includes("!chat.children.length && !csRestaurar()"), true);
ok('cada fala e cada botão salvam no aparelho', main.includes('csSalvar();\n}\n\n// Guarda o resultado de um botão') && main.includes('guardar(true)'), true);
ok('vale para o dia (no seguinte começa limpa)', main.includes("g.dia !== csHoje()"), true);
ok('Nova conversa apaga o que estava salvo', /csBolhas = \[\];\n  try \{ localStorage\.removeItem\(CS_GUARDA\)/.test(main), true);
const sanear = new Function('msgs', 'pend', `let csMsgs = msgs, csPendentes = pend;\n${main.slice(main.indexOf('function csSanear()'), main.indexOf('function csRestaurar()'))}\ncsSanear(); return csPendentes;`);
const interrompida = [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }, { role: 'assistant', content: [
  { type: 'thinking', thinking: '' }, { type: 'tool_use', id: 'a', name: 'abrir_caso', input: {} }, { type: 'tool_use', id: 'b', name: 'responder', input: {} }] }];
ok('recarga no meio da volta fecha os pedidos de ferramenta', sanear(interrompida, []).map(r => [r.tool_use_id, !!r.is_error]), [['a', true], ['b', false]]);
ok('conversa em ordem não é mexida', sanear([{ role: 'user', content: [] }], []), []);
ok('pendentes já guardados ficam como estão', sanear(interrompida, [{ type: 'tool_result', tool_use_id: 'b', content: 'mostrado à Marcelly' }]).length, 1);

console.log('\n8) Status da peça e troca de etiqueta (mesmo cálculo do card LIBERAR TROCANDO A ETIQUETA)');
const fn = nome => { const i = main.indexOf(`function ${nome}(`); return main.slice(i, main.indexOf('\n}\n', i) + 2); };
const fabrica = new Function('window', 'MODELOS', 'sacGetConfig', 'producaoDaPeca', 'tamanhosDe', 'diasDesde', 'SEM_TROCA_ETIQUETA',
  ['modeloAceitaTrocaEtiqueta', 'planejarTrocaEtiqueta', 'csOutrasCores', 'csSituacaoProducao', 'csProducaoCurta', 'csEnriquecer'].map(fn).join('\n')
  + '\nreturn { csSituacaoProducao, csProducaoCurta, csEnriquecer };');
const MOD = { 'vestido-amplo': { nome: 'Vestido Amplo', tamanhos: ['PP', 'P', 'M', 'G', 'GG'], aberto: { Marrom: [0, 0, 1, 0, 0] } },
  'macaquinho-amplo': { nome: 'Macaquinho Amplo', tamanhos: ['PP', 'P', 'M', 'G', 'GG'], aberto: { Preto: [0, 1, 0, 0, 0] } } };
const ped = (numero, key, cor, tam) => ({ numero, data: '2026-10-01', faltas: [{ key, cor, tam, qtd: 1, falta: 1 }], reqs: [{ key, cor, tam, qtd: 1 }] });
const win = {
  _prontosEnvio: [{ numero: '#9300' }],
  _pedidosPendentes: [ped('#9210', 'vestido-amplo', 'Marrom', 2), ped('#9194', 'macaquinho-amplo', 'Preto', 1)],
  _estoqueLivre: { 'vestido-amplo': { Marrom: [0, 0, 0, 1, 0] }, 'macaquinho-amplo': { Preto: [0, 0, 1, 0, 0] } },
  _estoqueBruto: { 'vestido-amplo': { Marrom: [0, 0, 0, 1, 0] }, 'macaquinho-amplo': { Preto: [0, 0, 1, 0, 0] } },
};
const T = fabrica(win, MOD, () => ({ tickets: [{ pedido: '9210', status: 'pendente', urgente: false }] }),
  (key) => key === 'vestido-amplo' ? { qtd: 2, etapa: 'Em costura' } : { qtd: 0, etapa: null },
  def => def.tamanhos, () => 18, new Set(['macaquinho-amplo']));
const s9210 = T.csSituacaoProducao('9210');
ok('falta M e sobra G sem dono: sai trocando a etiqueta', [s9210.situacao, s9210.troca_de_etiqueta && s9210.troca_de_etiqueta.o_que_fazer],
  ['esperando peça, mas sai hoje trocando a etiqueta', ['Vestido Amplo Marrom, pegar 1 peça do G e trocar a etiqueta para M']]);
ok('diz a etapa da peça que falta', s9210.faltas[0].etapa_interna, 'Em costura');
ok('já sabe que está no SAC sem urgente', [s9210.no_sac, s9210.urgente_no_sac], [true, false]);
const s9194 = T.csSituacaoProducao('9194');
ok('Macaquinho Amplo nunca troca etiqueta', [s9194.troca_de_etiqueta, s9194.faltas[0].etapa_interna], [null, 'NÃO ESTÁ NA PRODUÇÃO']);
ok('linha curta da lista do dia', [T.csProducaoCurta('9300'), T.csProducaoCurta('9194'), T.csProducaoCurta('9999')],
  ['pronto para envio', 'falta Macaquinho Amplo Preto P (NÃO ESTÁ NA PRODUÇÃO)', 'não está nos pagos em aberto (enviado, não pago ou cancelado)']);
const lista = T.csEnriquecer('pendencias_do_dia', { casos_abertos: [{ caso_id: 725, pedido: '#9210' }, { caso_id: 1, pedido: null }] });
ok('lista do dia chega ao assistente com o status da peça', [/^sai hoje trocando a etiqueta/.test(lista.casos_abertos[0].producao), lista.casos_abertos[1].producao], [true, undefined]);
// Ida (#9243): Carneirinho Cropped Preto M fora da produção, Off White M sem dono na arara.
const MOD2 = { 'carneirinho-cropped': { nome: 'Carneirinho Cropped', tamanhos: ['PP', 'P', 'M', 'G', 'GG'],
  aberto: { Preto: [0, 0, 1, 0, 0], 'Off White': [0, 0, 1, 0, 0], Bege: [0, 0, 0, 0, 0] } } };
const win2 = {
  _prontosEnvio: [], _pedidosPendentes: [ped('#9243', 'carneirinho-cropped', 'Preto', 2)],
  _estoqueLivre: { 'carneirinho-cropped': { Preto: [0, 0, 0, 0, 0], 'Off White': [0, 0, 3, 0, 0], Bege: [0, 0, 0, 1, 0] } },
  _estoqueBruto: { 'carneirinho-cropped': { Preto: [0, 0, 0, 0, 0], 'Off White': [0, 0, 3, 0, 0], Bege: [0, 0, 0, 1, 0] } },
};
const T2 = fabrica(win2, MOD2, () => ({ tickets: [] }), () => ({ qtd: 0, etapa: null }), def => def.tamanhos, () => 12, new Set());
const s9243 = T2.csSituacaoProducao('9243');
ok('Ida: Preto M fora da produção e Off White M sem dono (3 menos 1 em aberto)', [s9243.faltas[0].etapa_interna, s9243.faltas[0].alternativas_em_estoque],
  ['NÃO ESTÁ NA PRODUÇÃO', [{ cor: 'Off White', sem_dono: 2 }]]);
ok('cor com estoque só em outro tamanho não entra', s9243.faltas[0].alternativas_em_estoque.some(a => a.cor === 'Bege'), false);
ok('linha da lista do dia já diz a cor em estoque', /tem em estoque na cor Off White/.test(T2.csProducaoCurta('9243')), true);
ok('fora da produção não manda avisar a Bárbara, oferece outra cor', /não mande avisar a Bárbara/.test(C.SISTEMA) && /alternativas_em_estoque/.test(C.SISTEMA) && !/para a Marcelly avisar a Bárbara/.test(C.SISTEMA), true);
ok('brinde é da equipe e não vai para aprovação', [C.CATEGORIAS_DINHEIRO.includes('brinde'), C.prometeDinheiro('vou mandar um brinde no seu pacote'), /autonomia para mandar brinde/.test(C.SISTEMA)], [false, false, true]);
ok('lista do dia: todo pedido sai com o status da peça (print da Bárbara, 19/10/2026)', /SEMPRE o status da peça tirado do campo producao/.test(C.SISTEMA) && !/só com cliente e pedido/.test(C.SISTEMA), true);
ok('instrução manda sugerir a troca e dizer o status', /Troca de etiqueta/.test(C.SISTEMA) && /Em todo pedido atrasado ou cobrado diga o status/.test(C.SISTEMA), true);

ok('rota fora do PUBLICO (exige sessão)', /PUBLICO = new Set\([^)]*casos/.test(mid), false);

console.log(`\n${total - falhas}/${total} passaram`);
if (falhas) process.exit(1);
