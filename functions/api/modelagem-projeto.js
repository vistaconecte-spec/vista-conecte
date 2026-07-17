/**
 * Cloudflare Pages Function: /api/modelagem-projeto
 * GET  ?id=123                → detalhe do modelo (croquis, audaces, consumo, alterações)
 * POST { id, acao, ... }      → mutações:
 *   acao='criar'            { title, category }
 *   acao='consumo'          { larguraTecido, consumoPorPeca, observacoes }
 *   acao='alteracao-add'    { description }
 *   acao='alteracao-toggle' { alteracaoId }
 */
const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
const USER_ID = 1; // admin fixo "Conecte Vista" — app não tem login por usuário

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

async function sbGet(env, path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders(env) });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbInsert(env, table, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: sbHeaders(env, { Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${table}: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows[0];
}

async function sbUpsert(env, table, conflictCol, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${conflictCol}`, {
    method: 'POST',
    headers: sbHeaders(env, { Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`UPSERT ${table}: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows[0];
}

async function sbPatch(env, path, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: sbHeaders(env, { Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${path}: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows[0];
}

async function carregarDetalhe(env, id) {
  const [projetos, croquis, audaces, consumo, alteracoes] = await Promise.all([
    sbGet(env, `projects?id=eq.${id}&select=*`),
    sbGet(env, `project_croquis?projectId=eq.${id}&select=id,name,fileKey,createdAt&order=createdAt.desc`),
    sbGet(env, `project_files?projectId=eq.${id}&category=eq.audaces&select=id,name,fileKey,size,createdAt&order=createdAt.desc`),
    sbGet(env, `project_fabric_consumption?projectId=eq.${id}&select=*`),
    sbGet(env, `project_changes?projectId=eq.${id}&select=*&order=createdAt.desc`),
  ]);
  if (!projetos.length) return null;
  return {
    projeto: projetos[0],
    croquis,
    audaces,
    consumo: consumo[0] || null,
    alteracoes,
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ erro: 'SUPABASE_SERVICE_ROLE_KEY não configurada' }), { status: 500, headers });
  }

  try {
    if (request.method === 'GET') {
      const id = new URL(request.url).searchParams.get('id');
      if (!id) return new Response(JSON.stringify({ erro: 'informe ?id=' }), { status: 400, headers });
      const detalhe = await carregarDetalhe(env, id);
      if (!detalhe) return new Response(JSON.stringify({ erro: 'projeto não encontrado' }), { status: 404, headers });
      return new Response(JSON.stringify(detalhe), { headers });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const { acao } = body;

      if (acao === 'criar') {
        const { title, category } = body;
        if (!title) return new Response(JSON.stringify({ erro: 'informe title' }), { status: 400, headers });
        const projeto = await sbInsert(env, 'projects', {
          title, category: category || null, createdById: USER_ID,
        });
        return new Response(JSON.stringify({ projeto }), { headers });
      }

      const { id } = body;
      if (!id) return new Response(JSON.stringify({ erro: 'informe id' }), { status: 400, headers });

      if (acao === 'consumo') {
        const { larguraTecido, consumoPorPeca, observacoes } = body;
        const consumo = await sbUpsert(env, 'project_fabric_consumption', 'projectId', {
          projectId: Number(id), larguraTecido: larguraTecido ?? null, consumoPorPeca: consumoPorPeca ?? null, observacoes: observacoes ?? null,
        });
        return new Response(JSON.stringify({ consumo }), { headers });
      }

      if (acao === 'alteracao-add') {
        const { description } = body;
        if (!description) return new Response(JSON.stringify({ erro: 'informe description' }), { status: 400, headers });
        const existentes = await sbGet(env, `project_changes?projectId=eq.${id}&select=id`);
        const versao = `v${existentes.length + 1}`;
        const alteracao = await sbInsert(env, 'project_changes', {
          projectId: Number(id), version: versao, description, responsibleId: USER_ID, status: 'pending',
        });
        return new Response(JSON.stringify({ alteracao }), { headers });
      }

      if (acao === 'alteracao-toggle') {
        const { alteracaoId } = body;
        if (!alteracaoId) return new Response(JSON.stringify({ erro: 'informe alteracaoId' }), { status: 400, headers });
        const [atual] = await sbGet(env, `project_changes?id=eq.${alteracaoId}&select=status`);
        if (!atual) return new Response(JSON.stringify({ erro: 'alteração não encontrada' }), { status: 404, headers });
        const novoStatus = atual.status === 'pending' ? 'done' : 'pending';
        const patch = novoStatus === 'done'
          ? { status: 'done', doneAt: Date.now(), doneById: USER_ID }
          : { status: 'pending', doneAt: null, doneById: null };
        const alteracao = await sbPatch(env, `project_changes?id=eq.${alteracaoId}`, patch);
        return new Response(JSON.stringify({ alteracao }), { headers });
      }

      return new Response(JSON.stringify({ erro: 'ação desconhecida' }), { status: 400, headers });
    }

    return new Response(JSON.stringify({ erro: 'método não suportado' }), { status: 405, headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
