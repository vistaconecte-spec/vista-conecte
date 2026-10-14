/**
 * /api/bling-nfe: notas fiscais pelo Bling. SÓ LEITURA nesta primeira etapa.
 *
 * GET ?acao=status                    → token guardado? vence quando? escopos
 * GET ?acao=previa&data=2026-10-14    → pedidos de venda do Bling no dia, com a nota de cada
 *                                       um (ou a falta dela). &ate=AAAA-MM-DD pra um intervalo,
 *                                       &max=30 limita quantos pedidos são abertos um a um.
 * GET ?acao=get&caminho=/pedidos/vendas/123
 *                                     → GET cru na API do Bling, pra conferir o formato dos
 *                                       dados antes de escrever a emissão. Só GET, sempre.
 *
 * A emissão (gerar-nfe + enviar) entra depois que a prévia bater com o que a equipe emite à
 * mão: nota autorizada só cancela em 24h, então não existe "testar emitindo".
 */
import { bling, tokenValido, statusToken, json, esperar, PAUSA_MS } from '../_bling.js';

const DATA = /^\d{4}-\d{2}-\d{2}$/;

function hojeSP() {
  return new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
}

export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;
  const acao = q.get('acao') || 'status';
  try {
    if (acao === 'status') {
      return json({ secret_gravado: !!env.BLING_CLIENT_SECRET, token: await statusToken(env) });
    }

    if (acao === 'get') {
      const caminho = q.get('caminho') || '';
      if (!caminho.startsWith('/') || caminho.includes('://')) return json({ erro: 'caminho deve começar com / (ex.: /pedidos/vendas?limite=5)' }, 400);
      return json(await bling(env, caminho));
    }

    if (acao === 'previa') {
      const de = q.get('data') || hojeSP();
      const ate = q.get('ate') || de;
      if (!DATA.test(de) || !DATA.test(ate)) return json({ erro: 'data no formato AAAA-MM-DD' }, 400);
      const max = Math.min(parseInt(q.get('max') || '30', 10) || 30, 40);
      const token = await tokenValido(env);

      const lista = [];
      for (let pagina = 1; pagina <= 5; pagina++) {
        const d = await bling(env, `/pedidos/vendas?pagina=${pagina}&limite=100&dataInicial=${de}&dataFinal=${ate}`, { token });
        const itens = (d && d.data) || [];
        lista.push(...itens);
        if (itens.length < 100) break;
        await esperar(PAUSA_MS);
      }

      // A listagem não diz se o pedido já tem nota; o detalhe diz (notaFiscal.id). Abre um
      // por um com pausa, até `max`, pra não estourar o limite do Bling nem o da Cloudflare.
      const pedidos = [];
      for (const p of lista.slice(0, max)) {
        await esperar(PAUSA_MS);
        let det = null, erro = null;
        try { det = (await bling(env, `/pedidos/vendas/${p.id}`, { token })).data; } catch (e) { erro = e.message; }
        const nf = det && det.notaFiscal && det.notaFiscal.id ? det.notaFiscal.id : null;
        pedidos.push({
          id: p.id,
          numero: p.numero,
          numero_loja: p.numeroLoja || (det && det.numeroLoja) || null,
          data: p.data,
          total: p.total,
          cliente: p.contato ? p.contato.nome : null,
          situacao: p.situacao ? (p.situacao.valor ?? p.situacao.id) : null,
          loja: p.loja ? p.loja.id : null,
          nota_fiscal_id: nf,
          erro,
        });
      }
      return json({
        de, ate,
        total_no_bling: lista.length,
        abertos: pedidos.length,
        sem_nota: pedidos.filter(p => !p.nota_fiscal_id && !p.erro).length,
        com_nota: pedidos.filter(p => p.nota_fiscal_id).length,
        faltou_abrir: Math.max(0, lista.length - pedidos.length),
        pedidos,
      });
    }

    return json({ erro: 'acao desconhecida (status, previa, get)' }, 400);
  } catch (e) {
    return json({ erro: e.message, status: e.status || null }, e.status && e.status < 500 ? e.status : 502);
  }
}
