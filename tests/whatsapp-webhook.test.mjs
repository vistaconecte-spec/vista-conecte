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

globalThis.fetch = async () => new Response('fora', { status: 503 });
r = await req(`${base}?k=chave`, { method: 'POST', body: txt });
ok('banco fora devolve 500 pra Meta reenviar', r.status, 500);

console.log(`\n${total - falhas}/${total} ok`);
if (falhas) process.exit(1);
