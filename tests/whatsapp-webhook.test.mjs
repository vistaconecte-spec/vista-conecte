/**
 * Testes do webhook do WhatsApp oficial (etapa 1 do atendimento próprio, 19/10/2026).
 *
 * POR QUE ISTO EXISTE: o app Meta passa a ouvir o número da loja em paralelo com o Wati. Se o
 * webhook gravar errado, a comparação com o Wati engana e a gente desliga o Wati perdendo
 * mensagem. Aqui fica travado: o que é aceito, o que é recusado e o que vai para o banco.
 *
 * Rodar:  node tests/whatsapp-webhook.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createHmac } from 'node:crypto';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const mid = readFileSync(join(raiz, 'functions', 'api', '_middleware.js'), 'utf8');
const W = await import(pathToFileURL(join(raiz, 'functions', '_whatsapp.js')).href);
const api = await import(pathToFileURL(join(raiz, 'functions', 'api', 'webhook-whatsapp.js')).href);

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  X ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ok ${nome}`);
}

const corpo = (value) => ({ object: 'whatsapp_business_account', entry: [{ id: W.WABA_ID, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: W.PHONE_NUMBER_ID }, ...value } }] }] });

console.log('\n1) Extração');
let e = W.extrair(corpo({
  contacts: [{ wa_id: '5548999990000', profile: { name: 'Ana' } }],
  messages: [
    { from: '5548999990000', id: 'wamid.1', timestamp: '1792400000', type: 'text', text: { body: 'oi, meu pedido 9300?' } },
    { from: '5548999990000', id: 'wamid.2', timestamp: '1792400010', type: 'image', image: { id: 'MID1', mime_type: 'image/jpeg', caption: 'olha o defeito' }, context: { id: 'wamid.0' } },
    { from: '5548999990000', id: 'wamid.3', timestamp: '1792400020', type: 'audio', audio: { id: 'MID2', mime_type: 'audio/ogg; codecs=opus' } },
    { from: '5548999990000', id: 'wamid.4', timestamp: '1792400030', type: 'button', button: { text: 'Quero meu link', payload: 'x' } },
    { from: '5548999990000', id: 'wamid.5', timestamp: '1792400040', type: 'reaction', reaction: { emoji: '❤', message_id: 'wamid.9' } },
  ],
}));
ok('5 mensagens', e.mensagens.length, 5);
ok('texto', e.mensagens[0].texto, 'oi, meu pedido 9300?');
ok('telefone só dígitos', e.mensagens[0].telefone, '5548999990000');
ok('nome do perfil', e.mensagens[0].nome_contato, 'Ana');
ok('hora da Meta em ISO', e.mensagens[0].enviada_em, new Date(1792400000 * 1000).toISOString());
ok('foto: legenda, mídia e citada', [e.mensagens[1].texto, e.mensagens[1].midia_id, e.mensagens[1].midia_mime, e.mensagens[1].resposta_a], ['olha o defeito', 'MID1', 'image/jpeg', 'wamid.0']);
ok('áudio sem legenda', [e.mensagens[2].texto, e.mensagens[2].midia_id], [null, 'MID2']);
ok('botão de template', e.mensagens[3].texto, 'Quero meu link');
ok('reação aponta a mensagem', [e.mensagens[4].texto, e.mensagens[4].resposta_a], ['❤', 'wamid.9']);
ok('direção entrada', e.mensagens.every(m => m.direcao === 'entrada'), true);

e = W.extrair(corpo({ statuses: [{ id: 'wamid.S', status: 'read', timestamp: '1792400100', recipient_id: '5548999990000' }] }));
ok('status de saída', [e.status.length, e.status[0].status, e.status[0].status_rank], [1, 'read', 3]);
e = W.extrair(corpo({ statuses: [{ id: 'wamid.F', status: 'failed', timestamp: '1', recipient_id: '55', errors: [{ code: 131047 }] }] }));
ok('falha guarda o erro', e.status[0].erro, [{ code: 131047 }]);

const outro = corpo({ messages: [{ from: '1', id: 'x', timestamp: '1', type: 'text', text: { body: 'a' } }] });
outro.entry[0].changes[0].value.metadata.phone_number_id = '999';
ok('outro número é ignorado', W.extrair(outro).mensagens.length, 0);
ok('objeto que não é WhatsApp', W.extrair({ object: 'page', entry: [] }).mensagens.length, 0);

console.log('\n2) Rota');
ok('rota é pública no middleware', mid.includes("'/api/webhook-whatsapp'"), true);

const chamadas = [];
globalThis.fetch = async (u, o) => { chamadas.push({ u: String(u), m: o.method, b: o.body }); return new Response(o.method === 'PATCH' ? '[]' : '', { status: o.method === 'PATCH' ? 200 : 201 }); };
const env = { WEBHOOK_KEY: 'chave', SUPABASE_SERVICE_ROLE_KEY: 'srv' };
const base = 'https://vistaconecte.pages.dev/api/webhook-whatsapp';
const req = (u, o) => api.onRequest({ request: new Request(u, o), env });

let r = await req(`${base}?hub.mode=subscribe&hub.verify_token=chave&hub.challenge=123`);
ok('verificação devolve o challenge', [r.status, await r.text()], [200, '123']);
r = await req(`${base}?hub.mode=subscribe&hub.verify_token=errada&hub.challenge=123`);
ok('verificação com token errado', r.status, 403);

const txt = JSON.stringify(corpo({ messages: [{ from: '5548999990000', id: 'wamid.1', timestamp: '1', type: 'text', text: { body: 'oi' } }], statuses: [{ id: 'wamid.S', status: 'delivered', timestamp: '2', recipient_id: '5548999990000' }] }));
r = await req(`${base}?k=errada`, { method: 'POST', body: txt });
ok('POST sem a chave', r.status, 401);
ok('nada gravado sem a chave', chamadas.length, 0);

r = await req(`${base}?k=chave`, { method: 'POST', body: txt });
ok('POST certo', [r.status, await r.json()], [200, { ok: true, mensagens: 1, status: 1 }]);
ok('grava evento, mensagem, tenta status e cria linha de saída', chamadas.map(c => c.m + ' ' + c.u.split('/rest/v1/')[1].split('?')[0]), ['POST wa_eventos', 'POST wa_mensagens', 'PATCH wa_mensagens', 'POST wa_mensagens']);
ok('repetida é ignorada', chamadas[1].u.includes('on_conflict=wamid'), true);
ok('status só anda pra frente', chamadas[2].u.includes('status_rank=lt.2'), true);

chamadas.length = 0;
const envSeg = { ...env, WA_APP_SECRET: 'seg' };
const sig = 'sha256=' + createHmac('sha256', 'seg').update(txt).digest('hex');
r = await api.onRequest({ request: new Request(`${base}?k=chave`, { method: 'POST', body: txt, headers: { 'X-Hub-Signature-256': 'sha256=00' } }), env: envSeg });
ok('assinatura errada com segredo configurado', r.status, 401);
r = await api.onRequest({ request: new Request(`${base}?k=chave`, { method: 'POST', body: txt, headers: { 'X-Hub-Signature-256': sig } }), env: envSeg });
ok('assinatura certa passa', r.status, 200);

// Etapa 3: depois de gravar, a mensagem da cliente segue para a Vi.
chamadas.length = 0;
const tarefas = [];
r = await api.onRequest({ request: new Request(`${base}?k=chave`, { method: 'POST', body: txt }), env: { ...env, VI_META_URL: 'https://vi/webhook/meta?key=z' }, waitUntil: p => tarefas.push(p) });
await Promise.all(tarefas);
const rep = chamadas.find(c => c.u.startsWith('https://vi/'));
ok('repassa para a Vi depois de gravar', [r.status, !!rep, rep && JSON.parse(rep.b).mensagens.map(m => [m.wamid, m.telefone, !!m.bruto])], [200, true, [['wamid.1', '5548999990000', true]]]);
ok('repasse vem depois da gravação', chamadas.findIndex(c => c.u.startsWith('https://vi/')) > chamadas.findIndex(c => c.u.includes('wa_mensagens')), true);
chamadas.length = 0;
const so_status = JSON.stringify(corpo({ statuses: [{ id: 'wamid.S', status: 'read', timestamp: '2', recipient_id: '55' }] }));
await api.onRequest({ request: new Request(`${base}?k=chave`, { method: 'POST', body: so_status }), env: { ...env, VI_META_URL: 'https://vi/x' }, waitUntil: p => tarefas.push(p) });
ok('status não vai para a Vi', chamadas.some(c => c.u.startsWith('https://vi/')), false);

globalThis.fetch = async () => new Response('fora', { status: 503 });
r = await req(`${base}?k=chave`, { method: 'POST', body: txt });
ok('banco fora devolve 500 pra Meta reenviar', r.status, 500);

console.log('\n3) Caixa de entrada: telefone, junção e janela');
ok('chave tira o 9 do celular', W.chave('5562993161442'), '556293161442');
ok('chave mantém número de 12', W.chave('553598000816'), '553598000816');
ok('variantes com e sem o 9', W.variantes('5562993161442'), ['556293161442', '5562993161442']);
ok('fixo não ganha 9', W.variantes('554833334444'), ['554833334444']);

const wa = [
  { wamid: 'w1', direcao: 'entrada', tipo: 'text', texto: 'Oi, cadê meu pedido?', enviada_em: '2026-10-19T21:16:40Z' },
  { wamid: 'w2', direcao: 'entrada', tipo: 'image', texto: null, midia_id: '123456', midia_mime: 'image/jpeg', enviada_em: '2026-10-19T21:17:00Z' },
  { wamid: 'w3', direcao: 'saida', tipo: 'text', texto: 'Já vejo pra você', status: 'read', enviada_em: '2026-10-19T21:20:00Z' },
  { wamid: 'w4', direcao: 'saida', tipo: null, texto: null, status: 'delivered', enviada_em: '2026-10-19T21:18:00Z' },
];
const vi = [
  { msg_id: 'a', role: 'user', texto: 'oi,  cadê meu pedido?', created_at: '2026-10-19T21:16:43Z' },
  { msg_id: 'b', role: 'user', texto: '[imagem]', created_at: '2026-10-19T21:17:02Z' },
  { msg_id: 'c', role: 'assistant', texto: 'Oi! Sou a Vi', created_at: '2026-10-19T21:16:57Z' },
  { msg_id: 'op_w3', role: 'operador', texto: 'Já vejo pra você', created_at: '2026-10-19T21:20:01Z' },
  { msg_id: 'd', role: 'assistant', texto: '[contexto interno: Pix pendente]', created_at: '2026-10-19T10:00:00Z' },
  { msg_id: 'e', role: 'user', texto: 'mensagem antiga', created_at: '2026-10-18T10:00:00Z' },
  { msg_id: 'f', role: 'operador', texto: 'respondi pelo Wati', created_at: '2026-10-18T11:00:00Z' },
];
const conv = W.mesclar(wa, vi);
ok('mesma fala pelas duas fontes aparece uma vez', conv.filter(m => /cadê meu pedido/i.test(m.texto || '')).length, 1);
ok('foto da Meta substitui o [imagem] do Wati', conv.filter(m => m.lado === 'cliente' && m.quando.startsWith('2026-10-19T21:17')).map(m => m.id), ['w2']);
ok('envio do painel não duplica com o histórico da Vi', conv.filter(m => m.texto === 'Já vejo pra você').map(m => m.id), ['w3']);
ok('status sem texto (Wati) fica de fora', conv.some(m => m.id === 'w4'), false);
ok('lados', conv.map(m => m.lado), ['cliente', 'equipe', 'auto', 'cliente', 'vi', 'cliente', 'equipe']);
ok('ordem por hora', conv.map(m => m.id), ['e', 'f', 'd', 'w1', 'c', 'w2', 'w3']);
// Etapa 3: o que a Vi e os templates mandam pela Meta também está em wa_mensagens (com origem).
const conv3 = W.mesclar([
  { wamid: 'v1', direcao: 'saida', tipo: 'text', texto: 'Oi! Sou a Vi', origem: 'vi', status: 'read', enviada_em: '2026-10-20T10:00:00Z' },
  { wamid: 't1', direcao: 'saida', tipo: 'template', texto: 'Oi Ana! Pedido nº 9300 confirmado.', origem: 'template', enviada_em: '2026-10-20T09:00:00Z' },
], [
  { msg_id: 'bot_fila_1', role: 'assistant', texto: 'Oi!  Sou a Vi', created_at: '2026-10-20T10:00:01Z' },
  { msg_id: 'pedido_conf_1', role: 'assistant', texto: '[contexto interno: enviei a confirmação]', created_at: '2026-10-20T09:00:00Z' },
  { msg_id: 'bot_fila_2', role: 'assistant', texto: 'Outra fala da Vi', created_at: '2026-10-20T11:00:00Z' },
]);
ok('fala da Vi pela Meta aparece uma vez, como Vi e com tique', conv3.filter(m => /Sou a Vi/.test(m.texto)).map(m => [m.id, m.lado, m.status]), [['v1', 'vi', 'read']]);
ok('template aparece com o texto que a cliente viu e esconde a nota interna', conv3.filter(m => m.lado === 'auto').map(m => m.id), ['t1']);
ok('fala da Vi sem par na Meta continua', conv3.some(m => m.id === 'bot_fila_2' && m.lado === 'vi'), true);

const agoraT = Date.parse('2026-10-20T21:00:00Z');
ok('janela aberta com 23h', W.janelaAberta('2026-10-19T22:00:00Z', agoraT), true);
ok('janela fechada com 25h', W.janelaAberta('2026-10-19T20:00:00Z', agoraT), false);
ok('sem mensagem dela, janela fechada', W.janelaAberta(null, agoraT), false);

console.log('\n4) Envio');
const API = await import(pathToFileURL(join(raiz, 'functions', 'api', 'whatsapp.js')).href);
let feitas = [];
let convResp = [{ telefone: '556293161442', ultima_entrada_em: new Date(Date.now() - 3600e3).toISOString() }];
let metaResp = { status: 200, corpo: { messages: [{ id: 'wamid.NOVO' }] } };
globalThis.fetch = async (u, o = {}) => {
  u = String(u);
  feitas.push({ u, m: o.method || 'GET', b: o.body ? JSON.parse(o.body) : null, h: o.headers });
  if (u.includes('graph.facebook.com')) return new Response(JSON.stringify(metaResp.corpo), { status: metaResp.status });
  if (u.includes('/wa_conversas?')) return new Response(JSON.stringify(convResp), { status: 200 });
  if (u.includes('/wati_ia_sessions?wa_id=')) return new Response(JSON.stringify([{ wa_id: '5562993161442' }]), { status: 200 });
  return new Response('', { status: 201 });
};
const envE = { SUPABASE_SERVICE_ROLE_KEY: 'srv', META_ACCESS_TOKEN: 'tok', WA_ENVIO_PAINEL: '1' };
const post = corpo => API.onRequest({ request: new Request('https://x/api/whatsapp', { method: 'POST', body: JSON.stringify(corpo) }), env: envE });

// Envio desligado (padrão desde 19/10/2026, a Meta não estava entregando): nada sai, nada pausa.
r = await API.onRequest({ request: new Request('https://x/api/whatsapp', { method: 'POST', body: JSON.stringify({ acao: 'enviar', tel: '556293161442', texto: 'oi' }) }), env: { ...envE, WA_ENVIO_PAINEL: undefined } });
ok('sem WA_ENVIO_PAINEL o envio fica desligado', [r.status, (await r.json()).erro, feitas.length], [503, 'envio desligado', 0]);
r = await API.onRequest({ request: new Request('https://x/api/whatsapp?acao=conversas'), env: { ...envE, WA_ENVIO_PAINEL: undefined } });
ok('a lista avisa a tela que o envio está desligado', (await r.json()).envio, false);
r = await post({ acao: 'enviar', tel: '5562993161442', texto: '  Oi, vou ver seu pedido agora  ' });
let d = await r.json();
ok('envio ok', [r.status, d.ok, d.wamid], [200, true, 'wamid.NOVO']);
const meta = feitas.find(f => f.u.includes('graph.facebook.com'));
ok('manda pro telefone que a Meta usa, texto aparado', [meta.b.to, meta.b.text.body, meta.h.Authorization], ['556293161442', 'Oi, vou ver seu pedido agora', 'Bearer tok']);
// sem a conta, a Meta escolhia a 4436 (sem cartão) e nada era entregue (21/10/2026)
ok('sai pela conta de mensagens 925', meta.b.messaging_account_id, '925433550103556');
const gw = feitas.find(f => f.u.includes('/wa_mensagens?') && f.m === 'POST');
ok('grava a saída', [gw.b[0].wamid, gw.b[0].direcao, gw.b[0].texto], ['wamid.NOVO', 'saida', 'Oi, vou ver seu pedido agora']);
const pausa = feitas.find(f => f.u.includes('/wati_ia_sessions?on_conflict'));
ok('pausa a Vi na grafia que ela usa', pausa.b.map(s => s.wa_id), ['5562993161442']);
ok('pausa de 24h', Math.round((Date.parse(pausa.b[0].pausada_ate) - Date.now()) / 3600e3), 24);
const hist = feitas.find(f => f.u.includes('/wati_ia_mensagens'));
ok('fala entra no histórico da Vi como operador', [hist.b.msg_id, hist.b.wa_id, hist.b.role], ['op_wamid.NOVO', '5562993161442', 'operador']);

feitas = [];
convResp = [{ telefone: '556293161442', ultima_entrada_em: new Date(Date.now() - 25 * 3600e3).toISOString() }];
r = await post({ acao: 'enviar', tel: '556293161442', texto: 'oi' });
d = await r.json();
ok('janela fechada não envia', [r.status, d.erro, feitas.some(f => f.u.includes('graph.facebook.com'))], [409, 'janela', false]);

feitas = [];
convResp = [{ telefone: '556293161442', ultima_entrada_em: new Date().toISOString() }];
metaResp = { status: 400, corpo: { error: { message: 'Recipient not in allowed list' } } };
r = await post({ acao: 'enviar', tel: '556293161442', texto: 'oi' });
d = await r.json();
ok('Meta recusou: não grava nem pausa', [r.status, feitas.some(f => f.u.includes('wati_ia_sessions'))], [502, false]);
r = await post({ acao: 'enviar', tel: '556293161442', texto: '   ' });
ok('texto vazio', r.status, 400);

// ── Foto e documento pela equipe (passo 2 da saída do Wati, 21/10/2026) ─────
// O arquivo chega cru e sobe para a Meta antes da mensagem; se algo barrar, nada pode subir nem sair.
convResp = [{ telefone: '556293161442', ultima_entrada_em: new Date(Date.now() - 3600e3).toISOString() }];
let uploads = [];
feitas = [];
globalThis.fetch = async (u, o = {}) => {
  u = String(u);
  if (u.endsWith('/media')) { uploads.push(o.body); return new Response(JSON.stringify({ id: '7771234567' }), { status: 200 }); }
  feitas.push({ u, m: o.method || 'GET', b: typeof o.body === 'string' ? JSON.parse(o.body) : null });
  if (u.includes('graph.facebook.com')) return new Response(JSON.stringify({ messages: [{ id: 'wamid.FOTO' }] }), { status: 200 });
  if (u.includes('/wa_conversas?')) return new Response(JSON.stringify(convResp), { status: 200 });
  if (u.includes('/wati_ia_sessions?wa_id=')) return new Response(JSON.stringify([{ wa_id: '5562993161442' }]), { status: 200 });
  return new Response('', { status: 201 });
};
const midia = (params, corpoArq, tipo, e = envE) => API.onRequest({ request: new Request('https://x/api/whatsapp?' + new URLSearchParams({ acao: 'enviar-midia', ...params }), { method: 'POST', headers: { 'Content-Type': tipo }, body: corpoArq }), env: e });
const jpg = new Uint8Array(2048).fill(7);
r = await midia({ tel: '5562993161442', nome: 'foto.jpg', legenda: 'Olha a cor' }, jpg, 'image/jpeg');
d = await r.json();
ok('foto: envio ok', [r.status, d.ok, d.tipo, d.midia_id], [200, true, 'image', '7771234567']);
const fd = uploads[0];
ok('foto sobe para a Meta com o arquivo', [fd instanceof FormData, fd.get('messaging_product'), fd.get('type'), fd.get('file').size, fd.get('file').name], [true, 'whatsapp', 'image/jpeg', 2048, 'foto.jpg']);
const msgFoto = feitas.find(f => f.u.endsWith('/messages'));
ok('vai como imagem, com legenda e pela conta 925', [msgFoto.b.type, msgFoto.b.image, msgFoto.b.messaging_account_id, msgFoto.b.to], ['image', { id: '7771234567', caption: 'Olha a cor' }, '925433550103556', '556293161442']);
const gm = feitas.find(f => f.u.includes('/wa_mensagens?') && f.m === 'POST');
ok('grava a foto na conversa', [gm.b[0].tipo, gm.b[0].midia_id, gm.b[0].texto, gm.b[0].origem], ['image', '7771234567', 'Olha a cor', 'painel']);
ok('pausa a Vi', feitas.some(f => f.u.includes('/wati_ia_sessions?on_conflict')), true);
ok('a Vi fica sabendo da foto no histórico', feitas.find(f => f.u.includes('/wati_ia_mensagens')).b.texto, '[a equipe mandou uma foto] Olha a cor');

feitas = []; uploads = [];
r = await midia({ tel: '5562993161442', nome: 'nota-9300.pdf' }, new Uint8Array(500), 'application/pdf');
const msgDoc = feitas.find(f => f.u.endsWith('/messages'));
ok('documento vai com o nome do arquivo', [r.status, msgDoc.b.type, msgDoc.b.document], [200, 'document', { id: '7771234567', filename: 'nota-9300.pdf' }]);
ok('histórico do documento', feitas.find(f => f.u.includes('/wati_ia_mensagens')).b.texto, '[a equipe mandou o documento nota-9300.pdf]');

feitas = []; uploads = [];
r = await midia({ tel: '5562993161442', nome: 'x.exe' }, new Uint8Array(10), 'application/x-msdownload');
ok('tipo de arquivo recusado', [r.status, uploads.length], [415, 0]);
r = await midia({ tel: '5562993161442', nome: 'grande.jpg' }, new Uint8Array(5 * 1024 * 1024 + 1), 'image/jpeg');
ok('foto acima de 5 MB recusada sem subir', [r.status, uploads.length], [413, 0]);
r = await midia({ tel: '5562993161442', nome: 'f.jpg' }, jpg, 'image/jpeg', { ...envE, WA_ENVIO_PAINEL: undefined });
ok('com o envio desligado nada sobe', [r.status, uploads.length], [503, 0]);
convResp = [{ telefone: '556293161442', ultima_entrada_em: new Date(Date.now() - 25 * 3600e3).toISOString() }];
r = await midia({ tel: '5562993161442', nome: 'f.jpg' }, jpg, 'image/jpeg');
ok('janela fechada: nada sobe', [r.status, uploads.length], [409, 0]);

// ── Modelo aprovado fora das 24 h (passo 3, 21/10/2026) ─────────────────────
// Depois de 24 h só sai template. A equipe só vê os da lista MODELOS_EQUIPE que estão aprovados na conta 925, e o
// template não pode sair com campo vazio nem com o número de campos trocado (nome no lugar do pedido).
const tplMeta = [
  { name: 'continuidade_solicitacao_v1', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Olá, {{1}}! Estamos dando continuidade à sua solicitação: {{2}}.' }] },
  { name: 'pedido_despachado_vi', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Oii {{1}}, pedido {{2}}, rastreio {{3}}.' }] },
  { name: 'pix_link_v1', language: 'pt_BR', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'Oi {{1}} {{2}}' }] },
  { name: 'recuperacao_oii_v1', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Oiii {{1}}, tudo bem? {{2}}' }] }, // mudou na Meta: 2 campos
  { name: 'alerta_interno_vi', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Alerta {{1}}' }] },
];
feitas = [];
convResp = [{ telefone: '556293161442', ultima_entrada_em: new Date(Date.now() - 3 * 86400e3).toISOString() }];
globalThis.fetch = async (u, o = {}) => {
  u = String(u);
  feitas.push({ u, m: o.method || 'GET', b: typeof o.body === 'string' ? JSON.parse(o.body) : null });
  if (u.includes('/message_templates')) return new Response(JSON.stringify({ data: tplMeta }), { status: 200 });
  if (u.includes('graph.facebook.com')) return new Response(JSON.stringify({ messages: [{ id: 'wamid.MODELO' }] }), { status: 200 });
  if (u.includes('/wa_conversas?')) return new Response(JSON.stringify(convResp), { status: 200 });
  if (u.includes('/wati_ia_sessions?wa_id=')) return new Response(JSON.stringify([{ wa_id: '5562993161442' }]), { status: 200 });
  return new Response('', { status: 201 });
};
r = await API.onRequest({ request: new Request('https://x/api/whatsapp?acao=modelos'), env: envE });
const mods = (await r.json()).modelos;
ok('lista só os liberados e aprovados, na ordem da equipe', mods.map(m => m.nome), ['continuidade_solicitacao_v1', 'pedido_despachado_vi']);
ok('templates procurados na conta 925', feitas.some(f => f.u.includes('/925433550103556/message_templates')), true);
ok('cada modelo vem com nome fácil e os campos', [mods[0].rotulo, mods[0].campos.length, mods[0].categoria], ['Retomar o atendimento', 2, 'UTILITY']);

feitas = [];
r = await post({ acao: 'enviar-modelo', tel: '5562993161442', modelo: 'continuidade_solicitacao_v1', valores: ['Ana', 'a troca do pedido 9300\nque chegou'] });
d = await r.json();
ok('modelo sai mesmo com a janela fechada', [r.status, d.ok, d.wamid], [200, true, 'wamid.MODELO']);
const msgMod = feitas.find(f => f.u.endsWith('/messages'));
ok('vai como template, pela 925, campos por posição e sem quebra de linha', [msgMod.b.type, msgMod.b.messaging_account_id, msgMod.b.template.name, msgMod.b.template.language.code, msgMod.b.template.components[0].parameters.map(p => p.text)],
  ['template', '925433550103556', 'continuidade_solicitacao_v1', 'pt_BR', ['Ana', 'a troca do pedido 9300 / que chegou']]);
const gmMod = feitas.find(f => f.u.includes('/wa_mensagens?') && f.m === 'POST');
ok('grava o texto que a cliente vê', [gmMod.b[0].tipo, gmMod.b[0].texto, gmMod.b[0].origem], ['template', 'Olá, Ana! Estamos dando continuidade à sua solicitação: a troca do pedido 9300 / que chegou.', 'painel']);
ok('pausa a Vi e conta para ela', [feitas.some(f => f.u.includes('/wati_ia_sessions?on_conflict')), feitas.find(f => f.u.includes('/wati_ia_mensagens')).b.texto.startsWith('Olá, Ana!')], [true, true]);

feitas = [];
r = await post({ acao: 'enviar-modelo', tel: '5562993161442', modelo: 'alerta_interno_vi', valores: ['x'] });
ok('modelo fora da lista da equipe: nada sai', [r.status, feitas.some(f => f.u.endsWith('/messages'))], [400, false]);
r = await post({ acao: 'enviar-modelo', tel: '5562993161442', modelo: 'pedido_despachado_vi', valores: ['Ana', '9300', '  '] });
ok('campo vazio: nada sai', [r.status, feitas.some(f => f.u.endsWith('/messages'))], [400, false]);
r = await post({ acao: 'enviar-modelo', tel: '5562993161442', modelo: 'pix_link_v1', valores: ['Ana', 'https://x'] });
ok('modelo ainda não aprovado: nada sai', [r.status, feitas.some(f => f.u.endsWith('/messages'))], [409, false]);
r = await API.onRequest({ request: new Request('https://x/api/whatsapp', { method: 'POST', body: JSON.stringify({ acao: 'enviar-modelo', tel: '5562993161442', modelo: 'continuidade_solicitacao_v1', valores: ['Ana', 'x'] }) }), env: { ...envE, WA_ENVIO_PAINEL: undefined } });
ok('com o envio desligado o modelo não sai', [r.status, feitas.some(f => f.u.endsWith('/messages'))], [503, false]);

// ── Devolver para a Vi e Resolvida (passo 4, 21/10/2026) ───────────────────
// Não mandam nada para a cliente. Resolvida faz o mesmo que o "fechar" do Wati: status solved e a resposta da Vi
// que estava na fila não sai mais; a conversa sai da lista de esperando até a cliente escrever de novo.
feitas = [];
convResp = [{ telefone: '556293161442' }];
globalThis.fetch = async (u, o = {}) => {
  u = String(u);
  feitas.push({ u, m: o.method || 'GET', b: typeof o.body === 'string' ? JSON.parse(o.body) : null });
  if (u.includes('/wa_conversas?')) return new Response(JSON.stringify(convResp), { status: 200 });
  if (u.includes('/wati_ia_sessions?wa_id=')) return new Response(JSON.stringify([{ wa_id: '5562993161442' }, { wa_id: '556293161442' }]), { status: 200 });
  return new Response('', { status: 201 });
};
const envDesligado = { ...envE, WA_ENVIO_PAINEL: undefined };
const acaoVi = (acao, tel = '5562993161442') => API.onRequest({ request: new Request('https://x/api/whatsapp', { method: 'POST', body: JSON.stringify({ acao, tel }) }), env: envDesligado });
r = await acaoVi('devolver');
d = await r.json();
const sDev = feitas.find(f => f.u.includes('/wati_ia_sessions?on_conflict'));
ok('devolver: funciona com o envio desligado e volta a Vi nas duas grafias', [r.status, d.status_vi, sDev.b.map(x => [x.wa_id, x.status, x.pausada_ate, x.handoff_motivo])],
  [200, 'ativa', [['5562993161442', 'ativa', null, null], ['556293161442', 'ativa', null, null]]]);
ok('devolver não mexe na fila nem manda nada', feitas.some(f => f.u.includes('wati_ia_fila') || f.u.includes('graph.facebook.com')), false);
feitas = [];
r = await acaoVi('resolver');
d = await r.json();
const sRes = feitas.find(f => f.u.includes('/wati_ia_sessions?on_conflict'));
const fila = feitas.find(f => f.u.includes('/wati_ia_fila'));
ok('resolver: sessão solved e sem pausa', [r.status, d.status_vi, sRes.b.map(x => [x.status, x.pausada_ate])], [200, 'solved', [['solved', null], ['solved', null]]]);
ok('resolver: resposta da Vi na fila não sai mais', [fila.m, fila.u.includes('wa_id=in.(5562993161442,556293161442)'), fila.u.includes('enviado_at=is.null'), fila.b.erro], ['PATCH', true, true, 'cancelado: conversa resolvida pela equipe no painel']);
ok('resolver não manda nada para a cliente', feitas.some(f => f.u.includes('graph.facebook.com')), false);
r = await acaoVi('apagar');
ok('ação desconhecida', r.status, 400);
convResp = [];
r = await acaoVi('resolver', '5511999990000');
ok('conversa que não existe', r.status, 404);
feitas = [];
await W.listarConversas({ SUPABASE_SERVICE_ROLE_KEY: 'x' }, { filtro: 'aguardando' });
ok('esperando não traz as resolvidas', decodeURIComponent(feitas[0].u).includes('or=(status_vi.is.null,status_vi.neq.solved)') && feitas[0].u.includes('ultima_direcao=eq.entrada'), true);

ok('foto da equipe sem legenda aparece na conversa', W.mesclar([{ wamid: 'w9', direcao: 'saida', tipo: 'image', texto: null, midia_id: '777', origem: 'painel', enviada_em: '2026-10-21T19:00:00Z' }], []).map(m => [m.lado, m.tipo, m.midia_id]), [['equipe', 'image', '777']]);
ok('status sem texto nem mídia continua fora da conversa', W.mesclar([{ wamid: 'w8', direcao: 'saida', texto: null, midia_id: null, enviada_em: '2026-10-21T19:00:00Z' }], []).length, 0);

r = await API.onRequest({ request: new Request('https://x/api/whatsapp?acao=midia&id=../x'), env: envE });
ok('id de mídia inválido', r.status, 400);
ok('rota da caixa NÃO é pública', mid.includes("'/api/whatsapp'"), false);

const html = readFileSync(join(raiz, 'whatsapp.html'), 'utf8');
ok('tela sem travessão', /—/.test(html.replace(/<!--[\s\S]*?-->/g, '')), false);
const idx = readFileSync(join(raiz, 'index.html'), 'utf8');
const mainJs = readFileSync(join(raiz, 'main.js'), 'utf8');
ok('pílula Vi - atendimento no ATENDIMENTO', idx.includes("atdShowSub('whats')\"><i class=\"ti ti-brand-whatsapp\"></i> Vi - atendimento<") && idx.includes('id="atd-sub-whats"'), true);
ok('pílula em primeiro (pedido da Bárbara)', idx.indexOf('id="atd-pill-whats"') < idx.indexOf('id="atd-pill-kanban"'), true);
ok('lista pede os pendentes', readFileSync(join(raiz, 'functions', '_whatsapp.js'), 'utf8').includes('ultima_entrada_em,pendentes'), true);
ok('atdShowSub conhece a pílula', mainJs.includes("'casos', 'whats']"), true);
ok('ATENDIMENTO abre em Vi - atendimento', [mainJs.includes("const ATD_SUB_INICIAL = 'whats'"), (mainJs.match(/atdShowSub\(ATD_SUB_INICIAL\)/g) || []).length, mainJs.includes("atdShowSub('sac')")], [true, 3, false]);

console.log(`\n${total - falhas}/${total} ok`);
if (falhas) process.exit(1);
