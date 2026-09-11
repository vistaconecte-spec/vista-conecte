/**
 * Cloudflare Pages Function: /api/cartao-barrado — painel do resgate de cartão barrado
 * (functions/_cartao-barrado.js). Só a dona (sessão) ou quem tem ?k=WEBHOOK_KEY.
 *
 * GET ?acao=status                          → config, modo, template no Wati, webhook na Shopify, escopos
 * GET ?acao=casos                           → últimos casos (documentos cb:* do Supabase)
 * GET ?acao=simular&pedido=9057             → diagnóstico de um pedido, SEM efeito
 * GET ?acao=executar&pedido=9057&confirmar=1 → roda o resgate nesse pedido (link + WhatsApp + tag),
 *                                              ignorando a janela de 24h. É o jeito de resgatar
 *                                              um pedido de antes da automação existir.
 * GET ?acao=registrar-webhook&confirmar=1   → cria o orders/updated apontando pra cá
 * GET ?acao=remover-webhook&id=123&confirmar=1
 *
 * Está no PUBLICO do _middleware porque precisa aceitar a chave `k` (a dona não tem como
 * mandar cookie de um curl, e eu não tenho o API_TOKEN); a sessão é conferida AQUI.
 */
import { lerSessao } from '../_sessao.js';
import { igual, json, config, shopify, listarDocs, templateWati, diagnosticar, processarPedido } from '../_cartao-barrado.js';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const q = url.searchParams;
  const kOk = !!env.WEBHOOK_KEY && igual(q.get('k') || '', env.WEBHOOK_KEY);
  const sessao = kOk ? null : await lerSessao(request, env.SESSION_SECRET);
  if (!kOk && !(sessao && sessao.perfil === 'dona')) return json({ erro: 'não autorizado' }, 401);

  const cfg = config(env);
  const acao = q.get('acao') || 'status';
  const confirmar = q.get('confirmar') === '1';
  const sh = shopify(env);
  const rota = `${cfg.base}/api/webhook-shopify-pedido?k=${encodeURIComponent(env.WEBHOOK_KEY || '')}`;

  try {
    if (acao === 'status') {
      const [escopos, webhooks, template] = await Promise.all([
        sh.escopos().catch(e => ['erro: ' + e.message]),
        sh.webhooks().catch(e => [{ erro: e.message }]),
        env.WATI_TOKEN ? templateWati(env, cfg.template).catch(e => ({ erro: e.message })) : null,
      ]);
      const nosso = webhooks.filter(w => w.address && w.address.includes('/api/webhook-shopify-pedido'));
      return json({
        modo: cfg.ativo ? 'ATIVO (manda WhatsApp)' : 'observar (só registra)',
        config: { ...cfg, base: cfg.base },
        env: {
          WEBHOOK_KEY: !!env.WEBHOOK_KEY, WATI_TOKEN: !!env.WATI_TOKEN, PAGARME_SECRET_KEY: !!env.PAGARME_SECRET_KEY,
          MP_ACCESS_TOKEN: !!env.MP_ACCESS_TOKEN, SHOPIFY_CLIENT_SECRET: !!env.SHOPIFY_CLIENT_SECRET, SUPABASE_SERVICE_ROLE_KEY: !!env.SUPABASE_SERVICE_ROLE_KEY,
        },
        shopify: { write_orders: escopos.includes('write_orders'), read_orders: escopos.includes('read_orders'), escopos: escopos.length },
        webhook: nosso.length ? nosso.map(w => ({ id: w.id, topic: w.topic, address: w.address.replace(/k=[^&]+/, 'k=***'), api_version: w.api_version })) : 'NÃO registrado',
        template: template ? (template.erro ? template : { nome: template.elementName || template.name, status: template.status, categoria: template.category, params: (template.custom_params || []).map(p => p.name), corpo: template.body }) : 'WATI_TOKEN ausente ou template não encontrado',
      });
    }

    if (acao === 'casos') {
      const rows = await listarDocs(env, parseInt(q.get('limite') || '50', 10));
      return json({ total: rows.length, casos: rows.map(r => ({ ...r.dados, updated_at: r.updated_at })) });
    }

    if (acao === 'simular' || acao === 'executar') {
      let orderId = String(q.get('pedido') || '').trim();
      if (!orderId) return json({ erro: 'falta ?pedido=' }, 400);
      if (!/^\d{10,}$/.test(orderId)) {
        const o = await sh.porNome(orderId);
        if (!o) return json({ erro: `pedido ${orderId} não encontrado` }, 404);
        orderId = String(o.id);
      }
      if (acao === 'simular') {
        const [pedido, transacoes] = await Promise.all([sh.pedido(orderId), sh.transacoes(orderId)]);
        const diag = diagnosticar(pedido, transacoes, { janelaH: cfg.janelaPedidoH, ignorarJanela: true });
        return json({ modo: cfg.ativo ? 'ativo' : 'observar', diagnostico: diag, transacoes: transacoes.map(t => ({ kind: t.kind, status: t.status, gateway: t.gateway, em: t.created_at, msg: t.message })) });
      }
      if (!confirmar) return json({ erro: 'executar precisa de &confirmar=1' }, 400);
      return json(await processarPedido(env, orderId, { forcar: true, ignorarJanela: true }));
    }

    if (acao === 'registrar-webhook') {
      if (!env.WEBHOOK_KEY) return json({ erro: 'WEBHOOK_KEY ausente' }, 500);
      const existentes = (await sh.webhooks()).filter(w => w.topic === 'orders/updated' && w.address.includes('/api/webhook-shopify-pedido'));
      if (existentes.length) return json({ ok: true, ja_existia: existentes.map(w => w.id) });
      if (!confirmar) return json({ dry_run: true, criaria: { topic: 'orders/updated', address: rota.replace(/k=[^&]+/, 'k=***') } });
      const w = await sh.criarWebhook('orders/updated', rota);
      return json({ ok: true, criado: { id: w.id, topic: w.topic, api_version: w.api_version } });
    }

    if (acao === 'remover-webhook') {
      const id = q.get('id');
      if (!id || !confirmar) return json({ erro: 'precisa de &id= e &confirmar=1' }, 400);
      await sh.removerWebhook(id);
      return json({ ok: true, removido: id });
    }

    return json({ erro: 'ação desconhecida' }, 400);
  } catch (e) {
    return json({ erro: e.message }, 500);
  }
}
