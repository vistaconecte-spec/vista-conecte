/**
 * Aviso do código de postagem no WhatsApp (/api/troca-aviso, 20/10/2026).
 *
 * O modelo da Meta foi recusado 4 vezes ("categoria incorreta"); até aprovar, a cliente que falou
 * com a loja nas últimas 24 h recebe como mensagem comum, com o texto que a Bárbara aprovou, e fora
 * disso a mensagem fica pronta no cartão. Trava: janela de 24 h, nunca mandar duas vezes, texto sem
 * travessão, número com e sem o 9, e o registro no histórico da Vi.
 *
 * Rodar:  node tests/troca-aviso.test.mjs
 */
import { onRequestPost, textoConversa, variantesWa, dentroDaJanela, proximaAbertura } from '../functions/api/troca-aviso.js';

let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

console.log('\n1) Texto e telefone');
{
  const t = textoConversa({ nome: 'Lais Jarilho', pedido: '#9250', codigo: '4665143571', validade: '2026-10-30T15:00:00Z' });
  ok('texto aprovado por ela', t, 'Oi Lais, sua troca do pedido #9250 está liberada. O código de postagem dos Correios é 4665143571 e vale até 30/10/2026. É só levar a peça embalada a uma agência e informar esse código, não precisa imprimir etiqueta nem pagar frete.');
  ok('sem travessão', /—/.test(t), false);
  ok('crédito não fala em troca (Karina #9185, 22/10)', /troca/.test(textoConversa({ nome: 'Karina', pedido: '#9185', codigo: 'X', tipo: 'credito' })), false);
  ok('crédito diz que vira crédito na loja', /vai virar crédito na loja/.test(textoConversa({ nome: 'Karina', pedido: '#9185', codigo: 'X', tipo: 'credito' })), true);
  ok('sem validade, não inventa data', /vale até/.test(textoConversa({ nome: 'A', pedido: '#1', codigo: 'X' })), false);
  ok('com e sem o 9', variantesWa('(11) 98507-4682'), ['5511985074682', '551185074682']);
  const agora = Date.parse('2026-10-20T15:00:00Z');
  ok('falou há 3 h: dentro da janela', dentroDaJanela('2026-10-20T12:00:00Z', agora), true);
  ok('falou há 30 h: fora', dentroDaJanela('2026-10-19T09:00:00Z', agora), false);
  ok('nunca falou: fora', dentroDaJanela(null, agora), false);
}

function cenario({ ultima, templateStatus, jaEnviado = false, outraPeca = false, continuidade = false, jaAberta = false, aberturas = null }) {
  const chamadas = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    chamadas.push({ u, metodo: opts.method || 'GET', corpo: opts.body });
    if (u.includes('graphql.json')) return new Response(JSON.stringify({ data: { orders: { nodes: [{ name: '#9250', phone: null, shippingAddress: { firstName: 'Lais', name: 'Lais Jarilho', phone: '+55 11 98507-4682' }, customer: null }] } } }));
    if (u.includes('msg_id=like.troca_abrir_')) return new Response(JSON.stringify(aberturas || (jaAberta ? [{ msg_id: 'troca_abrir_9250', created_at: new Date().toISOString() }] : [])));
    if (u.includes('msg_id=eq.')) return new Response(JSON.stringify(jaEnviado ? [{ msg_id: 'x', created_at: '2026-10-20T10:00:00Z' }] : []));
    if (u.includes('/message_templates') && u.includes('continuidade')) return new Response(JSON.stringify({ data: continuidade ? [{ name: 'continuidade_solicitacao_v1', language: 'pt_BR', status: 'APPROVED', components: [{ type: 'BODY', text: 'Olá, {{1}}! Estamos dando continuidade à sua solicitação: {{2}}.' }] }] : [] }));
    if (u.includes('msg_id=like.troca_codigo_') && u.includes('4665143571')) return new Response(JSON.stringify(outraPeca ? [{ msg_id: 'troca_codigo_retorno:p0', created_at: '2026-10-28T20:16:46Z' }] : []));
    if (u.includes('role=eq.user')) return new Response(JSON.stringify(ultima ? [{ wa_id: '5511985074682', created_at: ultima }] : []));
    if (u.includes('/message_templates')) return new Response(JSON.stringify({ data: templateStatus ? [{ name: 'troca_autorizacao_postagem_v1', language: 'pt_BR', status: templateStatus, components: [{ type: 'BODY', text: 'Oii {{1}}, pedido {{2}}, autorização {{3}}, válido até {{4}}.' }] }] : [] }));
    if (/graph\.facebook\.com\/.*\/media$/.test(u)) return new Response(JSON.stringify({ id: 'midia1' }));
    if (/graph\.facebook\.com\/.*\/messages$/.test(u)) return new Response(JSON.stringify({ messages: [{ id: 'wamid.T' }] }));
    if ((opts.method || '') === 'POST' && u.includes('wati_ia_mensagens')) return new Response(null, { status: 201 });
    return new Response('{}');
  };
  return chamadas;
}
const env = { SHOPIFY_STORE_DOMAIN: 'l', SHOPIFY_ADMIN_TOKEN: 't', SUPABASE_SERVICE_ROLE_KEY: 's', META_ACCESS_TOKEN: 'm' };
const envios = ch => ch.filter(c => /graph\.facebook\.com\/.*\/messages$/.test(c.u)).map(c => JSON.parse(c.corpo));
const chamar = async (extra = {}) => { const r = await onRequestPost({ env, request: new Request('https://x', { method: 'POST', body: JSON.stringify({ pedido: '#9250', codigo: '4665143571', validade: '2026-10-30T15:00:00Z', item_id: 'retorno:p1', ...extra }) }) }); return r.json(); };

console.log('\n2) Envio');
{
  const ch = cenario({ ultima: new Date(Date.now() - 2 * 3600e3).toISOString() });
  const j = await chamar();
  ok('dentro das 24 h: vai como conversa', [j.enviado, j.via], [true, 'conversa']);
  ok('sai pela Meta como texto, para o número da conversa', [envios(ch).length, envios(ch)[0].type, envios(ch)[0].to], [1, 'text', '5511985074682']);
  ok('grava no histórico da Vi como mensagem do sistema', ch.some(c => c.metodo === 'POST' && c.u.includes('wati_ia_mensagens') && /troca_codigo_retorno:p1/.test(c.corpo || '') && /"role":"assistant"/.test(c.corpo || '')), true);
}
{
  const ch = cenario({ ultima: new Date(Date.now() - 40 * 3600e3).toISOString(), templateStatus: 'REJECTED' });
  const j = await chamar();
  ok('fora das 24 h e modelo recusado: não manda e devolve a mensagem', [j.enviado, j.motivo, /4665143571/.test(j.mensagem || '')], [false, 'fora_da_janela', true]);
  ok('não mandou nada pela Meta', envios(ch).length, 0);
}
{
  const ch = cenario({ ultima: new Date(Date.now() - 40 * 3600e3).toISOString(), templateStatus: 'REJECTED', continuidade: true });
  const j = await chamar();
  const t = (envios(ch)[0] || {}).template || {};
  ok('fora das 24 h sem modelo da troca: abre a conversa pelo modelo de continuidade (11/11)', [j.enviado, j.conversa_aberta, t.name, t.components && t.components[0].parameters.map(p => p.text)], [false, true, 'continuidade_solicitacao_v1', ['Lais', 'troca do pedido #9250']]);
  ok('grava no histórico da Vi que o código chega quando ela responder', ch.some(c => c.metodo === 'POST' && /troca_abrir_9250/.test(c.corpo || '') && /código chega sozinho/.test(c.corpo || '')), true);
}
{
  const ch = cenario({ ultima: new Date(Date.now() - 40 * 3600e3).toISOString(), templateStatus: 'REJECTED', continuidade: true, jaAberta: true });
  const j = await chamar();
  ok('a mensagem de abrir a conversa vai uma vez só por pedido', [j.conversa_aberta, envios(ch).length], ['ja_pedida', 0]);
}
{
  const ch = cenario({ ultima: null, templateStatus: 'APPROVED' });
  const j = await chamar();
  ok('fora das 24 h com modelo aprovado: vai pelo modelo', [j.enviado, j.via], [true, 'modelo']);
  const t = (envios(ch)[0] || {}).template || {};
  ok('modelo leva nome, pedido, código e validade', [t.name, t.components && t.components[0].parameters.map(p => p.text)], ['troca_autorizacao_postagem_v1', ['Lais', '9250', '4665143571', '30/10/2026']]);
}
{
  const ch = cenario({ ultima: new Date().toISOString(), jaEnviado: true });
  const j = await chamar();
  ok('já mandado: não manda de novo', [j.enviado, j.ja_enviado, envios(ch).length], [true, true, 0]);
}
{
  const ch = cenario({ ultima: new Date().toISOString(), outraPeca: true });
  const j = await chamar();
  ok('2ª peça com o mesmo código: não manda de novo (Taís #9015, 28/10)', [j.enviado, j.ja_enviado, envios(ch).length], [true, true, 0]);
}

console.log('\n3) Sem depender de ninguém (13/11/2026)');
{
  const agora = Date.parse('2026-11-13T15:00:00Z');
  const dia = n => new Date(agora - n * 86400e3).toISOString();
  ok('nunca abriu: abre', proximaAbertura('troca_abrir_9250', [], agora), 'troca_abrir_9250');
  ok('abriu há 1 dia: espera', proximaAbertura('troca_abrir_9250', [{ msg_id: 'troca_abrir_9250', created_at: dia(1) }], agora), null);
  ok('abriu há 3 dias e ela não respondeu: manda de novo', proximaAbertura('troca_abrir_9250', [{ msg_id: 'troca_abrir_9250', created_at: dia(3.1) }], agora), 'troca_abrir_9250_2');
  ok('já foram 3: para', proximaAbertura('troca_abrir_9250', [{ msg_id: 'troca_abrir_9250', created_at: dia(9) }, { msg_id: 'troca_abrir_9250_2', created_at: dia(6) }, { msg_id: 'troca_abrir_9250_3', created_at: dia(3.5) }], agora), null);
  ok('pedido de número parecido não conta (92501)', proximaAbertura('troca_abrir_9250', [{ msg_id: 'troca_abrir_92501', created_at: dia(1) }], agora), 'troca_abrir_9250');
  const tc = textoConversa({ nome: 'Ester', pedido: '#9232', codigo: 'AP1BR', tipo: 'credito', comum: true });
  ok('etiqueta comum: manda imprimir e diz que o frete está pago', [/imprimir/.test(tc), /frete já está pago/.test(tc), /não precisa imprimir/.test(tc)], [true, true, false]);
  ok('renovado: diz que é o último', /é o último/.test(textoConversa({ nome: 'A', pedido: '#1', codigo: 'X', renovado: true })), true);
}
{
  const ch = cenario({ ultima: new Date(Date.now() - 40 * 3600e3).toISOString(), templateStatus: 'REJECTED', continuidade: true,
    aberturas: [{ msg_id: 'troca_abrir_9250', created_at: new Date(Date.now() - 4 * 86400e3).toISOString() }] });
  const j = await chamar();
  ok('3 dias sem resposta: o modelo de continuidade vai de novo', [j.conversa_aberta, envios(ch).length, ch.some(c => c.metodo === 'POST' && /troca_abrir_9250_2/.test(c.corpo || ''))], [true, 1, true]);
}
{
  const ch = cenario({ ultima: new Date(Date.now() - 2 * 3600e3).toISOString() });
  const j = await chamar({ comum: true, pdf_b64: Buffer.from('%PDF-1.4 teste').toString('base64') });
  const e = envios(ch)[0] || {};
  ok('etiqueta comum na janela: vai o PDF com o texto de legenda', [j.enviado, e.type, e.document && e.document.filename, /imprimir/.test(e.document && e.document.caption)], [true, 'document', 'etiqueta-devolucao-9250.pdf', true]);
}
{
  const ch = cenario({ ultima: new Date(Date.now() - 2 * 3600e3).toISOString() });
  const j = await chamar({ comum: true });
  ok('etiqueta comum sem PDF: não manda texto sem a etiqueta', [j.enviado, j.motivo, envios(ch).length], [false, 'sem_pdf', 0]);
}
{
  const ch = cenario({ ultima: new Date(Date.now() - 40 * 3600e3).toISOString(), templateStatus: 'APPROVED', continuidade: true });
  const j = await chamar({ comum: true, pdf_b64: Buffer.from('%PDF-1.4').toString('base64') });
  const t = (envios(ch)[0] || {}).template || {};
  ok('etiqueta comum fora da janela: abre a conversa, nunca manda o modelo sem o PDF', [j.enviado, t.name], [false, 'continuidade_solicitacao_v1']);
}
{
  const ch = cenario({ ultima: new Date().toISOString(), jaEnviado: false });
  const j = await chamar({ renovado: true });
  ok('código renovado tem aviso próprio', [j.enviado, ch.some(c => c.metodo === 'POST' && /troca_codigo_retorno:p1_renovado/.test(c.corpo || ''))], [true, true]);
}

console.log(falhas ? `\n✗ ${falhas} de ${total} falharam` : `\n✓ TODOS OS TESTES PASSARAM — ${total}/${total}`);
if (falhas) process.exit(1);
