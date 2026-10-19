/**
 * Portal de trocas da cliente (/trocas + /api/trocas-portal, 19/10/2026).
 *
 * Trava:
 *  1. prazos da Bárbara: troca/crédito até 30 dias, dinheiro de volta até 7 (contando da
 *     entrega, ou do envio + trânsito estimado quando a Shopify não sabe a entrega);
 *  2. a página nunca decide preço, prazo nem opção de troca: tudo é conferido contra o pedido;
 *  3. o endpoint responde IGUAL para pedido inexistente e e-mail errado, e não grava e-mail,
 *     telefone nem endereço no Supabase (a chave anon é pública);
 *  4. a importação no painel não duplica e respeita o que a equipe excluiu.
 *
 * Rodar:  node tests/trocas-portal.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as T from '../functions/_trocas.js';
import { onRequestPost } from '../functions/api/trocas-portal.js';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
let falhas = 0, total = 0;
function ok(nome, real, esperado) {
  total++;
  const bateu = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bateu) { falhas++; console.log(`  ✗ ${nome}\n      esperado: ${JSON.stringify(esperado)}\n      obtido:   ${JSON.stringify(real)}`); }
  else console.log(`  ✓ ${nome}`);
}

const DIA = 86400000;
const enviadoEm = '2026-10-08T13:26:24Z';
const pedido = (extra = {}) => ({
  name: '#9250', email: 'Lais@Exemplo.com', cancelledAt: null,
  customer: { firstName: 'Lais' }, shippingAddress: { firstName: 'Lais', name: 'Lais Jarilho' },
  fulfillments: [{ createdAt: enviadoEm, deliveredAt: null, status: 'SUCCESS' }],
  lineItems: { nodes: [
    { id: 'gid://shopify/LineItem/1', title: 'Calça Pantalona', variantTitle: 'Uva / G', quantity: 1, currentQuantity: 1,
      image: { url: 'https://cdn/x.png' }, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '135.95' } },
      variant: { id: 'v-uva-g' },
      product: { variants: { nodes: [{ id: 'v-uva-g', title: 'Uva / G' }, { id: 'v-uva-m', title: 'Uva / M' }, { id: 'v-nude-g', title: 'Nude / G' }] } } },
    { id: 'gid://shopify/LineItem/2', title: 'Calça Bolso Frontal', variantTitle: 'Preta / G', quantity: 2, currentQuantity: 2,
      image: null, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '152.05' } },
      variant: { id: 'v-preta-g' }, product: { variants: { nodes: [{ id: 'v-preta-g', title: 'Preta / G' }] } } },
    { id: 'gid://shopify/LineItem/3', title: 'Peça removida', variantTitle: 'P', quantity: 1, currentQuantity: 0,
      discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '99' } }, variant: { id: 'z' }, product: { variants: { nodes: [] } } },
  ] },
  ...extra,
});
const recebido = new Date(new Date(enviadoEm).getTime() + T.TRANSITO_ESTIMADO_DIAS * DIA);
const dias = n => new Date(recebido.getTime() + n * DIA);

console.log('\n1) Prazos');
{
  const p5 = T.prazos(pedido(), dias(5));
  ok('5 dias depois: troca e dinheiro de volta', [p5.pode_trocar, p5.pode_devolver], [true, true]);
  ok('sem data de entrega, conta envio + trânsito e avisa que é estimado', [p5.recebido_em, p5.recebimento_estimado], [recebido.toISOString(), true]);
  const p10 = T.prazos(pedido(), dias(10));
  ok('10 dias depois: só troca/crédito', [p10.pode_trocar, p10.pode_devolver], [true, false]);
  const p31 = T.prazos(pedido(), dias(31));
  ok('31 dias depois: nada', [p31.pode_trocar, p31.pode_devolver], [false, false]);
  const entregue = pedido({ fulfillments: [{ createdAt: enviadoEm, deliveredAt: '2026-10-10T15:00:00Z', status: 'SUCCESS' }] });
  const pe = T.prazos(entregue, new Date('2026-10-17T20:00:00Z'));
  ok('com data de entrega real: conta dela (7º dia ainda vale até 23:59 de Brasília)', [pe.recebimento_estimado, pe.pode_devolver], [false, true]);
  ok('7º dia acaba 23:59 de Brasília', T.prazos(entregue, new Date('2026-10-18T03:00:00Z')).pode_devolver, false);
  ok('pedido não enviado não abre prazo', T.prazos(pedido({ fulfillments: [] })).enviado, false);
  ok('envio cancelado não conta', T.prazos(pedido({ fulfillments: [{ createdAt: enviadoEm, status: 'CANCELLED' }] })).enviado, false);
}

console.log('\n2) O que a página vê do pedido');
{
  const pub = T.pedidoPublico(pedido(), [], dias(3));
  ok('peça removida do pedido não aparece', pub.itens.map(i => i.titulo), ['Calça Pantalona', 'Calça Bolso Frontal']);
  ok('opções de troca sem a variante atual', pub.itens[0].opcoes_troca.map(o => o.titulo), ['Uva / M', 'Nude / G']);
  ok('preço pago (com desconto do pedido)', pub.itens[0].valor_unit, 135.95);
  ok('sem e-mail, endereço nem nome completo', [pub.email, pub.shippingAddress, pub.primeiro_nome], [undefined, undefined, 'Lais']);
  const ja = T.pedidoPublico(pedido(), [{ itens: [{ line_id: 'gid://shopify/LineItem/2', qtd: 1 }] }], dias(3));
  ok('unidade já pedida no portal sai da conta', ja.itens[1].qtd_disponivel, 1);
  const comRet = pedido({ returns: { nodes: [
    { status: 'REQUESTED', returnLineItems: { nodes: [{ quantity: 1, fulfillmentLineItem: { lineItem: { id: 'gid://shopify/LineItem/1' } } }] } },
    { status: 'DECLINED', returnLineItems: { nodes: [{ quantity: 1, fulfillmentLineItem: { lineItem: { id: 'gid://shopify/LineItem/2' } } }] } },
  ] } });
  const pr = T.pedidoPublico(comRet, [], dias(3));
  ok('devolução já pedida pela Shopify sai da conta (recusada não)', [pr.itens[0].qtd_disponivel, pr.itens[1].qtd_disponivel], [0, 2]);
}

console.log('\n3) Conferência do envio');
{
  const pub = T.pedidoPublico(pedido(), [], dias(3));
  const troca = { line_id: 'gid://shopify/LineItem/1', tipo: 'troca', nova_variante_id: 'v-uva-m', motivo: 'Ficou grande', obs: '  ficou   larga  ' };
  const v = T.validarSolicitacao(pub, [troca]);
  ok('troca válida guarda a variante nova e limpa o texto', [v.itens?.[0].nova_variante, v.itens?.[0].obs, v.itens?.[0].valor_unit], ['Uva / M', 'ficou larga', 135.95]);
  ok('variante que não é do produto é recusada', !!T.validarSolicitacao(pub, [{ ...troca, nova_variante_id: 'outro-produto' }]).erro, true);
  ok('peça de outro pedido é recusada', !!T.validarSolicitacao(pub, [{ ...troca, line_id: 'gid://shopify/LineItem/999' }]).erro, true);
  ok('motivo fora da lista é recusado', !!T.validarSolicitacao(pub, [{ ...troca, motivo: 'qualquer' }]).erro, true);
  ok('preço mandado pela página é ignorado', T.validarSolicitacao(pub, [{ ...troca, valor_unit: 9999 }]).itens[0].valor_unit, 135.95);
  const credito = { line_id: 'gid://shopify/LineItem/2', tipo: 'credito', motivo: 'Ficou pequeno', qtd: 2 };
  ok('duas unidades de crédito', T.validarSolicitacao(pub, [credito]).itens?.[0].qtd, 2);
  ok('mais unidades do que veio é recusado', !!T.validarSolicitacao(pub, [{ ...credito, qtd: 3 }]).erro, true);
  ok('mesma linha duas vezes passando do total é recusado', !!T.validarSolicitacao(pub, [{ ...credito, qtd: 1 }, { ...credito, qtd: 2 }]).erro, true);
  const tarde = T.pedidoPublico(pedido(), [], dias(12));
  ok('dinheiro de volta depois de 7 dias é recusado', /7 dias/.test(T.validarSolicitacao(tarde, [{ ...credito, tipo: 'devolucao' }]).erro || ''), true);
  ok('crédito depois de 7 dias ainda vale', !T.validarSolicitacao(tarde, [credito]).erro, true);
  ok('nada marcado', !!T.validarSolicitacao(pub, []).erro, true);
  ok('pedido cancelado', !!T.validarSolicitacao(T.pedidoPublico(pedido({ cancelledAt: '2026-10-09' }), [], dias(3)), [troca]).erro, true);
  ok('protocolo curto', T.protocolo('troca-portal:9250-mgx7k2ab'), 'TP9250-K2AB');
}

console.log('\n4) Endpoint (Shopify e Supabase simulados)');
{
  const gravados = [];
  const env = { SHOPIFY_STORE_DOMAIN: 'loja.myshopify.com', SHOPIFY_ADMIN_TOKEN: 'x' };
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('graphql.json')) {
      const q = JSON.parse(opts.body).variables.q;
      const nodes = q === 'name:#9250' ? [pedido({ fulfillments: [{ createdAt: new Date(Date.now() - 3 * DIA).toISOString(), status: 'SUCCESS' }] })] : [];
      return new Response(JSON.stringify({ data: { orders: { nodes } } }));
    }
    if (opts.method === 'POST') { gravados.push(JSON.parse(opts.body)); return new Response(null, { status: 201 }); }
    return new Response('[]');
  };
  const chamar = async (body) => {
    const r = await onRequestPost({ env, request: new Request('https://x/api/trocas-portal', { method: 'POST', body: JSON.stringify(body) }) });
    return { status: r.status, j: await r.json() };
  };
  const errado = await chamar({ acao: 'consultar', pedido: '9250', email: 'outra@x.com' });
  const naoExiste = await chamar({ acao: 'consultar', pedido: '1', email: 'lais@exemplo.com' });
  ok('e-mail errado e pedido inexistente respondem igual', [errado.status, errado.j.erro], [naoExiste.status, naoExiste.j.erro]);
  const certo = await chamar({ acao: 'consultar', pedido: '#9250', email: ' LAIS@exemplo.com ' });
  ok('e-mail sem diferença de maiúscula/espaço abre o pedido', [certo.status, certo.j.itens?.length], [200, 2]);
  const env1 = await chamar({ acao: 'enviar', pedido: '9250', email: 'lais@exemplo.com', itens: [{ line_id: 'gid://shopify/LineItem/1', tipo: 'troca', nova_variante_id: 'v-nude-g', motivo: 'Cor diferente do esperado' }] });
  ok('envio grava uma linha troca-portal:9250-*', [env1.status, gravados.length, /^troca-portal:9250-/.test(gravados[0]?.id)], [200, 1, true]);
  const txt = JSON.stringify(gravados[0]);
  ok('nada de e-mail na linha gravada', /@/.test(txt), false);
  ok('protocolo devolvido bate com o gravado', env1.j.protocolo, gravados[0]?.dados.protocolo);
}

console.log('\n5) Importação no painel (main.js)');
{
  const main = readFileSync(join(raiz, 'main.js'), 'utf8');
  const a = main.indexOf('const PORTAL_PREFIXO'), b = main.indexOf('let _portalImportando');
  const { portalParaListas, portalAcrescentar } = new Function(`const RET_TAMANHOS = ['PP','P','M','G','GG'];\n${main.slice(a, b)}\nreturn { portalParaListas, portalAcrescentar };`)();
  const doc = {
    id: 'troca-portal:9250-abc', protocolo: 'TP9250-XABC', pedido: '#9250', cliente: 'Lais Jarilho', criado_em: '2026-10-19T12:00:00Z',
    itens: [
      { line_id: 'l1', titulo: 'Calça Pantalona', variante: 'Uva / G', qtd: 1, valor_unit: 135.95, tipo: 'troca', nova_variante: 'Uva / M', motivo: 'Ficou grande', obs: '' },
      { line_id: 'l2', titulo: 'Calça Bolso Frontal', variante: 'Preta / G', qtd: 2, valor_unit: 152.05, tipo: 'credito', motivo: 'Ficou pequeno', obs: 'cintura' },
    ],
  };
  const { ret, est } = portalParaListas([doc, { id: 'outra-coisa', itens: [{}] }]);
  ok('troca vai para TROCA com o tamanho novo no campo de tamanho', [ret.length, ret[0].obs, ret[0].pedido], [1, 'M', '#9250']);
  ok('crédito vai para DEVOLUÇÃO com valor das 2 unidades', [est.length, est[0].valor, est[0].forma, est[0].motivo], [1, 304.1, 'credito', 'Crédito na loja · Ficou pequeno · cintura']);
  const cfg = { itens: [{ id: ret[0].id }], removidos: [] };
  ok('já importado não entra de novo', portalAcrescentar(cfg, ret), 0);
  const cfgEst = { itens: [], removidos: [{ id: est[0].id, em: '2026-10-19' }] };
  ok('o que a equipe excluiu não volta', portalAcrescentar(cfgEst, est), 0);
  ok('novo entra', portalAcrescentar({ itens: [], removidos: [] }, est), 1);
}

console.log('\n6) A rota é pública no middleware');
{
  const mw = readFileSync(join(raiz, 'functions/api/_middleware.js'), 'utf8');
  ok('/api/trocas-portal no PUBLICO', /PUBLICO = new Set\([^)]*'\/api\/trocas-portal'/s.test(mw), true);
}

console.log(falhas ? `\n✗ ${falhas} de ${total} falharam` : `\n✓ TODOS OS TESTES PASSARAM — ${total}/${total}`);
if (falhas) process.exit(1);
