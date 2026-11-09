/**
 * Cloudflare Pages Function: /api/etiqueta-pdf
 *
 * PDF 10x15 da etiqueta de envio de cada pedido, para sair intercalado com a cópia do pedido
 * ("imprimir pedidos"). Pedido da Bárbara em 09/11/2026: imprimia as etiquetas na Frenet e as
 * cópias no painel, em ordens diferentes, e perdia tempo procurando uma para a outra.
 *
 * O robô de etiquetas baixa o PDF na Frenet depois do pagamento (o mesmo /Order/Document do
 * botão de imprimir de lá) e manda para cá. Fica no bucket PRIVADO "etiquetas" do Supabase:
 * tem nome e endereço da cliente, então só sai por esta rota, atrás do login ou do X-VC-Token.
 *
 *   POST ?numero=9266   corpo application/pdf     → grava etiquetas/9266.pdf (substitui)
 *   GET  ?numero=9266                             → o PDF (404 se não tem)
 *   GET  ?numeros=9266,9281                       → { tem: ['#9266'] }
 */
const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
const BUCKET = 'etiquetas';
const JSONH = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSONH });
const soNumero = v => String(v || '').replace(/\D/g, '');

async function criarBucket(env) {
  await fetch(`${SB_URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  });
}

export async function onRequest({ request, env }) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return json({ erro: 'SUPABASE_SERVICE_ROLE_KEY não configurada' }, 500);
  const q = new URL(request.url).searchParams;
  const auth = { Authorization: `Bearer ${key}`, apikey: key };

  if (request.method === 'POST') {
    const numero = soNumero(q.get('numero'));
    if (!numero) return json({ erro: 'informe ?numero=' }, 400);
    const pdf = await request.arrayBuffer();
    if (pdf.byteLength < 500 || pdf.byteLength > 5e6) return json({ erro: 'PDF vazio ou grande demais' }, 400);
    const subir = () => fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${numero}.pdf`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/pdf', 'x-upsert': 'true' }, body: pdf,
    });
    let r = await subir();
    if (!r.ok && /bucket/i.test(await r.clone().text())) { await criarBucket(env); r = await subir(); }
    if (!r.ok) return json({ erro: 'Storage ' + r.status, detalhe: (await r.text()).slice(0, 300) }, 502);
    return json({ ok: true, numero: '#' + numero, bytes: pdf.byteLength });
  }

  if (request.method !== 'GET') return json({ erro: 'use GET ou POST' }, 405);

  const lista = q.get('numeros');
  if (lista != null) {
    const pedidos = new Set(String(lista).split(/[,\s]+/).map(soNumero).filter(Boolean));
    const r = await fetch(`${SB_URL}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: '', limit: 2000, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!r.ok) return json({ tem: [] });
    const tem = (await r.json()).map(o => soNumero(o.name)).filter(n => pedidos.has(n)).map(n => '#' + n);
    return json({ tem });
  }

  const numero = soNumero(q.get('numero'));
  if (!numero) return json({ erro: 'informe ?numero= ou ?numeros=' }, 400);
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${numero}.pdf`, { headers: auth });
  if (!r.ok) return json({ erro: 'sem etiqueta para #' + numero }, 404);
  return new Response(r.body, { headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, max-age=300' } });
}
