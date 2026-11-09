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
//
// TETO DO FRETE (09/11/2026): no Sul, Sudeste e Centro-Oeste a cliente paga no máximo R$ 35, a loja paga o resto.
// Veio de um checkout abandonado em Goiânia (Cozy + Pantalona Moletom, 3,6 kg, Loggi R$ 54,17). Vale pra
// qualquer pedido, 1 peça ou mais, sem data pra acabar. A Frenet não tem teto (o "valor fixo" dela também
// SOBE o frete barato), então a linha sai daqui: quando o frete mais barato do carrinho passa de R$ 35, entra
// "Frete com desconto" a R$ 35 ao lado da Loggi e do PAC da Frenet (a Shopify pré-marca a mais barata).
// O título não cita Loggi nem PAC, então a expedição compra o mais barato (regraDoPedido), que é o que a loja
// paga. Acima de R$ 80 de frete (CEP fora de rota, Loggi de R$ 139 a 246) não entra.
// Brasil todo foi barrado por ela no mesmo dia. Decisão final pela conversão do checkout (10/09 a 09/11,
// pedidos x abandonos que viram o frete): Sul/Sudeste com frete de R$ 35 a 80 converte 33% contra 54% com
// frete barato; Centro-Oeste 45% contra 60%. Nordeste e Norte de R$ 35 a 80 convertem igual ao frete barato
// (47% x 48%): teto lá só dá dinheiro sem trazer venda. Frete acima de R$ 80 (fora de rota) também não entra.
// Custo nos pedidos que já vinham ~R$ 70/mês; ganho esperado ~3 vendas/mês. Medir em 09/12/2026.
//
// FRETE GRÁTIS DESLIGADO desde 09/11/2026 16h02 (teste B, medição em 12/11): gratisLigado=false. Religar =
// true aqui + regras 248694/248695 da Frenet + textos do tema e da Vi (backups *-20261109-teste-frete).
import { cotar, normalizarCep } from './frenet-cotacao.js';

export const REGRA = {
  gratisLigado: false, // teste B
  tetoCliente: 35, // a cliente paga no máximo isto
  tetoAte: 80, // frete acima disto não ganha teto (CEP fora de rota)
  // Sul, Sudeste e Centro-Oeste (DF/GO 70000-76799, MT/MS 78000-79999); RO 76800-76999 e TO 77xxx são Norte
  faixasTeto: [[1000000, 39999999], [70000000, 76799999], [78000000, 99999999]],
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

const comTeto = description => [{
  service_name: 'Frete com desconto',
  service_code: 'FRETE_TETO_35',
  total_price: String(REGRA.tetoCliente * 100),
  currency: 'BRL',
  description,
}];

const temTeto = cep => {
  const n = parseInt(String(cep || '').replace(/\D/g, '').padEnd(8, '0').slice(0, 8), 10);
  return REGRA.faixasTeto.some(([de, ate]) => n >= de && n <= ate);
};

const gratis = description => [{
  service_name: 'Frete grátis',
  service_code: 'FRETE_GRATIS_2_PECAS',
  total_price: '0',
  currency: 'BRL',
  description,
}];

export async function tarifas(rate, { token, agora = Date.now(), cotarFn = cotar, gratisLigado = REGRA.gratisLigado } = {}) {
  const destino = (rate && rate.destination) || {};
  if (String(destino.country || 'BR').toUpperCase() !== 'BR') return [];
  // Brinde de R$ 0 não é peça comprada; conjunto é 1 item e conta 1 (decisão de 03/11/2026).
  const itens = ((rate && rate.items) || []).filter(i => i.requires_shipping !== false && Number(i.price) > 0);
  const pecas = itens.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  const total = itens.reduce((s, i) => s + Number(i.price) * (Number(i.quantity) || 0), 0);
  if (!pecas) return [];
  const promo = gratisLigado && agora <= REGRA.fim && pecas >= REGRA.minimoPecas;

  if (promo && noSulSudeste(destino.postal_code) && total <= REGRA.tetoSulSudeste) {
    return gratis('Black Friday: 2 peças no Sul e Sudeste');
  }

  const cep = normalizarCep(destino.postal_code);
  if (!cep || !token) return [];
  if (!promo && !temTeto(cep)) return []; // nada a oferecer: nem cota
  const gramas = itens.reduce((s, i) => s + (Number(i.grams) || 0) * (Number(i.quantity) || 0), 0);
  let barata;
  try {
    const opcoes = await cotarFn(token, { cep, valor: total / 100, peso: Math.max(gramas / 1000, 0.35) });
    barata = opcoes.find(o => o.cliente_paga != null);
  } catch (e) {
    return [];
  }
  if (!barata) return [];
  const prazo = barata.prazo_dias ? `, ${barata.prazo_dias} dias úteis` : '';
  if (promo && !noSulSudeste(destino.postal_code) && total < REGRA.tetoBrasil && barata.cliente_paga < REGRA.freteMaximo) {
    return gratis(`Black Friday: levando 2 peças${prazo}`);
  }
  if (temTeto(cep) && barata.cliente_paga > REGRA.tetoCliente && barata.cliente_paga <= REGRA.tetoAte) {
    return comTeto(`Loggi ou Correios${prazo}`);
  }
  return [];
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
