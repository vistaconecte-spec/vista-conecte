/**
 * Cloudflare Pages Function: /api/shopify-orders
 * Busca pedidos em aberto da Shopify e retorna agrupados por modelo/cor/tamanho
 *
 * Formato Shopify desta loja:
 *   title         = "Macacão Amplo Preto"   (nome do produto + cor)
 *   variant_title = "PP"                     (só o tamanho)
 */

// G1 entra depois do GG (índice 5). Modelo que não tem G1 na grade recebe a peça no maior
// tamanho (regra da Bárbara, 29/07/2026) — o main.js já faz isso ao distribuir. Sem o G1 aqui
// o item era recusado como "variante inválida" e o pedido sob medida sumia da produção (#8520).
const SIZES      = ['PP', 'P', 'M', 'G', 'GG', 'G1'];
const SHOE_SIZES = ['34', '35', '36', '37', '38', '39', '40']; // calçados 34-40

// Mapa: prefixo exato do título Shopify → chave do modelo no sistema
const PRODUCT_MAP = {
  'Canguru Longo Moletom': 'canguru-amplo',
  'Calça Boho': 'calca-boho',
  'Blusa Boho': 'blusa-boho',
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
  'Conjunto Calça Flare + Camiseta Oversized':      'conjunto-calca-flare-camiseta',
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
  'Regata Canelada':                                        'blusa-canelada-simples',
  'Cropped com Mini saia Canelada':                         'cropped-mini-saia',
  'Cropped Moletom':                                        'cropped-moletom',
  // Sapatos
  'Flat':                                                   'flat',
  'Sandália Gladiadora':                                    'sandalia-gladiadora',
  'Sandalia Gladiadora':                                    'sandalia-gladiadora',
  'Sandália Plataforma':                                    'sandalia-gladiadora',
  'Sandalia Plataforma':                                    'sandalia-gladiadora',
  // Saias
  // "Fenda Frontal" faz parte do NOME do modelo — sem esta entrada o prefixo casa só
  // "Saia Midi" e o resto do título vira a cor "Fenda Frontal Preto" (pedido #8602, 07/2026).
  // O casamento usa o prefixo MAIS LONGO, então esta entrada vence a de baixo.
  'Saia Midi Fenda Frontal':                                'saia-midi',
  'Saia Midi com fenda Frontal':                            'saia-midi',
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
  // Branco NÃO é Off White — são cores diferentes na produção e existem produtos ativos
  // separados ("Mini Saia Canelada Branca" x variante Off White). Unificar as duas fazia
  // o pedido de branco entrar no balde do off white e sumir. Canônico no masculino, como Preta→Preto.
  'branca':    'Branco',
  'Branca':    'Branco',
  'branco':    'Branco',
  'Branco':    'Branco',
};

function normalizeColor(c) {
  return COLOR_NORM[c] || COLOR_NORM[c.toLowerCase()] || c;
}

// Remove sufixos que Shopify adiciona em pedidos manuais
function cleanTitle(title) {
  return title
    .replace(/\s+preço unitário\s*/i, '')
    .replace(/\s+unit price\s*/i, '')
    // Peça sob medida: o atendimento anota a medida no fim do título
    // ("... G1 quadril 1,20"). Sem tirar isso, o tamanho não é lido e a peça
    // some da produção — era o caso dos 4 itens do pedido #8520.
    .replace(/\s+(quadril|cintura|busto|altura)\s*:?\s*[\d]+([.,][\d]+)?\s*(m|cm)?\s*$/i, '')
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
 * Pedidos JÁ PROCESSADOS (enviados) desde uma data — alimenta a baixa automática de estoque.
 *
 * POR QUE PELA SHOPIFY: o processamento é feito lá, não no app. Perguntar direto "o que foi
 * enviado" é a fonte da verdade; deduzir por sumiço da lista de não-enviados confunde envio
 * com cancelamento (o cancelado some igual, e a peça dele continua na arara).
 */
async function fetchProcessados(store, token, desdeISO) {
  const orders = [];
  const vistos = new Set();
  const fields = 'id,name,created_at,updated_at,cancelled_at,fulfillment_status,line_items,fulfillments';
  // shipped = pedido 100% enviado | partial = parte já saiu e o resto está pendente.
  // A Shopify não aceita os dois numa lista só, então são duas buscas. SEM o partial, a
  // parte já enviada de um pedido misto nunca teria baixa — e ela já saiu de "pedidos em
  // aberto" (que conta fulfillable_quantity), que é justamente o furo que se quer fechar.
  for (const st of ['shipped', 'partial']) {
    let url = `https://${store}/admin/api/2024-04/orders.json?status=any&fulfillment_status=${st}`
      + `&updated_at_min=${encodeURIComponent(desdeISO)}&limit=250&fields=${fields}`;
    while (url) {
      const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (!res.ok) throw new Error(`Shopify API error (processados ${st}): ${res.status}`);
      const data = await res.json();
      for (const o of data.orders || []) {
        if (vistos.has(o.id)) continue; // um pedido pode cair nas duas buscas
        vistos.add(o.id);
        orders.push(o);
      }
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
  }
  // Cancelado nunca dá baixa: a peça voltou (ou nem saiu) — subtrair aqui sumiria com estoque real.
  return orders.filter(o => !o.cancelled_at);
}

/**
 * ITENS MONTADOS À MÃO NO PEDIDO.
 *
 * Às vezes a venda é fechada com um item digitado direto no pedido, sem produto na Shopify
 * (por isso `variant_title` vem null e o tamanho fica embutido no título). Quando esse item
 * é um conjunto, ele pode pedir TAMANHO DIFERENTE por peça — coisa que um conjunto normal
 * não expressa, porque lá o tamanho escolhido vale para todas as peças.
 *
 * Aqui cada peça é declarada com o SEU modelo, a SUA cor e o SEU tamanho. Sem isto o item
 * cai em "produto não mapeado", o pedido some da produção e ninguém corta a peça.
 *
 * A chave é o título normalizado (maiúsculas, espaços colapsados).
 */
const ITENS_MANUAIS = {
  // #8719 — confirmado com a Bárbara em 10/08/2026: é a Pantalona VISCOLYCRA (não a de
  // moletom nem a Bolso Frontal) com o Cropped CANELADO, cada uma no seu tamanho.
  'CONJUNTO CALÇA PANTALONA BOLSO FRONTAL CINZA GG E CROPPED M': [
    { modelKey: 'calca-pantalona-viscolycra', color: 'Cinza', size: 'GG' },
    { modelKey: 'cropped-canelado',           color: 'Cinza', size: 'M'  },
  ],
  // #8864 — confirmado com a Bárbara em 20/08/2026: Conjunto Canelado MARROM com a CALÇA
  // no G e a BLUSA no P. O título veio sem variante, então o leitor pegava só o último
  // termo como tamanho (P para as duas peças) e transformava todo o resto em cor —
  // criando a cor inexistente "MARROM CALÇA G E BLUSA" no conjunto e, por tabela, nas
  // duas peças dele no painel.
  'CONJUNTO CANELADO MARROM CALÇA G E BLUSA P': [
    { modelKey: 'calca-flare',    color: 'Marrom', size: 'G' },
    { modelKey: 'blusa-canelada', color: 'Marrom', size: 'P' },
  ],
};

const normalizarTitulo = t => String(t || '').toUpperCase().replace(/\s+/g, ' ').trim();

/**
 * CONJUNTOS VENDIDOS COM TÍTULO PRÓPRIO cujas peças não batem com nenhum conjunto cadastrado.
 *
 * O casamento por prefixo do PRODUCT_MAP é ganancioso: "Conjunto Cropped Canelado + Calça
 * Pantalona Cinza" (#8748) casou com o Conjunto Calça Pantalona + Cropped MOLETOM e todo o
 * resto do título virou "cor" — daí os avisos de cor inexistente e, pior, a peça errada indo
 * para a produção (moletom no lugar de canelado).
 *
 * A chave é o título SEM a cor (o que sobra vira a cor). As duas peças herdam a cor e o
 * tamanho do item, como em qualquer conjunto.
 */
const CONJUNTOS_POR_TITULO = {
  'CONJUNTO CROPPED CANELADO + CALÇA PANTALONA': ['cropped-canelado', 'calca-pantalona-viscolycra'],
};

/**
 * Expande um line_item nas peças que a produção precisa fazer.
 * Devolve SEMPRE uma lista (vazia = item ignorado). Existe para dar conta dos itens
 * manuais com tamanho por peça; o resto continua passando pelo parseLineItem de sempre.
 */
function parseLineItemMulti(item, orderName, ignorados, usarQuantidadeTotal) {
  const qty = usarQuantidadeTotal ? (item.quantity ?? 0) : (item.fulfillable_quantity ?? 0);
  if (qty <= 0) return [];

  const manual = ITENS_MANUAIS[normalizarTitulo(item.title)];
  if (manual) {
    return manual.map(p => ({
      modelKey: p.modelKey,
      color:    p.color,
      sizeIdx:  SIZES.indexOf(p.size),
      qty,
      via:      'item-manual',
    })).filter(p => p.sizeIdx >= 0);
  }

  const p = parseLineItem(item, orderName, ignorados, usarQuantidadeTotal);
  if (!p) return [];
  // Conjunto com título próprio: uma linha do pedido vira as duas peças, mesma cor e tamanho
  if (p.multi) {
    return p.multi.map(key => ({ modelKey: key, color: p.color, sizeIdx: p.sizeIdx, qty: p.qty, via: 'conjunto-por-titulo' }));
  }
  return [p];
}

/**
 * Faz o parsing de um único line_item → { modelKey, color, sizeIdx, qty }.
 * Retorna null se o item deve ser ignorado (e registra o motivo em `ignorados`).
 */
function parseLineItem(item, orderName, ignorados, usarQuantidadeTotal) {
  // Em pedido JÁ PROCESSADO a Shopify zera fulfillable_quantity — ali o que vale é a
  // quantidade enviada. Nos pedidos em aberto continua valendo o fulfillable (item
  // removido/reembolsado tem fulfillable 0 e precisa ser ignorado).
  const qty = usarQuantidadeTotal ? (item.quantity ?? 0) : (item.fulfillable_quantity ?? 0);
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

  // A cor escolhida na variante manda: é o que a cliente comprou de fato.
  // Depois da unificação de produtos por cor, o título perdeu a cor ("Conjunto Peace") e ela
  // passou a vir na variante ("Preto / M") — título e EXACT_TITLE_MAP só valem como fallback,
  // senão um pedido Preto era lido como Off White (e reservava/produzia a cor errada).

  // 0. Conjunto com título próprio → duas peças. Tem que vir ANTES do casamento por
  //    prefixo, que é ganancioso e casaria com o conjunto errado (ver CONJUNTOS_POR_TITULO).
  const tNorm = normalizarTitulo(titleForParsing);
  for (const [prefixo, pecas] of Object.entries(CONJUNTOS_POR_TITULO)) {
    if (!tNorm.startsWith(prefixo)) continue;
    // O resto vem do título já em CAIXA ALTA; sem devolver ao formato do cadastro a cor
    // viraria "CINZA" e abriria um balde separado de "Cinza" nas telas.
    const resto = tNorm.slice(prefixo.length).trim()
      .toLowerCase().replace(/(^|\s)\p{L}/gu, m => m.toUpperCase());
    const cor = colorFromVariant || resto;
    if (!cor) {
      ignorados.push(`${orderName} | "${item.title}" | conjunto sem cor no título nem na variante`);
      return null;
    }
    return { multi: pecas, color: normalizeColor(cor), sizeIdx, qty };
  }

  // 1. Mapa de títulos exatos (pedidos sem cor separada)
  const exact = EXACT_TITLE_MAP[titleForParsing];
  if (exact) {
    const color = colorFromVariant ? normalizeColor(colorFromVariant) : exact.color;
    return { modelKey: exact.modelKey, color, sizeIdx, qty };
  }

  // 2. Modelo + cor extraídos do título por prefix matching
  const found = findModelAndColor(titleForParsing);
  const rawColor = colorFromVariant || (found && found.color) || null;
  if (!found || !rawColor) {
    ignorados.push(`${orderName} | "${item.title}" | produto não mapeado`);
    return null;
  }

  return { modelKey: found.modelKey, color: normalizeColor(rawColor), sizeIdx, qty };
}

/**
 * PEÇAS VENDIDAS POR MODELO numa janela de dias — quem consome é a prioridade da aba CORTE
 * ("o que sempre sai muito é o que se corta primeiro").
 *
 * Só pedidos PAGOS e não cancelados, pela data de CRIAÇÃO do pedido (é venda, não envio).
 * Quantidade é a do item (`quantity`), não a fulfillable: peça já enviada continua sendo
 * venda.
 */
async function fetchVendas(store, token, desdeISO) {
  const orders = [];
  const fields = 'id,name,created_at,financial_status,cancelled_at,line_items';
  let url = `https://${store}/admin/api/2024-04/orders.json?status=any&financial_status=paid`
    + `&created_at_min=${encodeURIComponent(desdeISO)}&limit=250&fields=${fields}`;
  while (url) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (!res.ok) throw new Error(`Shopify API error (vendas): ${res.status}`);
    const data = await res.json();
    orders.push(...(data.orders || []));
    const link = res.headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return orders.filter(o => !o.cancelled_at);
}

export async function onRequest(context) {
  const { env, request } = context;
  const store = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_ADMIN_TOKEN;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!store || !token) {
    return new Response(JSON.stringify({ erro: 'Variáveis de ambiente não configuradas' }), { headers });
  }

  // ── ?vendas=N → devolve SÓ o volume de vendas por modelo dos últimos N dias ──
  // Mora neste arquivo de propósito, e não num endpoint separado: o casamento
  // título→modelo (PRODUCT_MAP, EXACT_TITLE_MAP, parseLineItemMulti) é o MESMO que
  // distribui os pedidos da produção e já é coberto por tests/shopify-orders.test.mjs.
  // Um arquivo separado precisaria de uma cópia dele — e a cópia ia divergir na primeira
  // cor ou título novo, com o ranking de prioridade errando em silêncio.
  // A busca é mais pesada que a do dia a dia (meses de pedidos), então quem chama pede
  // no máximo 1x por dia — nunca no ciclo de 1 minuto.
  const diasPedidos = parseInt(new URL(request.url).searchParams.get('vendas') || '0', 10);
  if (diasPedidos > 0) {
    try {
      const dias  = Math.min(diasPedidos, 365);
      const desde = new Date(Date.now() - dias * 86400000).toISOString();
      const naoMapeados = [];
      const porModelo   = {};
      for (const o of await fetchVendas(store, token, desde)) {
        for (const item of o.line_items || []) {
          for (const p of parseLineItemMulti(item, o.name, naoMapeados, true)) {
            porModelo[p.modelKey] = (porModelo[p.modelKey] || 0) + p.qty;
          }
        }
      }
      return new Response(JSON.stringify({
        dias, desde,
        por_modelo: porModelo,
        total_unidades: Object.values(porModelo).reduce((a, b) => a + b, 0),
        nao_mapeados: naoMapeados.slice(0, 30),
      }), { headers });
    } catch (err) {
      return new Response(JSON.stringify({ erro: err.message }), { headers });
    }
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
        // Multi: um item pode render mais de uma peça, cada uma no seu tamanho (item manual)
        for (const parsed of parseLineItemMulti(item, order.name, ignorados)) {
        const { modelKey, color, sizeIdx, qty } = parsed;

        // Agregação por modelo/cor/tamanho (comportamento existente)
        if (!result[modelKey]) result[modelKey] = {};
        if (!result[modelKey][color]) result[modelKey][color] = new Array(Math.max(SIZES.length, SHOE_SIZES.length)).fill(0);
        result[modelKey][color][sizeIdx] = (result[modelKey][color][sizeIdx] || 0) + qty;

        // Detalhe por pedido
        itensPedido.push({ modelKey, cor: color, tam: sizeIdx, qtd: qty });
        }
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

    // Pedidos PROCESSADOS na Shopify — é daqui que sai a baixa automática de estoque do app.
    // Janela de 7 dias: o app tem registro próprio do que já baixou, então uma janela folgada
    // só serve para não perder envio nenhum se ficar dias sem ninguém abrir o sistema.
    // Uma entrada por ENVIO (fulfillment), não por pedido. Um pedido pode ser enviado em
    // duas remessas: a primeira dá baixa nas peças dela, a segunda nas outras. Se a chave
    // fosse o pedido, a segunda remessa seria vista como "já baixado" e ficaria de fora.
    // As peças vêm do próprio fulfillment (o que REALMENTE saiu), não dos itens do pedido.
    let processados = [];
    try {
      const desde = new Date(Date.now() - 7 * 86400000).toISOString();
      for (const o of await fetchProcessados(store, token, desde)) {
        for (const f of o.fulfillments || []) {
          // Remessa cancelada/falhada não tirou peça da arara
          if (f.status && f.status !== 'success') continue;
          const itens = [];
          for (const item of f.line_items || []) {
            for (const parsed of parseLineItemMulti(item, o.name, [], true)) {
              itens.push({ modelKey: parsed.modelKey, cor: parsed.color, tam: parsed.sizeIdx, qtd: parsed.qty });
            }
          }
          if (itens.length === 0) continue;
          processados.push({
            id: String(f.id), pedido_id: String(o.id), numero: o.name,
            enviado_em: f.created_at || o.updated_at, itens,
          });
        }
      }
    } catch (e) {
      // Falhar aqui não pode derrubar a lista de pedidos em aberto — a tela inteira vive dela.
      processados = [];
    }

    // Inclui log de ignorados para diagnóstico
    return new Response(JSON.stringify({ pedidos: result, detalhados, processados, ignorados, pulados, total_pedidos: orders.length }), { headers });

  } catch (err) {
    return new Response(JSON.stringify({ erro: err.message }), { headers });
  }
}
