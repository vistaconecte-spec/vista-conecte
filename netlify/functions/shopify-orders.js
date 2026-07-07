const SIZES = ['PP', 'P', 'M', 'G', 'GG'];

// Mapeia títulos de produtos Shopify para as chaves dos modelos em data.js
// Ajuste conforme os nomes dos seus produtos na Shopify
const PRODUCT_MAP = {
  'Macacão Amplo':               'macacao-amplo',
  'Macacão Manga Longa':         'macacao-manga-longa',
  'Macaquinho Amplo':            'macaquinho-amplo',
  'Macaquinho Ruel':             'macaquinho-ruel',
  'Vestido Frente Única Longo':  'vestido-frente-unica-longo',
  'Vestido Frente Única Curto':  'vestido-frente-unica-curto',
  'Vestido Amplo':               'vestido-amplo',
  'Conjunto Peace':              'conjunto-peace',
  'Conjunto Wide':               'conjunto-wide',
  'Conjunto Boho':               'conjunto-boho',
  'Conjunto Canelado':           'conjunto-canelado',
  'Calça Pantalona':             'calca-pantalona',
  'Calça Flare Canelada':        'calca-flare',
  'Moletom Gola Alta':           'moletom-gola-alta',
};

function parseVariant(variantTitle) {
  if (!variantTitle) return { color: null, sizeIdx: -1 };
  const parts = variantTitle.split('/').map(p => p.trim());
  let color = null;
  let sizeIdx = -1;
  for (const part of parts) {
    const upper = part.toUpperCase();
    const idx = SIZES.indexOf(upper);
    if (idx >= 0) {
      sizeIdx = idx;
    } else {
      color = part;
    }
  }
  return { color, sizeIdx };
}

async function fetchAllOrders(store, token) {
  const orders = [];
  let url = `https://${store}/admin/api/2024-04/orders.json?status=open&fulfillment_status=unshipped,partial&limit=250&fields=line_items`;

  while (url) {
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': token },
    });

    if (!res.ok) throw new Error(`Shopify API error: ${res.status}`);

    const data = await res.json();
    orders.push(...(data.orders || []));

    // Paginação via Link header
    const link = res.headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }

  return orders;
}

exports.handler = async () => {
  const store = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!store || !token) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    };
  }

  try {
    const orders = await fetchAllOrders(store, token);
    const result = {};

    for (const order of orders) {
      for (const item of order.line_items || []) {
        const modelKey = PRODUCT_MAP[item.title];
        if (!modelKey) continue;

        const qty = item.fulfillable_quantity ?? item.quantity ?? 0;
        if (qty <= 0) continue;

        const { color, sizeIdx } = parseVariant(item.variant_title);
        if (!color || sizeIdx < 0) continue;

        if (!result[modelKey]) result[modelKey] = {};
        if (!result[modelKey][color]) result[modelKey][color] = [0, 0, 0, 0, 0];
        result[modelKey][color][sizeIdx] += qty;
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('Erro ao buscar pedidos Shopify:', err.message);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    };
  }
};
