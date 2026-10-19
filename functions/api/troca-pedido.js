/**
 * Cloudflare Pages Function: /api/troca-pedido (exige sessão, como todo /api)
 *
 * Pedido de troca de R$ 0 (functions/_pedido-troca.js), pela aba TROCAS:
 *   POST { acao: 'liberar', order_id }  → botão "conferido": solta o envio na Shopify e troca a
 *                                          tag troca-aguardando por troca-liberada
 *   POST { acao: 'criar', doc_id }      → cria o pedido de uma solicitação do portal em que a
 *                                          Shopify falhou na hora (lê a linha troca-portal:...)
 */
import { criarPedidoTroca, liberarPedidoTroca, gqlDe } from '../_pedido-troca.js';

const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhja3pzYmx3eWFibWh6Ympkamd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNTEyOTIsImV4cCI6MjA5NDcyNzI5Mn0.guif8jtidWmfqykhgDgPJiaRbWLoEEDMp1usTlAs1dQ';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const sb = (env, extra = {}) => { const k = env.SUPABASE_ANON_KEY || SB_ANON; return { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', ...extra }; };

export async function onRequestPost({ env, request }) {
  let b = {};
  try { b = await request.json(); } catch { return json({ erro: 'corpo inválido' }, 400); }
  const gql = gqlDe(env);
  try {
    if (b.acao === 'liberar') {
      if (!b.order_id) return json({ erro: 'informe order_id' }, 400);
      return json({ ok: true, ...(await liberarPedidoTroca(gql, b.order_id)) });
    }
    if (b.acao === 'criar') {
      const id = String(b.doc_id || '');
      if (!id.startsWith('troca-portal:')) return json({ erro: 'doc_id inválido' }, 400);
      const r = await fetch(`${SB_URL}/rest/v1/vc_modelos?id=eq.${encodeURIComponent(id)}&select=dados`, { headers: sb(env) });
      const doc = ((await r.json())[0] || {}).dados;
      if (!doc) return json({ erro: 'solicitação não encontrada' }, 404);
      if (doc.pedido_troca && doc.pedido_troca.id) return json({ ok: true, ja_existia: true, pedido_troca: doc.pedido_troca });
      const pt = await criarPedidoTroca(gql, { numeroOriginal: doc.pedido, itens: doc.itens, protocolo: doc.protocolo });
      if (!pt) return json({ erro: 'esta solicitação não tem peça para trocar' }, 422);
      const pedido_troca = { id: pt.id, name: pt.name, travado: pt.travado !== false, criado_em: new Date().toISOString() };
      const { erro_pedido_troca, ...resto } = doc;
      await fetch(`${SB_URL}/rest/v1/vc_modelos?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: sb(env, { Prefer: 'return=minimal' }), body: JSON.stringify({ dados: { ...resto, pedido_troca } }),
      });
      return json({ ok: true, pedido_troca });
    }
    return json({ erro: 'ação desconhecida' }, 400);
  } catch (e) {
    return json({ erro: e.message }, 502);
  }
}
