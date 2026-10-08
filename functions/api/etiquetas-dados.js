/**
 * Cloudflare Pages Function: /api/etiquetas-dados (somente leitura)
 *
 * Dados de entrega dos pedidos para o robô que monta as etiquetas no carrinho da Frenet
 * (pedido da Bárbara em 08/10/2026: a Manu digitava cada etiqueta à mão no painel da Frenet,
 * com Saco P em pacote de 700 g e uma Loggi a mais paga no pedido da Mariane #9219).
 *
 *   GET /api/etiquetas-dados?numeros=9266,9265
 *   → { pedidos: [{ numero, id, nome, cpf, email, telefone, cep, rua, numero_end, complemento,
 *        bairro, cidade, uf, metodo, servico_cliente, cobrado, valor, peso_g, pecas, saco,
 *        regra, enviado, pago }], faltando: ['#9999'] }
 *
 * O robô chama com o X-VC-Token, do notebook. Nada disto vai para o Supabase: a linha da
 * fila só leva número do pedido, saco e serviço, porque o vc_modelos é lido com a chave
 * anon que está no JavaScript público e CPF de cliente não pode ficar lá.
 *
 * Endereço: o checkout da Shopify grava "Rua, ⁠Número complemento" em address1 e
 * "complemento, ⁠Bairro" em address2, com um WORD JOINER (U+2060) depois da vírgula que
 * separa as partes. Conferido em 25 pedidos de 06-07/10/2026.
 */
const API_VERSION = '2024-04';
const WJ = '⁠';

const num = v => Math.round((parseFloat(v) || 0) * 100) / 100;

/** Separa rua, número, complemento e bairro do endereço do checkout brasileiro da Shopify. */
export function separarEndereco(address1, address2) {
  const a1 = String(address1 || '').trim(), a2 = String(address2 || '').trim();
  let rua = a1, resto = '';
  const i1 = a1.lastIndexOf(WJ);
  if (i1 >= 0) { rua = a1.slice(0, i1).replace(/,\s*$/, '').trim(); resto = a1.slice(i1 + 1).trim(); }
  else {
    // Sem o separador (pedido manual, endereço antigo): "Rua X, 123 ap 4" ou "Rua X 123"
    const m = /^(.*?)[,\s]+(\d+[A-Za-z]?|s\/?n)\b(.*)$/i.exec(a1);
    if (m) { rua = m[1].trim(); resto = (m[2] + m[3]).trim(); }
  }
  const mn = /^(\d+[A-Za-z]?|s\/?n)\b[\s,.-]*(.*)$/i.exec(resto);
  const numero = mn ? mn[1].toUpperCase().replace('S/N', 'SN') : (resto ? '' : 'SN');
  let compl = mn ? mn[2].trim() : resto;
  let bairro = '';
  const i2 = a2.lastIndexOf(WJ);
  if (i2 >= 0) {
    bairro = a2.slice(i2 + 1).trim();
    const antes = a2.slice(0, i2).replace(/,\s*$/, '').trim();
    if (antes) compl = [compl, antes].filter(Boolean).join(' ');
  } else if (a2) {
    bairro = a2;
  }
  return { rua, numero: numero || 'SN', complemento: compl.replace(/\s+/g, ' ').slice(0, 60), bairro };
}

/**
 * Saco pelo peso do pedido (os quatro cadastrados na Frenet em 19/09/2026). O peso que vai
 * na etiqueta é o do pedido mais 50 g de embalagem, nunca menos de 100 g.
 */
export const SACOS = {
  P:  { id: 72838, nome: 'Saco P',  alt: 10, larg: 15, comp: 24, ate: 0.35 },
  M:  { id: 72839, nome: 'Saco M',  alt: 8,  larg: 25, comp: 30, ate: 0.8 },
  G:  { id: 72840, nome: 'Saco G',  alt: 10, larg: 30, comp: 40, ate: 1.5 },
  GG: { id: 72841, nome: 'Saco GG', alt: 12, larg: 35, comp: 45, ate: Infinity },
};
export function sacoPorPeso(pesoG) {
  const kg = (Number(pesoG) || 0) / 1000;
  return Object.keys(SACOS).find(k => kg <= SACOS[k].ate);
}
export function pesoEtiquetaKg(pesoG) {
  // Em gramas inteiros: 0,7 × 20 em ponto flutuante dá 14,000000000000002 e subiria para 0,75.
  const g = Math.round(Number(pesoG) || 0) + 50;
  return Math.max(0.1, Math.ceil(g / 50) * 50 / 1000);
}

/**
 * Regra do serviço (decidida pela Bárbara em 08/10/2026):
 *  - a cliente escolheu e pagou um serviço → compra esse (o prazo que ela viu);
 *  - frete grátis (R$0) ou fixo de R$24,90 → a loja paga, vai o mais barato entre Loggi e
 *    Correios ("sempre o mais barato"); Sedex nunca entra sozinho.
 * Devolve o código Frenet do serviço da cliente e se a regra é "mais barato".
 */
export function servicoCliente(titulo) {
  const t = String(titulo || '').toLowerCase();
  if (/loggi/.test(t)) return 'LOG_DRPOFF';
  if (/sedex/.test(t)) return '03220';
  if (/pac/.test(t)) return '03298';
  return null;
}
export function regraDoPedido(cobrado, titulo) {
  const c = num(cobrado);
  if (c === 0 || Math.abs(c - 24.9) < 0.01) return 'mais_barato';
  return servicoCliente(titulo) ? 'cliente' : 'mais_barato';
}

const fmtCep = z => { const d = String(z || '').replace(/\D/g, ''); return d.length === 8 ? d.slice(0, 5) + '-' + d.slice(5) : d; };
const fmtCpf = c => { const d = String(c || '').replace(/\D/g, ''); return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : d; };
const fmtTel = t => {
  let d = String(t || '').replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
};

export function normalizar(o) {
  const a = o.shippingAddress || {};
  const end = separarEndereco(a.address1, a.address2);
  const cpfExt = ((o.localizationExtensions && o.localizationExtensions.edges) || [])
    .map(e => e.node).find(n => n.purpose === 'TAX' || /CPF|TAX_CREDENTIAL/i.test(n.key || ''));
  const sl = o.shippingLine || {};
  const cobrado = num(sl.discountedPriceSet && sl.discountedPriceSet.shopMoney && sl.discountedPriceSet.shopMoney.amount);
  const peso = Math.round(o.totalWeight || 0);
  return {
    numero: o.name,
    id: String(o.legacyResourceId || ''),
    nome: a.name || [a.firstName, a.lastName].filter(Boolean).join(' ') || null,
    cpf: cpfExt ? fmtCpf(cpfExt.value) : null,
    email: o.email || null,
    telefone: fmtTel(a.phone || o.phone),
    cep: fmtCep(a.zip),
    rua: end.rua, numero_end: end.numero, complemento: end.complemento, bairro: end.bairro,
    cidade: a.city || null, uf: a.provinceCode || null,
    metodo: sl.title || null,
    servico_cliente: servicoCliente(sl.title),
    cobrado,
    valor: num(o.currentTotalPriceSet && o.currentTotalPriceSet.shopMoney && o.currentTotalPriceSet.shopMoney.amount),
    peso_g: peso,
    peso_kg: pesoEtiquetaKg(peso),
    pecas: o.currentSubtotalLineItemsQuantity || 0,
    saco: sacoPorPeso(peso),
    regra: regraDoPedido(cobrado, sl.title),
    pago: ['PAID', 'PARTIALLY_REFUNDED'].includes(o.displayFinancialStatus) && !o.cancelledAt,
    enviado: o.displayFulfillmentStatus === 'FULFILLED',
  };
}

const QUERY = `query($q: String) {
  orders(first: 50, query: $q) {
    edges { node {
      name legacyResourceId email phone cancelledAt displayFinancialStatus displayFulfillmentStatus
      totalWeight currentSubtotalLineItemsQuantity
      currentTotalPriceSet { shopMoney { amount } }
      shippingLine { title discountedPriceSet { shopMoney { amount } } }
      shippingAddress { name firstName lastName address1 address2 city provinceCode zip phone }
      localizationExtensions(first: 5) { edges { node { key purpose value } } }
    } }
  }
}`;

export function lerNumeros(param) {
  return [...new Set(String(param || '').split(/[,\s]+/).map(s => s.replace(/\D/g, '')).filter(Boolean))].slice(0, 50);
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });
  const numeros = lerNumeros(new URL(request.url).searchParams.get('numeros'));
  if (!numeros.length) return new Response(JSON.stringify({ erro: 'informe ?numeros=9266,9265' }), { status: 400, headers });
  try {
    const q = numeros.map(n => `name:#${n}`).join(' OR ');
    const r = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { q } }),
    });
    if (!r.ok) throw new Error(`Shopify GraphQL: HTTP ${r.status}`);
    const j = await r.json();
    if (j.errors) throw new Error('GraphQL: ' + JSON.stringify(j.errors));
    const pedidos = j.data.orders.edges.map(e => normalizar(e.node)).filter(p => numeros.includes(p.numero.replace(/\D/g, '')));
    const achados = new Set(pedidos.map(p => p.numero.replace(/\D/g, '')));
    return new Response(JSON.stringify({ pedidos, faltando: numeros.filter(n => !achados.has(n)).map(n => '#' + n) }), { headers });
  } catch (err) {
    return new Response(JSON.stringify({ erro: err.message }), { status: 502, headers });
  }
}
