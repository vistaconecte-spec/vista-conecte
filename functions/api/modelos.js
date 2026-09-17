/**
 * Cloudflare Pages Function: /api/modelos
 * Caminho RESERVA de leitura da tabela vc_modelos (estoque, levas, listas do painel).
 *
 * O navegador lê essa tabela direto no Supabase (main.js, carregarTodosNuvem/sincronizarNuvem).
 * Em 17/09/2026 o celular da dona ficou horas mostrando levas velhas enquanto os pedidos
 * (que passam por /api, mesmo domínio) atualizavam normalmente: a chamada a supabase.co não
 * chegava naquele aparelho e o app engolia o erro. Este endpoint serve a mesma leitura pelo
 * domínio do próprio sistema, e o main.js cai nele quando a leitura direta falha.
 *
 * GET /api/modelos                 → todos os modelos (sem hist:*), [{ id, dados, updated_at }]
 * GET /api/modelos?desde=<ISO>     → só o que mudou depois dessa marca (updated_at > desde)
 * GET /api/modelos?id=<chave>      → uma linha só
 *
 * O corpo do Supabase é repassado como stream, sem parse: plano grátis, 10 ms de CPU.
 * Só leitura. Gravação continua indo direto ao Supabase pelo navegador.
 */
const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
// A MESMA chave pública (anon) que o main.js usa no navegador: é ela que tem SELECT em
// vc_modelos. A service key do projeto Cloudflare é da modelagem e toma 403 nessa tabela
// (visto em 17/09/2026). Nada novo fica exposto: a chave já está no código do site.
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhja3pzYmx3eWFibWh6Ympkamd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNTEyOTIsImV4cCI6MjA5NDcyNzI5Mn0.guif8jtidWmfqykhgDgPJiaRbWLoEEDMp1usTlAs1dQ';

export async function onRequestGet(context) {
  const { env, request } = context;
  const key = env.SUPABASE_ANON_KEY || SB_ANON;
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const desde = url.searchParams.get('desde');
  const q = new URLSearchParams({ select: 'id,dados,updated_at' });
  if (id) {
    q.set('id', 'eq.' + id);
  } else {
    q.set('id', 'not.like.hist:*');
    if (desde) q.set('updated_at', 'gt.' + desde);
    q.set('order', 'updated_at.asc');
  }
  let res;
  try {
    res = await fetch(`${SB_URL}/rest/v1/vc_modelos?${q}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ erro: 'Supabase inacessível: ' + (e && e.message) }), { status: 502, headers });
  }
  if (!res.ok) {
    return new Response(JSON.stringify({ erro: 'Supabase HTTP ' + res.status, corpo: (await res.text()).slice(0, 300) }), { status: 502, headers });
  }
  return new Response(res.body, { status: 200, headers });
}
