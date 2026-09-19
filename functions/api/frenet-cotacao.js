/**
 * Cloudflare Pages Function: /api/frenet-cotacao (somente leitura)
 *
 * Cota o frete na Frenet do jeito que o checkout da loja cota, para o SAC responder
 * "quanto fica o frete pra tal CEP" sem montar um carrinho de mentira (pedido da Bárbara,
 * 18/09/2026). Devolve o que a cliente paga E o preço de tabela por trás, porque é a
 * diferença entre os dois que a loja banca (a regra da Frenet fixa a Loggi em R$19 em boa
 * parte do país; a tabela em SP é R$27, no combo pesado passa de R$49).
 *
 *   GET /api/frenet-cotacao?cep=01310100&valor=149&peso=0.35&alt=10&larg=15&comp=24
 *     cep    destino (só dígitos ou com hífen)
 *     valor  valor da compra em R$ (entra no ad valorem/GRIS da transportadora)
 *     peso   peso em kg; se faltar, 0,35 (uma peça leve embalada, mínimo que a Loggi cobra)
 *     alt/larg/comp  medidas da embalagem em cm; se faltar, o Saco P (24×15×10), que é a
 *                    embalagem padrão da Frenet e a que o checkout da loja usa
 *   → { cep, valor, peso, opcoes: [{ servico, transportadora, codigo, prazo_dias,
 *        cliente_paga, tabela, erro }], gerado_em }
 *
 * Token: env.FRENET_TOKEN (chave de acesso do painel da Frenet, Profile > Chaves de acesso).
 * A transportadora cobra pelo maior entre o peso e o cubado (alt × larg × comp ÷ 6000):
 * o Saco P cuba 0,6 kg; uma caixa 30×25×10 cubaria 1,25 kg e inflava a cotação em R$5 a 8
 * (foi o erro da simulação de 18/09/2026).
 */
const ORIGEM_CEP = '88067200'; // Loja Conecte, Florianópolis (mesmo CEP que a Shopify manda)
const SACO_P = { Height: 10, Length: 24, Width: 15 };

const num = v => Math.round((parseFloat(v) || 0) * 100) / 100;

export function normalizarCep(cep) {
  const d = String(cep || '').replace(/\D/g, '');
  return d.length === 8 ? d : null;
}

/** Converte a resposta da Frenet no formato do card; erro de um serviço não derruba os outros. */
export function montarOpcoes(resposta) {
  const lista = (resposta && resposta.ShippingSevicesArray) || [];
  return lista.map(s => ({
    servico: s.ServiceDescription || s.ServiceCode,
    transportadora: s.Carrier || '',
    codigo: s.ServiceCode || '',
    prazo_dias: s.Error ? null : parseInt(s.DeliveryTime, 10) || null,
    cliente_paga: s.Error ? null : num(s.ShippingPrice),
    tabela: s.Error ? null : num(s.OriginalShippingPrice || s.ShippingPrice),
    erro: s.Error ? (s.Msg || 'sem cotação') : null,
  })).sort((a, b) => (a.cliente_paga ?? 1e9) - (b.cliente_paga ?? 1e9));
}

export async function cotar(token, { cep, valor, peso, alt, larg, comp }, fetchFn = fetch) {
  const caixa = (alt && larg && comp) ? { Height: alt, Length: comp, Width: larg } : SACO_P;
  const body = {
    SellerCEP: ORIGEM_CEP, RecipientCEP: cep, ShipmentInvoiceValue: valor, RecipientCountry: 'BR',
    ShippingItemArray: [{ ...caixa, Weight: peso, Quantity: 1 }],
  };
  const r = await fetchFn('https://api.frenet.com.br/shipping/quote', {
    method: 'POST',
    headers: { token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Frenet HTTP ${r.status}`);
  return montarOpcoes(await r.json());
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (!env.FRENET_TOKEN) return new Response(JSON.stringify({ erro: 'FRENET_TOKEN não configurado' }), { status: 500, headers });
  const url = new URL(request.url);
  const cep = normalizarCep(url.searchParams.get('cep'));
  if (!cep) return new Response(JSON.stringify({ erro: 'CEP inválido (precisa de 8 dígitos)' }), { status: 400, headers });
  const valor = num(url.searchParams.get('valor')) || 149;
  const peso = Math.max(0.05, parseFloat(url.searchParams.get('peso')) || 0.35);
  const dim = k => Math.min(200, Math.max(0, parseInt(url.searchParams.get(k), 10) || 0));
  const alt = dim('alt'), larg = dim('larg'), comp = dim('comp');
  try {
    const opcoes = await cotar(env.FRENET_TOKEN, { cep, valor, peso, alt, larg, comp });
    return new Response(JSON.stringify({ cep, valor, peso, alt, larg, comp, opcoes, gerado_em: new Date().toISOString() }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 502, headers });
  }
}
