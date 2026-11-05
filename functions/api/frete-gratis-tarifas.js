// Tarifa "Frete grátis" da Black (04/11/2026): a Shopify chama esta rota no checkout (CarrierService).
//
// Por que existe: a promessa é "leve 2 peças, frete grátis no Sul, Sudeste e regiões com frete abaixo
// de R$ 30". A Frenet só enxerga VALOR (regras 248694/248695, carrinho a partir de R$ 200) e o desconto
// de frete da Shopify só enxerga PEÇAS (não filtra estado). Esta rota é a única que vê os dois.
//   Sul e Sudeste: 2 peças até R$ 200 (daí pra cima quem zera é a Frenet).
//   Resto do Brasil: 2 peças quando o frete mais barato DAQUELE carrinho, cotado na Frenet, fica abaixo
//   de R$ 30. É por carrinho e não por estado porque o valor muda com peso e cidade (PB capital R$ 29
//   num pacote leve, pedidos reais de 2 peças em torno de R$ 40).
//
// Falha segura: a Frenet continua ligada do lado. Se esta rota cair ou a cotação demorar, some só a
// linha "Frete grátis" e o checkout segue com Loggi e PAC. É pública (a Shopify não manda cookie) e não
// devolve dado da loja: só responde sobre o carrinho recebido.
//
// Regra da expedição: frete R$ 0 cai em "mais barato entre Loggi e PAC" (regraDoPedido), como os outros grátis.
import { cotar, normalizarCep } from './frenet-cotacao.js';

export const REGRA = {
  fim: Date.parse('2026-11-30T23:59:59-03:00'),
  minimoPecas: 2,
  tetoSulSudeste: 20000, // a partir daqui quem zera é a Frenet; repetir daria 3 linhas de R$ 0
  tetoBrasil: 66900, // regra 244790 da Frenet: grátis no Brasil todo a partir daqui
  freteMaximo: 30, // "menor que R$ 30"
  esperaCotacaoMs: 4000,
  faixasCep: [[1000000, 39999999], [80000000, 99999999]], // Sudeste e Sul, as mesmas faixas da Frenet
};

const noSulSudeste = cep => {
  const n = parseInt(String(cep || '').replace(/\D/g, '').padEnd(8, '0').slice(0, 8), 10);
  return REGRA.faixasCep.some(([de, ate]) => n >= de && n <= ate);
};

const gratis = description => [{
  service_name: 'Frete grátis',
  service_code: 'FRETE_GRATIS_2_PECAS',
  total_price: '0',
  currency: 'BRL',
  description,
}];

export async function tarifas(rate, { token, agora = Date.now(), cotarFn = cotar } = {}) {
  if (agora > REGRA.fim) return [];
  const destino = (rate && rate.destination) || {};
  if (String(destino.country || 'BR').toUpperCase() !== 'BR') return [];
  // Brinde de R$ 0 não é peça comprada; conjunto é 1 item e conta 1 (decisão de 03/11/2026).
  const itens = ((rate && rate.items) || []).filter(i => i.requires_shipping !== false && Number(i.price) > 0);
  const pecas = itens.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  const total = itens.reduce((s, i) => s + Number(i.price) * (Number(i.quantity) || 0), 0);
  if (pecas < REGRA.minimoPecas) return [];

  if (noSulSudeste(destino.postal_code)) {
    return total > REGRA.tetoSulSudeste ? [] : gratis('Black Friday: 2 peças no Sul e Sudeste');
  }

  const cep = normalizarCep(destino.postal_code);
  if (!cep || !token || total >= REGRA.tetoBrasil) return [];
  const gramas = itens.reduce((s, i) => s + (Number(i.grams) || 0) * (Number(i.quantity) || 0), 0);
  try {
    const opcoes = await cotarFn(token, { cep, valor: total / 100, peso: Math.max(gramas / 1000, 0.35) });
    const barata = opcoes.find(o => o.cliente_paga != null);
    if (!barata || barata.cliente_paga >= REGRA.freteMaximo) return [];
    const prazo = barata.prazo_dias ? `, ${barata.prazo_dias} dias úteis` : '';
    return gratis(`Black Friday: levando 2 peças${prazo}`);
  } catch (e) {
    return [];
  }
}

// Espera curta: passou disso, a cliente vê Loggi e PAC como sempre em vez de um checkout parado.
const cotarComEspera = (token, pedido) => cotar(token, pedido,
  (url, opcoes) => fetch(url, { ...opcoes, signal: AbortSignal.timeout(REGRA.esperaCotacaoMs) }));

export async function onRequestPost({ request, env }) {
  let rates = [];
  try {
    const corpo = await request.json();
    rates = await tarifas(corpo && corpo.rate, { token: env.FRENET_TOKEN, cotarFn: cotarComEspera });
  } catch (e) {
    rates = [];
  }
  return new Response(JSON.stringify({ rates }), { headers: { 'Content-Type': 'application/json' } });
}
