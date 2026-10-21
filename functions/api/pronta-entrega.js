/**
 * Cloudflare Pages Function: /api/pronta-entrega?produto=Macaquinho%20Amplo&k=<PREVISAO_KEY>
 *
 * O que dá para mandar SEM esperar a produção, por cor e tamanho, para a Vi responder "tem a
 * pronta entrega?" (21/10/2026: a Vi dizia "é sob encomenda, não sai como pronta entrega" sem
 * perguntar cor nem tamanho e sem olhar o estoque).
 *
 * Pronta entrega = estoque físico (vc_modelos.est) MENOS o que os pedidos pagos e ainda não
 * enviados já vão consumir daquela cor e tamanho. Sem descontar os pedidos, a Vi ofereceria
 * a peça que está separada para outra cliente. O estoque da Shopify é fictício e NÃO entra aqui.
 * Conjunto só está pronto quando as DUAS peças têm sobra na cor e no tamanho.
 *
 * Casamento produto→modelo e conjunto→peças: os mesmos da produção (shopify-orders.js e a cópia
 * travada por teste em previsao-pedido.js). Chave `k` = env.PREVISAO_KEY, só leitura.
 */
import { parseLineItemMulti, findModelAndColor, fetchAllOrders, PRODUCT_MAP } from './shopify-orders.js';
import { pecasDe } from './previsao-pedido.js';

const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhja3pzYmx3eWFibWh6Ympkamd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNTEyOTIsImV4cCI6MjA5NDcyNzI5Mn0.guif8jtidWmfqykhgDgPJiaRbWLoEEDMp1usTlAs1dQ';
const SIZES = ['PP', 'P', 'M', 'G', 'GG', 'G1'];
const SHOE_SIZES = ['34', '35', '36', '37', '38', '39', '40'];
const chaveCor = (c) => String(c || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Acha o modelo pelo nome que a cliente/Vi usou ("macaquinho amplo", "Conjunto Dream Rosa Baby")
function acharModelo(produto) {
  const t = String(produto || '').trim();
  const direto = findModelAndColor(t);
  if (direto) return { modelKey: direto.modelKey, cor: direto.color || '' };
  const alvo = chaveCor(t);
  const hit = Object.entries(PRODUCT_MAP).find(([nome]) => chaveCor(nome) === alvo);
  return hit ? { modelKey: hit[1], cor: '' } : null;
}

/**
 * Sobra por cor/tamanho de um produto (puro, testado em tests/pronta-entrega.test.mjs).
 * pecas: [{key, cor}] de UMA cor do produto; est: {key: {cor: [..]}}; demanda: {key: {corChave: [..]}}
 */
function sobraDasPecas(pecas, est, demanda, nTam) {
  const out = [];
  for (let i = 0; i < nTam; i++) {
    let min = Infinity;
    for (const p of pecas) {
      const e = Object.entries(est[p.key] || {}).find(([c]) => chaveCor(c) === chaveCor(p.cor));
      const fisico = e ? Number(e[1][i]) || 0 : 0;
      const usado = ((demanda[p.key] || {})[chaveCor(p.cor)] || [])[i] || 0;
      min = Math.min(min, fisico - usado);
    }
    out.push(min === Infinity ? 0 : min);
  }
  return out;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const url = new URL(request.url);
  if (!env.PREVISAO_KEY || url.searchParams.get('k') !== env.PREVISAO_KEY) {
    return new Response(JSON.stringify({ erro: 'chave inválida' }), { status: 401, headers });
  }
  const achado = acharModelo(url.searchParams.get('produto'));
  if (!achado) return new Response(JSON.stringify({ encontrado: false }), { headers });

  try {
    // Cores do produto = cores que existem no estoque das peças (o conjunto herda a cor da 1ª peça)
    const pecasBase = pecasDe(achado.modelKey, '__COR__');
    const ids = [...new Set(pecasBase.map((p) => p.key))];
    const sb = await fetch(`${SB_URL}/rest/v1/vc_modelos?select=id,nome:dados->>nome,est:dados->est&id=in.(${ids.join(',')})`,
      { headers: { apikey: env.SUPABASE_ANON_KEY || SB_ANON, Authorization: `Bearer ${env.SUPABASE_ANON_KEY || SB_ANON}` } });
    if (!sb.ok) throw new Error('Supabase ' + sb.status);
    const est = Object.fromEntries((await sb.json()).map((x) => [x.id, x.est || {}]));

    // Demanda em aberto só das peças deste produto
    const demanda = {};
    for (const o of await fetchAllOrders(env.SHOPIFY_STORE_DOMAIN, env.SHOPIFY_ADMIN_TOKEN)) {
      for (const item of o.line_items || []) {
        for (const p of parseLineItemMulti(item, o.name, [], false)) {
          for (const pc of pecasDe(p.modelKey, p.color)) {
            if (!ids.includes(pc.key)) continue;
            const c = chaveCor(pc.cor);
            const arr = ((demanda[pc.key] ||= {})[c] ||= []);
            arr[p.sizeIdx] = (arr[p.sizeIdx] || 0) + p.qty;
          }
        }
      }
    }

    const ehCalcado = Object.values(est).some((cores) => Object.values(cores).some((a) => (a || []).length > SIZES.length));
    const TAM = ehCalcado ? SHOE_SIZES : SIZES;
    const primeira = pecasBase[0];
    const cores = Object.keys(est[primeira.key] || {}).filter((c) => !achado.cor || chaveCor(c) === chaveCor(achado.cor));
    const pronta = [];
    for (const cor of cores) {
      const sobra = sobraDasPecas(pecasDe(achado.modelKey, cor), est, demanda, TAM.length);
      const tams = TAM.filter((_, i) => sobra[i] > 0);
      if (tams.length) pronta.push({ cor, tamanhos: tams });
    }
    return new Response(JSON.stringify({ modelo: achado.modelKey, pronta_entrega: pronta }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 502, headers });
  }
}

export { sobraDasPecas, acharModelo };
