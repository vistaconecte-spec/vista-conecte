/**
 * Cloudflare Pages Function: /api/previsao-pedido?pedido=9104&k=<PREVISAO_KEY>
 *
 * Posição REAL de um pedido ainda não enviado, peça por peça, para a Vi (IA do Wati) responder
 * "quando sai?" com data em vez de "fica tranquila" (caso Larissa #9104, 05/10/2026).
 *
 * Para cada peça que falta: está pronta no estoque, está numa leva (e qual etapa), ou ainda
 * não entrou em leva nenhuma. Quando a leva está "Em costura" e a rotina da Elizete gravou a
 * data de entrega dela (`entrega`/`entrega2`, ver backups da rotina entrega-elizete), a peça
 * libera no dia útil ANTERIOR à entrega, que é quando a expedição emite as etiquetas
 * (regra da Bárbara, 05/10/2026).
 *
 * A conta é CONSERVADORA de propósito: peça que tem quantidade numa leva conta como dessa leva,
 * mesmo havendo estoque, porque o estoque pode já ser de um pedido mais antigo. Melhor a Vi dizer
 * uma data um pouco mais tarde do que prometer "pronta" para quem ainda está na fila.
 *
 * Público com chave (`k` = env.PREVISAO_KEY), só leitura, um pedido por chamada. O casamento
 * título→modelo é o MESMO da produção (parseLineItemMulti de shopify-orders.js), nunca uma cópia.
 */
import { parseLineItemMulti } from './shopify-orders.js';

const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhja3pzYmx3eWFibWh6Ympkamd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNTEyOTIsImV4cCI6MjA5NDcyNzI5Mn0.guif8jtidWmfqykhgDgPJiaRbWLoEEDMp1usTlAs1dQ';
const SIZES = ['PP', 'P', 'M', 'G', 'GG', 'G1'];
const SHOE_SIZES = ['34', '35', '36', '37', '38', '39', '40'];

// CÓPIA de CONJUNTO_PECAS / CONJUNTO_CORES_COMBINADAS do main.js (o main.js roda no navegador e
// não exporta nada). tests/previsao-pedido.test.mjs confere que as duas continuam iguais.
const CONJUNTO_PECAS = {
  'conjunto-calca-pantalona-moletom': ['calca-pantalona', 'moletom-gola-alta'],
  'conjunto-calca-pantalona-cropped': ['calca-pantalona', 'cropped-moletom'],
  'conjunto-cropped-basica':          ['calca-basica-moletom', 'cropped-moletom'],
  'conjunto-cozy':                    ['calca-pantalona', 'moletom-ziper-bolsos'],
  'conjunto-mood':                    ['calca-basica-moletom', 'moletom-ziper-bolsos'],
  'conjunto-wide':                    ['calca-pantalona', 'moletom-gola-alta'],
  'conjunto-canelado':                ['blusa-canelada', 'calca-flare'],
  'conjunto-boho':                    ['calca-boho', 'blusa-boho'],
  'conjunto-pantalona-blusa':         ['calca-pantalona-viscolycra', 'blusa-canelada-simples'],
  'conjunto-peace':                   ['calca-peace', 'cropped-peace'],
  'conjunto-calca-flare-moletom':     ['calca-flare', 'moletom-gola-alta'],
  'conjunto-calca-flare-camiseta':    ['calca-flare', 'camiseta-oversized'],
  'conjunto-moletom-saia-midi':       ['moletom-gola-alta', 'saia-midi'],
  'conjunto-moletom-short-bolso':     ['moletom-gola-alta', 'calca-bolso-frontal'],
  'conjunto-calca-bolso-camiseta':    [
    { key: 'calca-bolso-frontal', cor: 'Off White' },
    { key: 'camiseta-oversized',  cor: 'Preto'     },
  ],
  'conjunto-saia-midi-oversized':     ['camiseta-oversized', 'saia-midi'],
  'conjunto-regata-mini-saia':         ['regata-oversized', 'mini-saia-canelada'],
  'conjunto-camiseta-mini-saia':      ['camiseta-oversized', 'mini-saia-canelada'],
  'cropped-mini-saia':                ['cropped-canelado', 'mini-saia-canelada'],
  'conjunto-canguru-longo':           ['canguru-amplo', 'calca-basica-moletom'],
  'conjunto-good':                    ['short-good', 'regata-good'],
};
const CONJUNTO_CORES_COMBINADAS = {
  'conjunto-camiseta-mini-saia': {
    'Verde Militar + Preta': { 'camiseta-oversized': 'Militar', 'mini-saia-canelada': 'Preto' },
    'Marsala + Nude':        { 'camiseta-oversized': 'Marsala', 'mini-saia-canelada': 'Nude'  },
  },
};

const chaveCor = (c) => String(c || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const ORDEM_ETAPA = { 'Comprando tecido': 0, 'Em corte': 1, 'Em costura': 2 };

// Dia útil anterior (sábado e domingo pulam para sexta). Feriado não entra: a data é previsão.
function diaUtilAnterior(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

function pecasDe(modelKey, color) {
  const pecas = CONJUNTO_PECAS[modelKey];
  if (!pecas) return [{ key: modelKey, cor: color }];
  const combinada = (CONJUNTO_CORES_COMBINADAS[modelKey] || {})[color];
  return pecas.map((p) => {
    const key = typeof p === 'string' ? p : p.key;
    if (combinada && combinada[key]) return { key, cor: combinada[key] };
    if (typeof p !== 'string') return { key, cor: p.cor };
    return { key, cor: color === 'Branca' ? 'Branco' : color };
  });
}

// Quantidade daquela cor/tamanho num dicionário cor → [tamanhos], casando a cor sem acento/caixa
function qtdCor(dic, cor, idx) {
  if (!dic) return 0;
  const alvo = chaveCor(cor);
  for (const [c, arr] of Object.entries(dic)) if (chaveCor(c) === alvo) return Number((arr || [])[idx]) || 0;
  return 0;
}

// Situação de UMA peça a partir da linha do modelo no vc_modelos
function situacaoPeca(d, cor, idx) {
  if (!d) return { situacao: 'sem_cadastro' };
  const levas = [1, 2].map((n) => ({
    n,
    status: n === 1 ? d.status : d.status2,
    statusAt: n === 1 ? d.status_at : d.status2_at,
    entrega: n === 1 ? d.entrega : d.entrega2,
    entregaRef: n === 1 ? d.entrega_ref : d.entrega2_ref,
    qtd: qtdCor(n === 1 ? d.prod : d.prod2, cor, idx),
  })).filter((l) => l.qtd > 0 && l.status in ORDEM_ETAPA);
  if (!levas.length) return qtdCor(d.est, cor, idx) > 0 ? { situacao: 'pronta' } : { situacao: 'sem_leva' };
  // Conservador: a leva mais atrasada que tem a peça
  const l = levas.sort((a, b) => ORDEM_ETAPA[a.status] - ORDEM_ETAPA[b.status])[0];
  const dataValida = l.status === 'Em costura' && l.entrega && (!l.entregaRef || l.entregaRef === l.statusAt);
  return {
    situacao: 'em_producao', etapa: l.status, leva: l.n,
    ...(dataValida ? { entrega_costura: l.entrega, libera_em: diaUtilAnterior(l.entrega) } : {}),
  };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const url = new URL(request.url);
  if (!env.PREVISAO_KEY || url.searchParams.get('k') !== env.PREVISAO_KEY) {
    return new Response(JSON.stringify({ erro: 'chave inválida' }), { status: 401, headers });
  }
  const numero = String(url.searchParams.get('pedido') || '').replace(/\D/g, '');
  if (!numero) return new Response(JSON.stringify({ erro: 'informe ?pedido=' }), { status: 400, headers });

  try {
    const fields = 'name,created_at,financial_status,fulfillment_status,cancelled_at,line_items';
    const r = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-04/orders.json?status=any&name=%23${numero}&fields=${fields}`,
      { headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN } });
    if (!r.ok) throw new Error('Shopify ' + r.status);
    const o = ((await r.json()).orders || []).find((x) => x.name === '#' + numero);
    if (!o) return new Response(JSON.stringify({ encontrado: false }), { headers });

    const pecas = [];
    for (const item of o.line_items || []) {
      for (const p of parseLineItemMulti(item, o.name, [], false)) {
        for (const pc of pecasDe(p.modelKey, p.color)) pecas.push({ ...pc, idx: p.sizeIdx, qtd: p.qty, item: item.title });
      }
    }
    if (!pecas.length) return new Response(JSON.stringify({ pedido: o.name, pendentes: [], tudo_enviado: true }), { headers });

    const ids = [...new Set(pecas.map((p) => p.key))].join(',');
    const sel = 'id,nome:dados->>nome,tamanhos:dados->tamanhos,est:dados->est,prod:dados->prod,prod2:dados->prod2,status:dados->>status,status2:dados->>status2,status_at:dados->>status_at,status2_at:dados->>status2_at,entrega:dados->>entrega,entrega2:dados->>entrega2,entrega_ref:dados->>entrega_ref,entrega2_ref:dados->>entrega2_ref';
    const sb = await fetch(`${SB_URL}/rest/v1/vc_modelos?select=${sel}&id=in.(${ids})`,
      { headers: { apikey: env.SUPABASE_ANON_KEY || SB_ANON, Authorization: `Bearer ${env.SUPABASE_ANON_KEY || SB_ANON}` } });
    if (!sb.ok) throw new Error('Supabase ' + sb.status);
    const linhas = Object.fromEntries((await sb.json()).map((x) => [x.id, x]));

    const pendentes = pecas.map((p) => {
      const d = linhas[p.key];
      const tamanhos = (d && d.tamanhos) || (p.idx < SIZES.length ? SIZES : SHOE_SIZES);
      return { peca: (d && d.nome) || p.key, cor: p.cor, tamanho: tamanhos[p.idx] || SIZES[p.idx] || String(p.idx), ...situacaoPeca(d, p.cor, p.idx) };
    });
    const semData = pendentes.filter((p) => p.situacao !== 'pronta' && !p.libera_em);
    const datas = pendentes.map((p) => p.libera_em).filter(Boolean).sort();
    return new Response(JSON.stringify({
      pedido: o.name,
      pendentes,
      // Data do pedido inteiro só quando TODAS as peças têm data (ou estão prontas)
      libera_pedido_em: semData.length ? null : (datas.length ? datas[datas.length - 1] : 'pronto'),
    }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 502, headers });
  }
}

export { situacaoPeca, diaUtilAnterior, pecasDe, CONJUNTO_PECAS, CONJUNTO_CORES_COMBINADAS };
