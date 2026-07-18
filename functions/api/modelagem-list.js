/**
 * Cloudflare Pages Function: /api/modelagem-list
 * Lista os modelos (projetos) como "pastas" pra grid da aba Modelagem.
 * GET → { projetos: [{ id, title, category, status, croquiKey, alteracoesPendentes, temAudaces, pendenciasAbertas, semConsumo }] }
 */
const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';

function sbHeaders(env, extra = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Accept-Profile': 'modelagem',
    'Content-Profile': 'modelagem',
    'Content-Type': 'application/json',
    ...extra,
  };
}

export async function onRequest(context) {
  const { env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ erro: 'SUPABASE_SERVICE_ROLE_KEY não configurada' }), { status: 500, headers });
  }

  try {
    const [projRes, croquiRes, changesRes, filesRes, pendenciasRes, consumoRes] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/projects?select=id,title,category,status,createdAt&order=title.asc`, { headers: sbHeaders(env) }),
      fetch(`${SB_URL}/rest/v1/project_croquis?select=projectId,fileKey,createdAt&order=createdAt.desc`, { headers: sbHeaders(env) }),
      fetch(`${SB_URL}/rest/v1/project_changes?select=projectId,status`, { headers: sbHeaders(env) }),
      fetch(`${SB_URL}/rest/v1/project_files?select=projectId,category`, { headers: sbHeaders(env) }),
      fetch(`${SB_URL}/rest/v1/project_pendencias?select=projectId,resolved`, { headers: sbHeaders(env) }),
      fetch(`${SB_URL}/rest/v1/project_fabric_consumption?select=projectId,larguraTecido,consumoPorPeca`, { headers: sbHeaders(env) }),
    ]);
    if (!projRes.ok) {
      return new Response(JSON.stringify({ erro: 'projects', detalhe: await projRes.text() }), { status: 502, headers });
    }
    const projects = await projRes.json();
    const croquis = croquiRes.ok ? await croquiRes.json() : [];
    const changes = changesRes.ok ? await changesRes.json() : [];
    const files = filesRes.ok ? await filesRes.json() : [];
    const pendencias = pendenciasRes.ok ? await pendenciasRes.json() : [];
    const consumos = consumoRes.ok ? await consumoRes.json() : [];

    const croquiPorProjeto = {};
    for (const c of croquis) if (!croquiPorProjeto[c.projectId]) croquiPorProjeto[c.projectId] = c.fileKey;

    const pendentesPorProjeto = {};
    for (const c of changes) if (c.status === 'pending') pendentesPorProjeto[c.projectId] = (pendentesPorProjeto[c.projectId] || 0) + 1;

    const audacesPorProjeto = {};
    for (const f of files) if (f.category === 'audaces') audacesPorProjeto[f.projectId] = true;

    const pendenciasAbertasPorProjeto = {};
    for (const p of pendencias) if (!p.resolved) pendenciasAbertasPorProjeto[p.projectId] = (pendenciasAbertasPorProjeto[p.projectId] || 0) + 1;

    const consumoPreenchidoPorProjeto = {};
    for (const c of consumos) if ((c.larguraTecido || '').trim() || (c.consumoPorPeca || '').trim()) consumoPreenchidoPorProjeto[c.projectId] = true;

    const out = projects.map(p => ({
      id: p.id,
      title: p.title,
      category: p.category,
      status: p.status,
      croquiKey: croquiPorProjeto[p.id] || null,
      alteracoesPendentes: pendentesPorProjeto[p.id] || 0,
      temAudaces: !!audacesPorProjeto[p.id],
      pendenciasAbertas: pendenciasAbertasPorProjeto[p.id] || 0,
      semConsumo: !consumoPreenchidoPorProjeto[p.id],
    }));

    return new Response(JSON.stringify({ projetos: out }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
