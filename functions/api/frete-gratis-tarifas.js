// Tarifa "Frete grátis" da Black (04/11/2026): a Shopify chama esta rota no checkout (CarrierService).
//
// Por que existe: a promessa é "leve 2 peças, frete grátis no Sul e Sudeste". A Frenet só enxerga
// VALOR (regras 248694/248695, carrinho a partir de R$ 200) e o desconto de frete da Shopify só
// enxerga PEÇAS (não filtra estado). Sobrava um buraco: 2 peças abaixo de R$ 200 pagavam frete.
// Esta rota é a única que vê peças e CEP juntos, e cobre só esse buraco.
//
// Falha segura: a Frenet continua ligada do lado. Se esta rota cair, some só a linha "Frete grátis"
// e o checkout segue com Loggi e PAC. Por isso aqui não tem chamada externa nem nada que possa travar.
// É pública (a Shopify não manda cookie) e não devolve dado nenhum: só responde sobre o carrinho recebido.
//
// Regra da expedição: frete R$ 0 cai em "mais barato entre Loggi e PAC" (regraDoPedido), como os outros grátis.

export const REGRA = {
  fim: Date.parse('2026-11-30T23:59:59-03:00'),
  minimoPecas: 2,
  tetoCentavos: 20000, // a partir daqui quem zera é a Frenet; repetir daria 3 linhas de R$ 0
  faixasCep: [[1000000, 39999999], [80000000, 99999999]], // Sudeste e Sul, as mesmas faixas da Frenet
};

const noSulSudeste = cep => {
  const n = parseInt(String(cep || '').replace(/\D/g, '').padEnd(8, '0').slice(0, 8), 10);
  return REGRA.faixasCep.some(([de, ate]) => n >= de && n <= ate);
};

export function tarifas(rate, agora = Date.now()) {
  if (agora > REGRA.fim) return [];
  const destino = (rate && rate.destination) || {};
  if (String(destino.country || 'BR').toUpperCase() !== 'BR') return [];
  if (!noSulSudeste(destino.postal_code)) return [];
  // Brinde de R$ 0 não é peça comprada; conjunto é 1 item e conta 1 (decisão de 03/11/2026).
  const itens = ((rate && rate.items) || []).filter(i => i.requires_shipping !== false && Number(i.price) > 0);
  const pecas = itens.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  const total = itens.reduce((s, i) => s + Number(i.price) * (Number(i.quantity) || 0), 0);
  if (pecas < REGRA.minimoPecas || total > REGRA.tetoCentavos) return [];
  return [{
    service_name: 'Frete grátis',
    service_code: 'FRETE_GRATIS_2_PECAS',
    total_price: '0',
    currency: 'BRL',
    description: 'Black Friday: 2 peças no Sul e Sudeste',
  }];
}

export async function onRequestPost({ request }) {
  let rates = [];
  try {
    const corpo = await request.json();
    rates = tarifas(corpo && corpo.rate);
  } catch (e) {
    rates = [];
  }
  return new Response(JSON.stringify({ rates }), { headers: { 'Content-Type': 'application/json' } });
}
