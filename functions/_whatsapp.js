/**
 * WhatsApp oficial direto na Meta (Cloud API), sem o Wati no meio.
 *
 * ETAPA 1 (19/10/2026): só RECEBER. O app Meta "claude" (1007187805378924, portfólio CONECTE)
 * fica inscrito na WABA 838934162193647 em paralelo com o Wati, e cada aviso da Meta é gravado
 * em wa_mensagens / wa_eventos (sql/wa-mensagens.sql). Ninguém responde por aqui ainda: a Vi e
 * a equipe continuam no Wati até a gente conferir que chega tudo igual.
 *
 * O número é da loja (dono da WABA = CONECTE, platform_type CLOUD_API), então dois apps podem
 * ouvir o mesmo número ao mesmo tempo. Só que a Meta NÃO manda eco do que o outro app envia:
 * do que o Wati/Vi mandam, aqui só aparece o status (sent/delivered/read), sem o texto.
 */
import { SB_URL } from './_bling.js';
import { casoDeDinheiro } from './_casos.js';

export const WABA_ID = '838934162193647';
export const PHONE_NUMBER_ID = '910542668806764';
// Desde a "Account Model Evolution" da Meta (out/2026) o número é compartilhado por várias contas de mensagens
// (838 = Wati, 4436 e 925 = criadas pelo app da Shopify). A 838 só aceita envio do app do Wati; sem dizer qual
// usar, a Meta escolhia a 4436 (sem cartão) e nada era entregue. A nossa é a 925: cartão dela, templates
// copiados da 838 e o app "claude" inscrito. Teste entregue em 21/10/2026.
export const CONTA_MENSAGENS_ID = '925433550103556';

const RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

export function igual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const quando = ts => (ts ? new Date(Number(ts) * 1000).toISOString() : null);

// Texto legível de qualquer tipo de mensagem: o que a equipe veria no balão.
export function textoDa(m) {
  const t = m.type;
  if (t === 'text') return (m.text && m.text.body) || '';
  if (['image', 'video', 'document', 'audio', 'sticker'].includes(t)) {
    const x = m[t] || {};
    return x.caption || x.filename || null;
  }
  if (t === 'button') return (m.button && (m.button.text || m.button.payload)) || null;
  if (t === 'interactive') {
    const i = m.interactive || {};
    const r = i.button_reply || i.list_reply || i.nfm_reply;
    return (r && (r.title || r.body)) || null;
  }
  if (t === 'reaction') return (m.reaction && m.reaction.emoji) || null;
  if (t === 'location') {
    const l = m.location || {};
    return [l.name, l.address, `${l.latitude},${l.longitude}`].filter(Boolean).join(' | ');
  }
  if (t === 'contacts') return (m.contacts || []).map(c => (c.name && c.name.formatted_name) || '').filter(Boolean).join(', ') || null;
  if (t === 'order') return `pedido do catálogo (${((m.order && m.order.product_items) || []).length} itens)`;
  if (t === 'system') return (m.system && m.system.body) || null;
  return null;
}

// Corpo do webhook → linhas para gravar. Ignora o que não é do nosso número.
export function extrair(corpo) {
  const mensagens = [], status = [];
  if (!corpo || corpo.object !== 'whatsapp_business_account') return { mensagens, status };
  for (const entry of corpo.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (ch.field !== 'messages') continue;
      if (v.metadata && String(v.metadata.phone_number_id) !== PHONE_NUMBER_ID) continue;
      const nomes = {};
      for (const c of v.contacts || []) nomes[c.wa_id] = c.profile && c.profile.name;
      for (const m of v.messages || []) {
        const midia = m[m.type] && m[m.type].id ? m[m.type] : null;
        mensagens.push({
          wamid: m.id,
          telefone: String(m.from || '').replace(/\D/g, ''),
          direcao: 'entrada',
          tipo: m.type || null,
          texto: textoDa(m),
          midia_id: midia ? String(midia.id) : null,
          midia_mime: midia ? midia.mime_type || null : null,
          nome_contato: nomes[m.from] || null,
          resposta_a: (m.context && m.context.id) || (m.reaction && m.reaction.message_id) || null,
          enviada_em: quando(m.timestamp),
          bruto: m,
        });
      }
      for (const s of v.statuses || []) {
        status.push({
          wamid: s.id,
          telefone: String(s.recipient_id || '').replace(/\D/g, ''),
          status: s.status,
          status_rank: RANK[s.status] || 0,
          status_em: quando(s.timestamp),
          erro: s.errors && s.errors.length ? s.errors : null,
          bruto: s,
        });
      }
    }
  }
  return { mensagens, status };
}

// HMAC-SHA256 do corpo com o segredo do app (header X-Hub-Signature-256: sha256=<hex>).
export async function assinaturaValida(segredo, corpoTexto, header) {
  if (!header || !header.startsWith('sha256=')) return false;
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(corpoTexto));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return igual(hex, header.slice(7));
}

// ── Supabase (service_role: as tabelas wa_* não abrem para a chave anon) ─────

function sb(env, extra) {
  const k = env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json', ...(extra || {}) };
}

async function ok(r, onde) {
  if (r.ok) return r;
  throw new Error(`${onde}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}

export async function gravarEvento(env, corpo) {
  await ok(await fetch(`${SB_URL}/rest/v1/wa_eventos`, {
    method: 'POST', headers: sb(env, { Prefer: 'return=minimal' }), body: JSON.stringify({ corpo }),
  }), 'wa_eventos');
}

// Mesma mensagem pode chegar duas vezes (a Meta reenvia se a gente demorar): ignora a repetida.
export async function gravarMensagens(env, linhas) {
  if (!linhas.length) return;
  await ok(await fetch(`${SB_URL}/rest/v1/wa_mensagens?on_conflict=wamid`, {
    method: 'POST', headers: sb(env, { Prefer: 'resolution=ignore-duplicates,return=minimal' }), body: JSON.stringify(linhas),
  }), 'wa_mensagens');
}

// Status só anda pra frente (read que chega antes do delivered não volta). Se a mensagem não
// existe aqui (foi o Wati que mandou), nasce uma linha de saída só com o status.
export async function gravarStatus(env, s) {
  const campos = { status: s.status, status_rank: s.status_rank, status_em: s.status_em, erro: s.erro };
  const r = await ok(await fetch(`${SB_URL}/rest/v1/wa_mensagens?wamid=eq.${encodeURIComponent(s.wamid)}&status_rank=lt.${s.status_rank}`, {
    method: 'PATCH', headers: sb(env, { Prefer: 'return=representation' }), body: JSON.stringify(campos),
  }), 'wa_mensagens status');
  const mudou = await r.json().catch(() => []);
  if (Array.isArray(mudou) && mudou.length) return;
  await ok(await fetch(`${SB_URL}/rest/v1/wa_mensagens?on_conflict=wamid`, {
    method: 'POST', headers: sb(env, { Prefer: 'resolution=ignore-duplicates,return=minimal' }),
    body: JSON.stringify([{ wamid: s.wamid, telefone: s.telefone, direcao: 'saida', ...campos, enviada_em: s.status_em, bruto: s.bruto }]),
  }), 'wa_mensagens status novo');
}

// ── Etapa 2: caixa de entrada da equipe (sub-aba WhatsApp do ATENDIMENTO) ────
//
// Enquanto o Wati estiver ligado, a conversa vem de DUAS fontes: wa_mensagens (o que chega
// direto da Meta e o que a equipe manda por aqui) e wati_ia_mensagens (o histórico da Vi:
// cliente, Vi e equipe pelo Wati). A mesma cliente pode estar com e sem o 9.

const GRAPH = 'https://graph.facebook.com/v23.0';
export const JANELA_MS = 24 * 3600e3;
export const PAUSA_VI_MS = 24 * 3600e3; // igual ao PAUSA_HUMANO_MS do worker da Vi

// Mesma regra da wa_chave() do banco (sql/wa-conversas.sql).
export function chave(t) {
  t = String(t || '').replace(/\D/g, '');
  return (t.length === 13 && t.startsWith('55') && t[4] === '9') ? t.slice(0, 4) + t.slice(5) : t;
}
// As duas grafias do mesmo celular brasileiro (sem e com o 9).
// Não dá para separar celular de fixo pelo primeiro dígito: nas faixas novas o número depois do 9 começa com
// 1 a 5 (Carol, 9 1180-0182; 9 4996-1417), e o painel procurava só a grafia sem o 9: 92 conversas abriam
// vazias (21/10/2026). Devolve sempre as duas; num fixo a grafia com 9 a mais só não acha nada.
export function variantes(t) {
  const c = chave(t);
  return (c.length === 12 && c.startsWith('55')) ? [c, c.slice(0, 4) + '9' + c.slice(4)] : [c];
}

const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// Junta as duas fontes numa conversa só, sem repetir o que veio pelas duas.
//  wa: linhas de wa_mensagens   vi: linhas de wati_ia_mensagens
export function mesclar(wa, vi) {
  const out = [];
  const entradas = [];
  const daVi = [];       // o que a Vi mandou direto pela Meta (etapa 3): o histórico dela tem o mesmo texto
  const templates = [];  // templates que saíram pela Meta: a nota "[contexto interno" do mesmo envio fica escondida
  const nossos = new Set();
  for (const m of wa || []) {
    const quando = m.enviada_em || m.recebida_em;
    if (m.direcao === 'entrada') {
      entradas.push({ t: Date.parse(quando), texto: norm(m.texto), midia: !!m.midia_id });
      out.push({ id: m.wamid, quando, lado: 'cliente', texto: m.texto, tipo: m.tipo, midia_id: m.midia_id, mime: m.midia_mime, resposta_a: m.resposta_a });
    } else if (m.texto || m.midia_id) {
      nossos.add('op_' + m.wamid);
      const lado = m.origem === 'vi' ? 'vi' : m.origem === 'template' ? 'auto' : 'equipe';
      if (lado === 'vi') daVi.push({ t: Date.parse(quando), texto: norm(m.texto) });
      if (lado === 'auto') templates.push(Date.parse(quando));
      out.push({ id: m.wamid, quando, lado, texto: m.texto, tipo: m.tipo, midia_id: m.midia_id, mime: m.midia_mime, status: m.status, erro: m.erro });
    }
  }
  for (const m of vi || []) {
    if (nossos.has(m.msg_id)) continue;
    const texto = m.texto || '';
    const t = Date.parse(m.created_at);
    if (m.role === 'user') {
      const repetida = entradas.some(e => Math.abs(e.t - t) < 120e3 && (e.texto === norm(texto) || (e.midia && texto.startsWith('['))));
      if (repetida) continue;
      out.push({ id: m.msg_id, quando: m.created_at, lado: 'cliente', texto, tipo: 'text' });
    } else if (m.role === 'operador') {
      out.push({ id: m.msg_id, quando: m.created_at, lado: 'equipe', texto, tipo: 'text' });
    } else if (texto.startsWith('[contexto interno')) {
      if (templates.some(x => Math.abs(x - t) < 10 * 60e3)) continue;
      out.push({ id: m.msg_id, quando: m.created_at, lado: 'auto', texto, tipo: 'text' });
    } else {
      if (daVi.some(e => Math.abs(e.t - t) < 120e3 && e.texto === norm(texto))) continue;
      out.push({ id: m.msg_id, quando: m.created_at, lado: 'vi', texto, tipo: 'text' });
    }
  }
  return out.sort((a, b) => Date.parse(a.quando) - Date.parse(b.quando));
}

export function janelaAberta(ultimaEntrada, agora = Date.now()) {
  return !!ultimaEntrada && agora - Date.parse(ultimaEntrada) < JANELA_MS;
}

async function sbGet(env, caminho) {
  const r = await ok(await fetch(`${SB_URL}/rest/v1/${caminho}`, { headers: sb(env) }), caminho.split('?')[0]);
  return r.json();
}

export async function listarConversas(env, { desde, busca, filtro, limite = 60 } = {}) {
  const p = new URLSearchParams({ select: 'chave,telefone,ultima_em,ultima_direcao,ultimo_texto,ultimo_tipo,nome,pausada_ate,ultima_entrada_em,pendentes,status_vi', order: 'ultima_em.desc', limit: String(Math.min(Number(limite) || 60, 200)) });
  if (desde) p.set('ultima_em', 'gt.' + desde);
  // resolvida pela equipe sai da lista de esperando até a cliente escrever de novo (aí a Vi reabre a sessão)
  if (filtro === 'aguardando') { p.set('ultima_direcao', 'eq.entrada'); p.set('or', '(status_vi.is.null,status_vi.neq.solved)'); }
  else if (filtro === 'pausada') p.set('pausada_ate', 'gt.' + new Date().toISOString());
  const b = String(busca || '').trim();
  if (b) {
    const dig = b.replace(/\D/g, '');
    if (dig.length >= 4) p.set('chave', 'like.*' + chave(dig).slice(-8) + '*');
    else p.set('nome', 'ilike.*' + b.replace(/[*,()]/g, ' ') + '*');
  }
  return sbGet(env, 'wa_conversas?' + p);
}

export async function lerConversa(env, tel, { desde, limite = 200 } = {}) {
  const vs = variantes(tel).join(',');
  const lim = String(Math.min(Number(limite) || 200, 500));
  const pWa = new URLSearchParams({ select: 'wamid,telefone,direcao,tipo,texto,midia_id,midia_mime,resposta_a,status,erro,enviada_em,recebida_em,origem', telefone: `in.(${vs})`, order: 'recebida_em.desc', limit: lim });
  const pVi = new URLSearchParams({ select: 'msg_id,role,texto,created_at', wa_id: `in.(${vs})`, order: 'created_at.desc', limit: lim });
  if (desde) { pWa.set('or', `(recebida_em.gt.${desde},status_em.gt.${desde})`); pVi.set('created_at', 'gt.' + desde); }
  const [wa, vi, conv] = await Promise.all([
    sbGet(env, 'wa_mensagens?' + pWa),
    sbGet(env, 'wati_ia_mensagens?' + pVi),
    sbGet(env, `wa_conversas?chave=eq.${chave(tel)}&select=chave,telefone,nome,pausada_ate,ultima_entrada_em,status_vi`),
  ]);
  return { conversa: conv[0] || null, mensagens: mesclar(wa, vi) };
}

// Envia texto pela Cloud API, grava, e faz a Vi parar 24 h nesta conversa (o mesmo que acontece
// quando alguém da equipe responde pelo Wati: handleOperatorMsg do worker).
// Envio pelo painel só com WA_ENVIO_PAINEL=1 no Cloudflare. Desligado em 19/10/2026: no teste a Meta aceitou os
// envios do nosso app (200 + wamid) mas não entregou nenhum e não mandou status (caíam na conta 4436, ver
// CONTA_MENSAGENS_ID). Pela 925 entregou em 21/10; ligar quando a equipe for sair da caixa do Wati.
export const envioLiberado = env => env.WA_ENVIO_PAINEL === '1';
export const AVISO_ENVIO = 'O envio direto pela Meta ainda está em teste e não está chegando nas clientes. Por enquanto, responda pelo Wati.';

export async function enviarTexto(env, tel, texto, agora = Date.now()) {
  texto = String(texto || '').trim();
  if (!texto) return { status: 400, erro: 'mensagem vazia' };
  if (texto.length > 4000) return { status: 400, erro: 'mensagem com mais de 4000 caracteres' };
  const c = await conversaParaEnvio(env, tel, agora);
  if (c.erro) return c;
  const r = await mandarPelaMeta(c.token, c.conv.telefone, { type: 'text', text: { preview_url: true, body: texto } });
  if (r.erro) return r;
  return registrarEnvioEquipe(env, c.conv.telefone, r.wamid, { tipo: 'text', texto }, texto, agora);
}

// Foto, vídeo e documento pela equipe (passo 2 da saída do Wati, 21/10/2026; vídeo no mesmo dia, a Marcelly
// tentou mandar um). O arquivo chega cru no corpo, sem multipart, e vai para a Meta num FormData montado pelo
// próprio runtime: o Worker não desmonta nada (limite de 10 ms de CPU). A tela já manda foto como JPEG de até
// 1600 px. Limites da Meta: foto 5 MB, vídeo 16 MB (MP4 ou 3GP, H.264), documento 100 MB; aqui documento
// fica em 15 MB para caber folgado no Worker. Vídeo .mov do iPhone a Meta não aceita.
export const MIDIA_TIPOS = {
  'image/jpeg': 'image', 'image/png': 'image',
  'video/mp4': 'video', 'video/3gpp': 'video',
  'application/pdf': 'document', 'text/plain': 'document',
  'application/msword': 'document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.ms-excel': 'document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
};
export const MIDIA_MAX = { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024, document: 15 * 1024 * 1024 };
const MIDIA_NOME = { image: 'foto', video: 'vídeo', document: 'documento' };

export async function enviarMidia(env, { tel, mime, nome, legenda, corpo }, agora = Date.now()) {
  mime = String(mime || '').split(';')[0].trim().toLowerCase();
  const tipo = MIDIA_TIPOS[mime];
  if (!tipo) return { status: 415, erro: 'tipo de arquivo', detalhe: 'Dá para mandar foto (JPG ou PNG), vídeo MP4 e documento (PDF, Word, Excel ou texto).' };
  legenda = String(legenda || '').trim();
  if (legenda.length > 1024) return { status: 400, erro: 'legenda com mais de 1024 caracteres' };
  nome = String(nome || '').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 120) || ({ image: 'foto.jpg', video: 'video.mp4' }[tipo] || 'documento');
  const c = await conversaParaEnvio(env, tel, agora);
  if (c.erro) return c;
  const u = await subirMidia(c.token, { tipo, mime, nome, corpo });
  if (u.erro) return u;

  const conteudo = tipo === 'document' ? { id: u.id, filename: nome } : { id: u.id };
  if (legenda) conteudo.caption = legenda;
  const r = await mandarPelaMeta(c.token, c.conv.telefone, { type: tipo, [tipo]: conteudo });
  if (r.erro) return r;
  // a Vi lê o histórico em texto: fica dito o que a equipe mandou
  const textoVi = ({ image: '[a equipe mandou uma foto]', video: '[a equipe mandou um vídeo]' }[tipo] || `[a equipe mandou o documento ${nome}]`) + (legenda ? ' ' + legenda : '');
  const fim = await registrarEnvioEquipe(env, c.conv.telefone, r.wamid, { tipo, texto: legenda || null, midia_id: u.id, midia_mime: mime }, textoVi, agora);
  return { ...fim, midia_id: u.id, tipo };
}

// Sobe o arquivo na Meta e devolve o id que vai na mensagem.
async function subirMidia(token, { tipo, mime, nome, corpo }) {
  const buf = await new Response(corpo).arrayBuffer();
  if (!buf.byteLength) return { status: 400, erro: 'arquivo vazio' };
  if (buf.byteLength > MIDIA_MAX[tipo]) return { status: 413, erro: 'arquivo grande', detalhe: `O limite é ${MIDIA_MAX[tipo] / 1048576} MB para ${MIDIA_NOME[tipo]}.` };
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', mime);
  fd.append('file', new Blob([buf], { type: mime }), nome);
  const up = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/media`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  const u = await up.json().catch(() => ({}));
  if (!up.ok || !u.id) return { status: 502, erro: 'a Meta recusou o arquivo', detalhe: (u.error && (u.error.error_user_msg || u.error.message)) || ('HTTP ' + up.status) };
  return { id: u.id };
}

// Modelo aprovado pela equipe (passo 3 da saída do Wati, 21/10/2026): depois de 24 h sem a cliente escrever, a
// regra do WhatsApp só deixa mandar template. A equipe não escolhe entre os ~16 da conta: só estes, com nome que
// ela entende e o que pôr em cada campo. Os do Pix com código, contagem de minutos e o alerta interno ficam com a
// Vi e o sistema. Só aparece o que está APROVADO na conta 925 (os templates moram na conta de mensagens).
export const MODELOS_EQUIPE = [
  { nome: 'continuidade_solicitacao_v1', rotulo: 'Retomar o atendimento', campos: ['Nome da cliente', 'Assunto (ex.: a troca do pedido 9300)'] },
  { nome: 'recuperacao_oii_v1', rotulo: 'Só um oi, para ela responder', campos: ['Nome da cliente'] },
  { nome: 'pedido_despachado_vi', rotulo: 'Pedido despachado, com rastreio', campos: ['Nome da cliente', 'Número do pedido', 'Código de rastreio'] },
  { nome: 'pedido_confirmado_vi', rotulo: 'Pedido confirmado', campos: ['Nome da cliente', 'Número do pedido', 'Endereço de entrega'] },
  { nome: 'cartao_resgate_v2', rotulo: 'Link novo para pagar no cartão', campos: ['Nome da cliente', 'Número do pedido', 'Link de pagamento'] },
  { nome: 'pix_pendente_v1', rotulo: 'Pix pendente', campos: ['Nome da cliente', 'Número do pedido', 'Informação do Pix'] },
  { nome: 'pix_link_v1', rotulo: 'Link para finalizar a compra', campos: ['Nome da cliente', 'Link do carrinho'] },
];

// A Meta recusa variável com quebra de linha, tab ou 4+ espaços seguidos (erro 132018): igual ao limparVariavel da Vi.
export const limparVariavel = v => String(v ?? '').replace(/\s*[\r\n]+\s*/g, ' / ').replace(/\t/g, ' ').replace(/ {4,}/g, '   ').trim();

export async function listarModelos(env) {
  const token = env.WA_TOKEN || env.META_ACCESS_TOKEN;
  if (!token) return [];
  const r = await fetch(`${GRAPH}/${CONTA_MENSAGENS_ID}/message_templates?fields=name,language,status,category,components&limit=200`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('Meta templates: HTTP ' + r.status);
  const aprovados = ((await r.json()).data || []).filter(t => t.status === 'APPROVED');
  return MODELOS_EQUIPE.map(m => {
    const t = aprovados.find(x => x.name === m.nome && x.language === 'pt_BR') || aprovados.find(x => x.name === m.nome);
    if (!t) return null;
    const corpo = ((t.components || []).find(c => c.type === 'BODY') || {}).text || '';
    const nVars = new Set(corpo.match(/\{\{\d+\}\}/g) || []).size;
    if (nVars !== m.campos.length) return null; // o template mudou na Meta: melhor não oferecer do que mandar campo trocado
    return { nome: m.nome, rotulo: m.rotulo, campos: m.campos, corpo, idioma: t.language, categoria: t.category };
  }).filter(Boolean);
}

export async function enviarModelo(env, tel, nome, valores, agora = Date.now()) {
  const m = MODELOS_EQUIPE.find(x => x.nome === nome);
  if (!m) return { status: 400, erro: 'modelo', detalhe: 'Esse modelo não está liberado para a equipe.' };
  valores = (Array.isArray(valores) ? valores : []).map(limparVariavel);
  if (valores.length !== m.campos.length || valores.some(v => !v)) return { status: 400, erro: 'campos', detalhe: 'Preencha todos os campos do modelo.' };
  if (valores.some(v => v.length > 900)) return { status: 400, erro: 'campos', detalhe: 'Algum campo ficou comprido demais.' };
  const c = await conversaParaEnvio(env, tel, agora, { janela: false }); // template sai com ou sem janela
  if (c.erro) return c;
  const t = (await listarModelos(env)).find(x => x.nome === nome);
  if (!t) return { status: 409, erro: 'modelo', detalhe: 'Esse modelo não está aprovado na Meta agora.' };
  const r = await mandarPelaMeta(c.token, c.conv.telefone, { type: 'template', template: {
    name: nome, language: { code: t.idioma }, components: [{ type: 'body', parameters: valores.map(text => ({ type: 'text', text })) }] } });
  if (r.erro) return r;
  const texto = t.corpo.replace(/\{\{(\d+)\}\}/g, (x, i) => valores[Number(i) - 1] ?? x);
  return registrarEnvioEquipe(env, c.conv.telefone, r.wamid, { tipo: 'template', texto }, texto, agora);
}

// ── Mensagens da LOJA: aba CASOS, aviso da troca, crédito e alerta interno (26/10/2026, saída do Wati) ──
// Saíam pelo token de API do Wati, que a Vi não trata como atendente. Aqui é igual: não pausam a Vi, não
// passam pela chave WA_ENVIO_PAINEL (que é da conversa da equipe) e quem chama grava a fala no histórico da
// Vi (wati_ia_mensagens, role assistant), como já fazia. Texto livre fora da janela de 24 h a Meta aceita na
// hora e derruba depois (131047): quem chama confere a janela antes e, fora dela, usa modelo.
const tokenMeta = env => env.WA_TOKEN || env.META_ACCESS_TOKEN;
const destino = tel => String(tel || '').replace(/\D/g, '');

export async function enviarTextoDaLoja(env, tel, texto) {
  if (!tokenMeta(env)) return { status: 500, erro: 'META_ACCESS_TOKEN ausente' };
  texto = String(texto || '').trim();
  if (!texto) return { status: 400, erro: 'mensagem vazia' };
  return mandarPelaMeta(tokenMeta(env), destino(tel), { type: 'text', text: { preview_url: true, body: texto } });
}

// arquivo: File/Blob (o anexo do cartão da aba CASOS)
export async function enviarArquivoDaLoja(env, tel, arquivo, legenda) {
  if (!tokenMeta(env)) return { status: 500, erro: 'META_ACCESS_TOKEN ausente' };
  const mime = String((arquivo && arquivo.type) || '').split(';')[0].trim().toLowerCase();
  const tipo = MIDIA_TIPOS[mime];
  if (!tipo) return { status: 415, erro: 'tipo de arquivo', detalhe: 'Dá para mandar foto (JPG ou PNG), vídeo MP4 e documento (PDF, Word, Excel ou texto).' };
  const nome = String((arquivo && arquivo.name) || '').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 120) || ({ image: 'foto.jpg', video: 'video.mp4' }[tipo] || 'documento.pdf');
  const u = await subirMidia(tokenMeta(env), { tipo, mime, nome, corpo: arquivo });
  if (u.erro) return u;
  const conteudo = tipo === 'document' ? { id: u.id, filename: nome } : { id: u.id };
  legenda = String(legenda || '').trim();
  if (legenda) conteudo.caption = legenda.slice(0, 1024);
  return mandarPelaMeta(tokenMeta(env), destino(tel), { type: tipo, [tipo]: conteudo });
}

// Um modelo da conta 925, com o corpo e quantas variáveis tem. null se não existe.
export async function buscarModelo(env, nome) {
  const r = await fetch(`${GRAPH}/${CONTA_MENSAGENS_ID}/message_templates?name=${encodeURIComponent(nome)}&fields=name,language,status,category,components&limit=20`, { headers: { Authorization: 'Bearer ' + tokenMeta(env) } });
  if (!r.ok) throw new Error('Meta templates: HTTP ' + r.status);
  const lista = ((await r.json()).data || []).filter(t => t.name === nome); // o filtro da Meta casa por pedaço do nome
  const t = lista.find(x => x.language === 'pt_BR') || lista[0];
  if (!t) return null;
  const corpo = ((t.components || []).find(c => c.type === 'BODY') || {}).text || '';
  return { nome: t.name, status: t.status, categoria: t.category, idioma: t.language, corpo, nVars: new Set(corpo.match(/\{\{\d+\}\}/g) || []).size };
}

// valores na ordem das variáveis do modelo ({{1}}, {{2}}...). Devolve também o texto como a cliente leu.
export async function enviarModeloDaLoja(env, tel, nome, valores) {
  if (!tokenMeta(env)) return { status: 500, erro: 'META_ACCESS_TOKEN ausente' };
  valores = (valores || []).map(limparVariavel);
  const t = await buscarModelo(env, nome);
  if (!t || t.status !== 'APPROVED') return { status: 409, erro: 'modelo', detalhe: `O modelo ${nome} não está aprovado na Meta.` };
  if (t.nVars !== valores.length) return { status: 409, erro: 'modelo', detalhe: `O modelo ${nome} tem ${t.nVars} campos na Meta e vieram ${valores.length}.` };
  const template = { name: nome, language: { code: t.idioma } };
  if (valores.length) template.components = [{ type: 'body', parameters: valores.map(text => ({ type: 'text', text })) }];
  const r = await mandarPelaMeta(tokenMeta(env), destino(tel), { type: 'template', template });
  if (r.erro) return r;
  return { ...r, texto: t.corpo.replace(/\{\{(\d+)\}\}/g, (x, i) => valores[Number(i) - 1] ?? x) };
}

// "Devolver para a Vi" e "Resolvida" (passo 4 da saída do Wati, 21/10/2026). Mexem só na sessão da Vi, não mandam
// nada para a cliente, então valem com o envio desligado também.
//  devolver: tira a pausa e o handoff; a Vi responde a PRÓXIMA mensagem da cliente.
//  resolver: o mesmo que o "fechar" do Wati faz hoje (webhook de ticket solved no worker da Vi): status solved,
//            descarta resposta da Vi que estava na fila e lembrete de cartão; a conversa sai da lista de
//            esperando. Se a cliente escrever de novo, a Vi reabre a sessão sozinha e responde.
export async function mudarVi(env, tel, acao, agora = Date.now()) {
  if (acao !== 'devolver' && acao !== 'resolver') return { status: 400, erro: 'ação desconhecida' };
  const conv = (await sbGet(env, `wa_conversas?chave=eq.${chave(tel)}&select=telefone`))[0];
  if (!conv) return { status: 404, erro: 'conversa não encontrada' };
  const sess = await sbGet(env, `wati_ia_sessions?wa_id=in.(${variantes(conv.telefone).join(',')})&select=wa_id`);
  const waIds = sess.length ? sess.map(s => s.wa_id) : [conv.telefone];
  const quando = new Date(agora).toISOString();
  const campos = acao === 'devolver' ? { status: 'ativa', pausada_ate: null, handoff_motivo: null } : { status: 'solved', pausada_ate: null };
  await ok(await fetch(`${SB_URL}/rest/v1/wati_ia_sessions?on_conflict=wa_id`, {
    method: 'POST', headers: sb(env, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(waIds.map(w => ({ wa_id: w, ...campos, updated_at: quando }))),
  }), 'sessão da Vi');
  // Os dois botões desligam a pausa de 24 h. Em 27/10/2026 a Vi respondeu logo depois da Marcelly em 3 conversas e
  // não havia como saber se foi clique: fica no log da Vi (best effort, não trava o botão).
  await fetch(`${SB_URL}/rest/v1/wati_ia_log`, {
    method: 'POST', headers: sb(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ wa_id: waIds[0], direction: 'equipe', content: acao === 'devolver' ? 'Devolver para a Vi pelo painel: pausa desligada' : 'Resolvida pelo painel: pausa desligada' }),
  }).catch(() => {});
  if (acao === 'resolver') {
    // o resgate de cartão agendado (template) não é resposta da Vi: segue mesmo com a conversa resolvida
    await ok(await fetch(`${SB_URL}/rest/v1/wati_ia_fila?wa_id=in.(${waIds.join(',')})&enviado_at=is.null&template=is.null`, {
      method: 'PATCH', headers: sb(env, { Prefer: 'return=minimal' }),
      body: JSON.stringify({ enviado_at: quando, erro: 'cancelado: conversa resolvida pela equipe no painel' }),
    }), 'fila da Vi');
    // Resolvida não fecha o caso do CRM (30/10/2026: 51 abertos depois de ela resolver vários): a tela mostra os
    // abertos desta cliente e ela fecha um por um pelo /api/casos (tipo fechar_conversa).
    const ids = [...new Set([...waIds, ...variantes(conv.telefone)])];
    const casos = await sbGet(env, `wati_sac_casos?wa_id=in.(${ids.join(',')})&status=eq.aberto&select=id,tipo,pedido,resumo&order=criado_at.asc`).catch(() => []);
    return { status: 200, ok: true, status_vi: campos.status,
      casos: casos.map(c => ({ id: c.id, tipo: String(c.tipo || '').slice(0, 80), pedido: c.pedido || null, resumo: String(c.resumo || '').slice(0, 160), dinheiro: casoDeDinheiro(c) })) };
  }
  return { status: 200, ok: true, status_vi: campos.status };
}

// Liga-desliga, token, a conversa existe e (para texto e arquivo) está na janela de 24 h.
async function conversaParaEnvio(env, tel, agora, { janela = true } = {}) {
  if (!envioLiberado(env)) return { status: 503, erro: 'envio desligado', detalhe: AVISO_ENVIO };
  const token = env.WA_TOKEN || env.META_ACCESS_TOKEN;
  if (!token) return { status: 500, erro: 'META_ACCESS_TOKEN ausente' };
  const conv = (await sbGet(env, `wa_conversas?chave=eq.${chave(tel)}&select=telefone,ultima_entrada_em`))[0];
  if (!conv) return { status: 404, erro: 'conversa não encontrada' };
  if (janela && !janelaAberta(conv.ultima_entrada_em, agora)) return { status: 409, erro: 'janela', detalhe: 'A cliente não escreve há mais de 24 horas. Pela regra do WhatsApp, só dá para mandar um template aprovado.' };
  return { token, conv };
}

async function mandarPelaMeta(token, to, corpo) {
  const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', messaging_account_id: CONTA_MENSAGENS_ID, to, ...corpo }),
  });
  const d = await r.json().catch(() => ({}));
  const wamid = d.messages && d.messages[0] && d.messages[0].id;
  if (!r.ok || !wamid) return { status: 502, erro: 'a Meta recusou', detalhe: (d.error && (d.error.error_user_msg || d.error.message)) || ('HTTP ' + r.status) };
  return { wamid };
}

// Depois que a Meta aceitou: grava a saída e faz a Vi parar 24 h nesta conversa (o mesmo que acontece
// quando alguém da equipe responde pelo Wati: handleOperatorMsg do worker).
async function registrarEnvioEquipe(env, telefone, wamid, linha, textoVi, agora) {
  const quando = new Date(agora).toISOString();
  // merge (e não ignore): o status da Meta pode chegar antes e já ter criado a linha sem texto
  await ok(await fetch(`${SB_URL}/rest/v1/wa_mensagens?on_conflict=wamid`, {
    method: 'POST', headers: sb(env, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify([{ wamid, telefone, direcao: 'saida', ...linha, origem: 'painel', enviada_em: quando }]),
  }), 'wa_mensagens envio');

  // A Vi conhece a cliente pelo wa_id do Wati, que pode ser a outra grafia: pausa as que ela
  // tem e grava a fala no histórico dela na grafia que ela já usa.
  const vs = variantes(telefone);
  const sess = await sbGet(env, `wati_ia_sessions?wa_id=in.(${vs.join(',')})&select=wa_id&order=updated_at.desc.nullslast`);
  const waVi = (sess[0] && sess[0].wa_id) || telefone;
  const ate = new Date(agora + PAUSA_VI_MS).toISOString();
  await ok(await fetch(`${SB_URL}/rest/v1/wati_ia_sessions?on_conflict=wa_id`, {
    method: 'POST', headers: sb(env, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify([...new Set([waVi, ...sess.map(s => s.wa_id)])].map(w => ({ wa_id: w, pausada_ate: ate, updated_at: quando }))),
  }), 'pausa da Vi');
  await ok(await fetch(`${SB_URL}/rest/v1/wati_ia_mensagens?on_conflict=msg_id`, {
    method: 'POST', headers: sb(env, { Prefer: 'resolution=ignore-duplicates,return=minimal' }),
    body: JSON.stringify({ msg_id: 'op_' + wamid, wa_id: waVi, role: 'operador', texto: textoVi }),
  }), 'histórico da Vi');
  return { status: 200, ok: true, wamid, vi_pausada_ate: ate };
}

// Foto, áudio ou documento da cliente: a URL da Meta pede o token, então o painel busca por aqui.
export async function baixarMidia(env, id) {
  const token = env.WA_TOKEN || env.META_ACCESS_TOKEN;
  if (!/^\d{5,25}$/.test(String(id || ''))) return json({ erro: 'id inválido' }, 400);
  const info = await fetch(`${GRAPH}/${id}?phone_number_id=${PHONE_NUMBER_ID}`, { headers: { Authorization: 'Bearer ' + token } });
  const meta = await info.json().catch(() => ({}));
  if (!info.ok || !meta.url) return json({ erro: 'mídia indisponível', detalhe: meta.error && meta.error.message }, 404);
  const arq = await fetch(meta.url, { headers: { Authorization: 'Bearer ' + token } });
  if (!arq.ok) return json({ erro: 'mídia indisponível' }, 404);
  return new Response(arq.body, { headers: { 'Content-Type': meta.mime_type || arq.headers.get('Content-Type') || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' } });
}
