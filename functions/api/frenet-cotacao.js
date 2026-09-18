/**
 * Cloudflare Pages Function: /api/frenet-cotacao (somente leitura)
 *
 * Cota o frete na Frenet do jeito que o checkout da loja cota, para o SAC responder
 * "quanto fica o frete pra tal CEP" sem montar um carrinho de mentira (pedido da Bárbara,
 * 18/09/2026). Devolve o que a cliente paga E o preço de tabela por trás, porque é a
 * diferença entre os dois que a loja banca (a regra da Frenet fixa a Loggi em R$19 em boa
 * parte do país; a tabela em SP é R$27, no combo pesado passa de R$49).
 *
 *   GET /api/frenet-cotacao?cep=01310100&valor=149&peso=0.35
 *     cep    destino (só dígitos ou com hífen)
 *     valor  valor da compra em R$ (entra no ad valorem/GRIS da transportadora)
 *     peso   peso em kg; se faltar, 0,35 (uma peça leve embalada, mínimo que a Loggi cobra)
 *   → { cep, valor, peso, opcoes: [{ servico, transportadora, codigo, prazo_dias,
 *        cliente_paga, tabela, erro }], gerado_em }
 *
 * Token: env.FRENET_TOKEN (chave de acesso do painel da Frenet, Profile > Chaves de acesso).
 * A caixa padrão (30×25×10 cm) é a que a Frenet usa quando o app da Shopify não manda
 * medidas; o peso cubado dela é 1,25 kg, então pra peça pesada é o `peso` que manda.
 */
const ORIGEM_CEP = '88067200'; // Loja Conecte, Florianópolis (mesmo CEP que a Shopify manda)
const CAIXA = { Height: 10, Length: 30, Width: 25 };

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

export async function cotar(token, { cep, valor, peso }, fetchFn = fetch) {
  const body = {
    SellerCEP: ORIGEM_CEP, RecipientCEP: cep, ShipmentInvoiceValue: valor, RecipientCountry: 'BR',
    ShippingItemArray: [{ ...CAIXA, Weight: peso, Quantity: 1 }],
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
  try {
    const opcoes = await cotar(env.FRENET_TOKEN, { cep, valor, peso });
    return new Response(JSON.stringify({ cep, valor, peso, opcoes, gerado_em: new Date().toISOString() }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 502, headers });
  }
}
