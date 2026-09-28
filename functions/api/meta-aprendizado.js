/**
 * Cloudflare Pages Function: /api/meta-aprendizado (somente leitura)
 * Mostra a fase de aprendizado de cada conjunto ativo e os anúncios ativos dentro dele.
 * A Meta guarda o aprendizado no CONJUNTO (learning_stage_info), não no anúncio:
 *   LEARNING = aprendendo, SUCCESS = saiu do aprendizado, FAIL = aprendizado limitado.
 * Chamada barata (não expande criativo), pra não estourar o rate limit da conta (80004).
 */
const API_VERSION = 'v23.0';
const CONTA_PADRAO = 'act_968164338120112';

export async function onRequest(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const token = env.META_ACCESS_TOKEN;
  if (!token) return new Response(JSON.stringify({ erro: 'META_ACCESS_TOKEN não configurado' }), { status: 500, headers });
  const conta = env.META_AD_ACCOUNT_ID || CONTA_PADRAO;

  const buscarTudo = async (api) => {
    const itens = [];
    let guard = 0;
    while (api && guard < 10) {
      guard++;
      const r = await fetch(api);
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(JSON.stringify(d.error || `HTTP ${r.status}`));
      itens.push(...(d.data || []));
      api = d.paging && d.paging.next;
    }
    return itens;
  };

  try {
    const soAtivo = encodeURIComponent(JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }]));
    const camposConjunto = encodeURIComponent('name,effective_status,campaign{name},learning_stage_info,daily_budget,created_time,updated_time');
    const camposAnuncio = encodeURIComponent('name,effective_status,created_time,updated_time,adset_id');
    const [conjuntos, anuncios] = await Promise.all([
      buscarTudo(`https://graph.facebook.com/${API_VERSION}/${conta}/adsets?fields=${camposConjunto}&filtering=${soAtivo}&limit=100&access_token=${encodeURIComponent(token)}`),
      buscarTudo(`https://graph.facebook.com/${API_VERSION}/${conta}/ads?fields=${camposAnuncio}&filtering=${soAtivo}&limit=100&access_token=${encodeURIComponent(token)}`),
    ]);

    const saida = conjuntos.map((c) => ({
      id: c.id,
      conjunto: c.name,
      campanha: c.campaign && c.campaign.name,
      aprendizado: (c.learning_stage_info && c.learning_stage_info.status) || null,
      aprendizado_detalhe: c.learning_stage_info || null,
      orcamento_diario: c.daily_budget ? Number(c.daily_budget) / 100 : null,
      atualizado_em: c.updated_time,
      anuncios: anuncios
        .filter((a) => a.adset_id === c.id)
        .map((a) => ({ id: a.id, anuncio: a.name, criado_em: a.created_time, atualizado_em: a.updated_time })),
    }));
    return new Response(JSON.stringify({ conjuntos: saida }, null, 2), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 502, headers });
  }
}
