/**
 * Cloudflare Pages Function: /api/modelagem-upload
 * POST multipart/form-data { projectId, tipo: 'audaces'|'croqui', file, name? }
 * Sobe o arquivo pro Supabase Storage (bucket "modelagem") e grava a metadado
 * em project_files (audaces) ou project_croquis (croqui).
 */
const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
const BUCKET = 'modelagem';
const USER_ID = 1;

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

function slug(s) {
  return (s || 'arquivo').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120);
}

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ erro: 'SUPABASE_SERVICE_ROLE_KEY não configurada' }), { status: 500, headers });
  }
  if (request.method !== 'POST') return new Response(JSON.stringify({ erro: 'use POST' }), { status: 405, headers });

  try {
    const form = await request.formData();
    const projectId = form.get('projectId');
    const tipo = form.get('tipo');
    const file = form.get('file');
    if (!projectId || !tipo || !file) {
      return new Response(JSON.stringify({ erro: 'informe projectId, tipo e file' }), { status: 400, headers });
    }
    if (!['audaces', 'croqui'].includes(tipo)) {
      return new Response(JSON.stringify({ erro: 'tipo inválido' }), { status: 400, headers });
    }

    const originalName = file.name || 'arquivo';
    const hash = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const key = `projeto-${projectId}/${tipo}/${Date.now()}-${hash}-${slug(originalName)}`;

    const bytes = await file.arrayBuffer();
    const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${encodeURI(key)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': file.type || 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: bytes,
    });
    if (!up.ok) {
      return new Response(JSON.stringify({ erro: 'falha no upload', detalhe: await up.text() }), { status: 502, headers });
    }

    const url = `/api/modelagem-storage?key=${encodeURIComponent(key)}`;
    const table = tipo === 'croqui' ? 'project_croquis' : 'project_files';
    const rowBody = tipo === 'croqui'
      ? { projectId: Number(projectId), name: originalName, fileKey: key, url, mimeType: file.type || null, size: bytes.byteLength, uploadedById: USER_ID }
      : { projectId: Number(projectId), name: originalName, fileKey: key, url, mimeType: file.type || null, size: bytes.byteLength, category: 'audaces', uploadedById: USER_ID };

    const ins = await fetch(`${SB_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: sbHeaders(env, { Prefer: 'return=representation' }),
      body: JSON.stringify(rowBody),
    });
    if (!ins.ok) {
      return new Response(JSON.stringify({ erro: 'falha ao gravar metadado', detalhe: await ins.text() }), { status: 502, headers });
    }
    const rows = await ins.json();
    return new Response(JSON.stringify({ arquivo: rows[0] }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
