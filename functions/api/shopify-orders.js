/**
 * Cloudflare Pages Function: /api/shopify-orders
 * Busca pedidos em aberto da Shopify e retorna agrupados por modelo/cor/tamanho
 *
 * Formato Shopify desta loja:
 *   title         = "Macacão Amplo Preto"   (nome do produto + cor)
 *   variant_title = "PP"                     (só o tamanho)
 */

const SIZES      = ['PP', 'P', 'M', 'G', 'GG'];
const SHOE_SIZES = ['34', '35', '36', '37', '38', '39', '40']; // calçados 34-40

// Mapa: prefixo exato do título Shopify → chave do modelo no sistema
const PRODUCT_MAP = {
  // Macacões
  'Macacão Amplo':                                          'macacao-amplo',
  'Macacão Manga Longa':                                    'macacao-manga-longa',
  // Macaquinhos
  'Macaquinho Amplo':                                       'macaquinho-amplo',
  'Macaquinho Ruel':                                        'macaquinho-ruel',
  // Vestidos
  'Vestido Frente Única Longo':                             'vestido-frente-unica-longo',
  'Vestido Frente Única Curto':                             'vestido-frente-unica-curto',
  'Vestido Amplo':                                          'vestido-amplo',
  // Conjuntos existentes
  'Conjunto Peace':                                         'conjunto-peace',
  'Conjunto Wide':                                          'conjunto-wide',
  'Conjunto Boho':                                          'conjunto-boho',
  'Conjunto Canelado':                                      'conjunto-canelado',
  // Conjuntos novos
  'Conjunto Calça flare com Moletom gola alta':             'conjunto-calca-flare-moletom',
  'Conjunto calça flare com moletom gola alta':             'conjunto-calca-flare-moletom',
  'Conjunto calça flare com Moletom gola alta':             'conjunto-calca-flare-moletom',
  'Conjunto Calça Pantalona com Moletom Gola Alta':         'conjunto-calca-pantalona-moletom',
  'Conjunto Calça Pantalona com Cropped moletom':           'conjunto-calca-pantalona-cropped',
  'Conjunto Cropped Moletom':                               'conjunto-calca-pantalona-cropped',
  'Conjunto Cropped':                                       'conjunto-calca-pantalona-cropped',
  'Conjunto Moletom gola alta com Saia midi fenda frontal': 'conjunto-moletom-saia-midi',
  'Conjunto Pantalona com Blusa Canelada':                  'conjunto-pantalona-blusa',
  'Conjunto Regata oversized com Mini saia canelada':       'conjunto-regata-mini-saia',
  'Conjunto Camiseta oversized com Mini saia canelada':     'conjunto-camiseta-mini-saia',
  'Conjunto Camiseta Oversized Verde Militar + Mini Saia Canelada Preta': 'conjunto-camiseta-mini-saia',
  'Conjunto Oversized Verde Militar + Mini Saia Canelada':  'conjunto-camiseta-mini-saia',
  'Conjunto Canguru Longo':                                 'conjunto-canguru-longo',
  'Conjunto Cozy':                                          'conjunto-cozy',
  'Conjunto Mood':                                          'conjunto-mood',
  'Canguru Longo':                                          'conjunto-canguru-longo',
  'Conjunto Saia Midi Fenda Frontal + Oversized':           'conjunto-saia-midi-oversized',
  'Conjunto Calça Bolso Frontal Offwhite com Camiseta Oversized': 'conjunto-calca-bolso-camiseta',
  // Calças
  'Calça Moletom Pantalona':                                'calca-pantalona',
  'Calça Pantalona Moletom':                                'calca-pantalona',
  'Calça Pantalona':                                        'calca-pantalona-viscolycra',
  'Calça Flare Canelada':                                   'calca-flare',
  'Calça Peace':                                            'calca-peace',
  'Calça Bolso Frontal':                                    'calca-bolso-frontal',
  // Casacos
  'Casaco Sherpa com Capuz':                                'casaco-sherpa-capuz',
  'Casaco Sherpa':                                          'casaco-sherpa',
  'Casaco Pele Persa Xadrez':                               'casaco-pele-persa',
  'Casaco Xadrez':                                          'casaco-pele-persa',
  'Casaco Bear':                                            'sherpa-ziper-bolsos',
  'Carneirinho Cropped':                                    'carneirinho-cropped',
  'Casaco Carneirinho Cropped Feminino':                    'carneirinho-cropped',
  // Tops
  'Cropped Peace':                                          'cropped-peace',
  'Cropped Frente Única':                                   'cropped-frente-unica',
  'Cropped Frente Unica':                                   'cropped-frente-unica',
  'Camiseta Oversized':                                     'camiseta-oversized',
  'Blusa Canelada punho dedindo':                           'blusa-canelada',
  'Blusa Canelada punho dedinho':                           'blusa-canelada',
  'Regata Oversized':                                       'regata-oversized',
  'Regata Canelada':                                        'regata-canelada',
  'Cropped com Mini saia Canelada':                         'cropped-mini-saia',
  'Cropped Moletom':                                        'cropped-moletom',
  // Sapatos
  'Flat':                                                   'flat',
  'Sandália Gladiadora':                                    'sandalia-gladiadora',
  'Sandalia Gladiadora':                                    'sandalia-gladiadora',
  'Sandália Plataforma':                                    'sandalia-gladiadora',
  'Sandalia Plataforma':                                    'sandalia-gladiadora',
  // Saias
  'Saia Midi':                                              'saia-midi',
  'Mini Saia Canelada':                                     'mini-saia-canelada',
  // Outros
  'Moletom Gola Alta':                                      'moletom-gola-alta',
  'Moletom Zíper com Bolsos':                               'moletom-ziper-bolsos',
  'Moletom Ziper com Bolsos':                               'moletom-ziper-bolsos',
  'Moletom Cozy':                                           'moletom-ziper-bolsos',
  'Moletom Mood':                                           'moletom-ziper-bolsos',
  'Sherpa Zíper com Bolsos':                                'sherpa-ziper-bolsos',
  'Sherpa Ziper com Bolsos':                                'sherpa-ziper-bolsos',
  'Calça Básica Moletom':                                   'calca-basica-moletom',
  'Calca Basica Moletom':                                   'calca-basica-moletom',
  'Cropped Canelado':                                       'cropped-canelado',
  // Blusa Canelada simples (sem punho dedinho) — entradas mais longas têm prioridade
  'Blusa Canelada':                                         'blusa-canelada-simples',
};

// Títulos exatos da Shopify onde a cor está no nome do produto (sem variante de cor separada)
// ou pedidos antigos sem cor no título — mapeados manualmente para modelo + cor fixos
const EXACT_TITLE_MAP = {
  'Macacão Manga Longa':                                                       { modelKey: 'macacao-manga-longa',      color: 'Marrom'        },
  'Calça Peace':                                                               { modelKey: 'calca-peace',              color: 'Marsala'       },
  'Casaco Carneirinho Cropped Feminino':                                       { modelKey: 'carneirinho-cropped',      color: 'Off White'     },
  'Conjunto Camiseta Oversized Verde Militar + Mini Saia Canelada Preta':      { modelKey: 'conjunto-camiseta-mini-saia', color: 'Militar' },
  'Conjunto Oversized Verde Militar + Mini Saia Canelada':                     { modelKey: 'conjunto-camiseta-mini-saia', color: 'Militar' },
  // Pedidos antigos com título sem "com Capuz" → redireciona para casaco-sherpa-capuz
  'Casaco Sherpa Vermelho':                                                    { modelKey: 'casaco-sherpa-capuz',      color: 'Vermelho'      },
  // Pedido antigo sem cor no título
  'Conjunto Peace':                                                            { modelKey: 'conjunto-peace',           color: 'Off White'     },
  // Cor "Preto" no meio do título (em ambas as peças) → cor fixa
  'Conjunto Moletom Gola Alta Preto + Short Bolso Frontal Preto':              { modelKey: 'conjunto-moletom-short-bolso', color: 'Preto'     },
};

// Cores que precisam de normalização (shopify → sistema)
const COLOR_NORM = {
  'offwhite':  'Off White',
  'Offwhite':  'Off White',
  'off':       'Off White',
  'Off':       'Off White',
  'petroleo':  'Petróleo',
  'Petroleo':  'Petróleo',
  'fucsia':    'Fúcsia',
  'Fucsia':    'Fúcsia',
  'marrom':    'Marrom',
  'militar':   'Militar',
  'verde militar': 'Militar',
  'Verde Militar': 'Militar',
  'preto':     'Preto',
  'preta':     'Preto',
  'Preta':     'Preto',
  'black':     'Preto',
  'vermelho':  'Vermelho',
  'red':       'Vermelho',
  'branca':    'Off White',
  'Branca':    'Off White',
  'branco':    'Off White',
  'Branco':    'Off White',
};

function normalizeColor(c) {
  return COLOR_NORM[c] || COLOR_NORM[c.toLowerCase()] || c;
}

// Remove sufixos que Shopify adiciona em pedidos manuais
function cleanTitle(title) {
  return title
    .replace(/\s+preço unitário\s*/i, '')
    .replace(/\s+unit price\s*/i, '')
    .trim();
}

/**
 * Tenta extrair modelo + cor do título do produto.
 * Estratégia:
 *   1. Prefix match: "Macacão Amplo Preto" → key "Macacão Amplo", cor "Preto"
 *   2. Color-in-middle: "Vestido Frente Única Offwhite Longo" →
 *      remove "Offwhite" → "Vestido Frente Única Longo" → key encontrado
 */
function findModelAndColor(title) {
  const titleL = title.toLowerCase();

  // 1. Tentar prefixo mais longo (case-insensitive)
  let best = null;
  for (const [name, modelKey] of Object.entries(PRODUCT_MAP)) {
    const nameL = name.toLowerCase();
    if (titleL === nameL || titleL.startsWith(nameL + ' ')) {
      if (!best || name.length > best.name.length) {
        // Extrai cor usando o comprimento original do nome (ambos têm mesmo número de chars)
        best = { name, modelKey, color: title.slice(name.length).trim() };
      }
    }
  }
  if (best) return best;

  // 2. Cor no meio do título: tentar remover 1 ou 2 palavras consecutivas (case-insensitive)
  const words = title.split(' ');
  for (let len = 1; len <= 2; len++) {
    for (let i = 0; i <= words.length - len; i++) {
      const colorCandidate = words.slice(i, i + len).join(' ');
      const remaining = [...words.slice(0, i), ...words.slice(i + len)].join(' ').toLowerCase();
      for (const [name, modelKey] of Object.entries(PRODUCT_MAP)) {
        if (remaining === name.toLowerCase()) {
          return { name, modelKey, color: colorCandidate };
        }
      }
    }
  }

  return null;
}

function nomeCliente(order) {
  const s = order.shipping_address;
  if (s) {
    if (s.name) return s.name;
    if (s.first_name || s.last_name) return `${s.first_name || ''} ${s.last_name || ''}`.trim();
  }
  return 'Cliente';
}

async function fetchAllOrders(store, token) {
  const orders = [];
  const fields = 'id,name,created_at,financial_status,fulfillment_status,line_items,shipping_address';
  // fulfillment_status=unfulfilled → pedidos NÃO enviados (null) OU PARCIALMENTE enviados (partial).
  // (a Shopify não aceita lista "unshipped,partial" — ela tratava só como unshipped, perdendo os parciais)
  // status=open  → pedidos ativos | status=closed → pedidos ARQUIVADOS (que ainda têm itens pendentes,
  // ex.: pedido parcialmente processado e arquivado). Cancelados (status=cancelled) ficam de fora.
  for (const st of ['open', 'closed']) {
    let url = `https://${store}/admin/api/2024-04/orders.json?status=${st}&fulfillment_status=unfulfilled&limit=250&fields=${fields}`;
    while (url) {
      const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (!res.ok) throw new Error(`Shopify API error: ${res.status}`);
      const data = await res.json();
      orders.push(...(data.orders || []));
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
  }
  return orders;
}

/**
 * Faz o parsing de um único line_item → { modelKey, color, sizeIdx, qty }.
 * Retorna null se o item deve ser ignorado (e registra o motivo em `ignorados`).
 */
function parseLineItem(item, orderName, ignorados) {
  // fulfillable_quantity = 0 → item removido/reembolsado → ignorar
  const qty = item.fulfillable_quantity ?? 0;
  if (qty <= 0) return null;

  // Correção manual — pedido #8406 "Conjunto cozy marrom" chegou sem variant_title (null) no
  // Shopify, sem como inferir o tamanho automaticamente. Confirmado com a Bárbara: tamanho P.
  // Cor fixa "Marsala" (única cor cadastrada do conjunto-cozy) para casar com CONJUNTO_PECAS.
  if (orderName === '#8406' && /conjunto cozy marrom/i.test(item.title)) {
    return { modelKey: 'conjunto-cozy', color: 'Marsala', sizeIdx: SIZES.indexOf('P'), qty };
  }

  // Ignora linhas customizadas com "Preço unitário" no título (anotações manuais)
  if (/preço unitário/i.test(item.title)) {
    ignorados.push(`${orderName} | "${item.title}" | linha customizada ignorada`);
    return null;
  }

  let variantRaw = (item.variant_title || '').trim();
  let titleForParsing = cleanTitle(item.title);
  let colorFromVariant = null;

  // Suporte ao formato "Cor / Tamanho" ou "Tamanho / Cor" no variant_title
  if (variantRaw && variantRaw.toUpperCase() !== 'NULL' && variantRaw.includes(' / ')) {
    const parts = variantRaw.split(' / ').map(p => p.trim());
    for (let i = 0; i < parts.length; i++) {
      const isClothing = SIZES.includes(parts[i].toUpperCase());
      const isShoe     = SHOE_SIZES.includes(parts[i]);
      if (isClothing || isShoe) {
        variantRaw     = isClothing ? parts[i].toUpperCase() : parts[i];
        colorFromVariant = parts.filter((_, j) => j !== i).join(' / ');
        break;
      }
    }
    if (!colorFromVariant) variantRaw = variantRaw.toUpperCase();
  } else {
    variantRaw = variantRaw.toUpperCase();
  }

  // Se não houver variant_title, tenta extrair o tamanho do final do título
  if (!variantRaw || variantRaw === 'NULL') {
    for (const size of SIZES) {
      if (titleForParsing.toUpperCase().endsWith(' ' + size)) {
        variantRaw = size;
        titleForParsing = titleForParsing.slice(0, -(size.length + 1)).trim();
        break;
      }
    }
  }

  let sizeIdx = SIZES.indexOf(variantRaw);
  if (sizeIdx < 0) sizeIdx = SHOE_SIZES.indexOf(variantRaw);
  if (sizeIdx < 0) {
    ignorados.push(`${orderName} | "${item.title}" | variante inválida: "${item.variant_title}"`);
    return null;
  }

  // 1. Mapa de títulos exatos (pedidos sem cor separada)
  const exact = EXACT_TITLE_MAP[titleForParsing];
  if (exact) {
    return { modelKey: exact.modelKey, color: exact.color, sizeIdx, qty };
  }

  // 2. Modelo + cor extraídos do título por prefix matching
  const found = findModelAndColor(titleForParsing);
  const rawColor = (found && found.color) ? found.color : (colorFromVariant || null);
  if (!found || !rawColor) {
    ignorados.push(`${orderName} | "${item.title}" | produto não mapeado`);
    return null;
  }

  return { modelKey: found.modelKey, color: normalizeColor(rawColor), sizeIdx, qty };
}

export async function onRequest(context) {
  const { env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_ADMIN_TOKEN;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!store || !token) {
    return new Response(JSON.stringify({ erro: 'Variáveis de ambiente não configuradas' }), { headers });
  }

  try {
    const orders = await fetchAllOrders(store, token);
    const result = {};
    const ignorados = [];
    const pulados = []; // itens com qty=0 (debug)
    const detalhados = []; // dados por pedido (número, cliente, data, itens) p/ card "Prontos para envio"

    for (const order of orders) {
      const itensPedido = [];
      for (const item of order.line_items || []) {
        const parsed = parseLineItem(item, order.name, ignorados);
        if (!parsed) continue;
        const { modelKey, color, sizeIdx, qty } = parsed;

        // Agregação por modelo/cor/tamanho (comportamento existente)
        if (!result[modelKey]) result[modelKey] = {};
        if (!result[modelKey][color]) result[modelKey][color] = new Array(Math.max(SIZES.length, SHOE_SIZES.length)).fill(0);
        result[modelKey][color][sizeIdx] = (result[modelKey][color][sizeIdx] || 0) + qty;

        // Detalhe por pedido
        itensPedido.push({ modelKey, cor: color, tam: sizeIdx, qtd: qty });
      }

      if (itensPedido.length > 0) {
        detalhados.push({
          id:      order.id,
          numero:  order.name,
          cliente: nomeCliente(order),
          data:    order.created_at,
          itens:   itensPedido,
          url:     `https://${store}/admin/orders/${order.id}`,
          financial_status: order.financial_status || null,
          parcial: order.fulfillment_status === 'partial',
        });
      }
    }

    // Inclui log de ignorados para diagnóstico
    return new Response(JSON.stringify({ pedidos: result, detalhados, ignorados, pulados, total_pedidos: orders.length }), { headers });

  } catch (err) {
    return new Response(JSON.stringify({ erro: err.message }), { headers });
  }
}
