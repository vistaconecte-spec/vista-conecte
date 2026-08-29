/**
 * Cloudflare Pages Function: /api/modelagem-projeto
 * GET  ?id=123                → detalhe do modelo (croquis, fotos, audaces, consumo, alterações, pendências)
 * POST { id, acao, ... }      → mutações:
 *   acao='criar'            { title, category }
 *   acao='consumo'          { larguraTecido, consumoPorPeca, observacoes }
 *   acao='alteracao-add'    { description }
 *   acao='alteracao-toggle' { alteracaoId }
 *   acao='alteracao-edit'   { alteracaoId, description }
 *   acao='pendencia-add'    { description }
 *   acao='pendencia-toggle' { pendenciaId }
 *   acao='pendencia-edit'   { pendenciaId, description }
 *   acao='medidas'          { medidas }            → grava JSON (texto) na coluna projects.medidas
 *   acao='valor-ajuste'     { valorAjuste }        → grava texto na coluna projects.valorAjuste
 *   acao='arquivo-remover'  { tipo, fileId }       → tipo 'croqui'|'foto'|'audaces'; apaga a linha e o objeto do Storage
 *   acao='projeto-excluir'  { }                    → apaga o modelo inteiro: tabelas filhas + objetos do Storage
 */
const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
const BUCKET = 'modelagem';
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

async function sbDelete(env, path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: sbHeaders(env),
  });
  if (!r.ok) throw new Error(`DELETE ${path}: ${r.status} ${await r.text()}`);
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

// Apaga objetos do Storage em UMA requisição só (endpoint em lote do Supabase, o mesmo
// que o `remove()` do supabase-js usa). Um DELETE por arquivo estouraria o limite de
// ~50 subrequisições por invocação do plano gratuito da Cloudflare num modelo com muita foto.
// Best-effort de propósito: a linha no banco é a fonte da verdade e objeto órfão no
// Storage não quebra nada — falhar aqui não pode impedir a exclusão do registro.
async function storageRemover(env, keys) {
  const lista = [...new Set((keys || []).filter(Boolean))];
  if (!lista.length) return;
  await fetch(`${SB_URL}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefixes: lista }),
  }).catch(() => {});
}

async function carregarDetalhe(env, id) {
  const [projetos, croquis, fotos, audaces, consumo, alteracoes, pendencias] = await Promise.all([
    sbGet(env, `projects?id=eq.${id}&select=*`),
    sbGet(env, `project_croquis?projectId=eq.${id}&select=id,name,fileKey,createdAt&order=createdAt.desc`),
    sbGet(env, `project_files?projectId=eq.${id}&category=eq.foto&select=id,name,fileKey,createdAt&order=createdAt.desc`),
    sbGet(env, `project_files?projectId=eq.${id}&category=eq.audaces&select=id,name,fileKey,size,createdAt&order=createdAt.desc`),
    sbGet(env, `project_fabric_consumption?projectId=eq.${id}&select=*`),
    sbGet(env, `project_changes?projectId=eq.${id}&select=*&order=createdAt.desc`),
    sbGet(env, `project_pendencias?projectId=eq.${id}&select=*&order=createdAt.desc`),
  ]);
  if (!projetos.length) return null;
  return {
    projeto: projetos[0],
    croquis,
    fotos,
    audaces,
    consumo: consumo[0] || null,
    alteracoes,
    pendencias,
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

      if (acao === 'alteracao-edit') {
        const { alteracaoId, description } = body;
        if (!alteracaoId || !description) return new Response(JSON.stringify({ erro: 'informe alteracaoId e description' }), { status: 400, headers });
        const alteracao = await sbPatch(env, `project_changes?id=eq.${alteracaoId}`, { description });
        return new Response(JSON.stringify({ alteracao }), { headers });
      }

      if (acao === 'pendencia-add') {
        const { description } = body;
        if (!description) return new Response(JSON.stringify({ erro: 'informe description' }), { status: 400, headers });
        const pendencia = await sbInsert(env, 'project_pendencias', {
          projectId: Number(id), description, resolved: false, createdById: USER_ID,
        });
        return new Response(JSON.stringify({ pendencia }), { headers });
      }

      if (acao === 'pendencia-toggle') {
        const { pendenciaId } = body;
        if (!pendenciaId) return new Response(JSON.stringify({ erro: 'informe pendenciaId' }), { status: 400, headers });
        const [atual] = await sbGet(env, `project_pendencias?id=eq.${pendenciaId}&select=resolved`);
        if (!atual) return new Response(JSON.stringify({ erro: 'pendência não encontrada' }), { status: 404, headers });
        const patch = atual.resolved
          ? { resolved: false, resolvedAt: null }
          : { resolved: true, resolvedAt: Date.now() };
        const pendencia = await sbPatch(env, `project_pendencias?id=eq.${pendenciaId}`, patch);
        return new Response(JSON.stringify({ pendencia }), { headers });
      }

      if (acao === 'pendencia-edit') {
        const { pendenciaId, description } = body;
        if (!pendenciaId || !description) return new Response(JSON.stringify({ erro: 'informe pendenciaId e description' }), { status: 400, headers });
        const pendencia = await sbPatch(env, `project_pendencias?id=eq.${pendenciaId}`, { description });
        return new Response(JSON.stringify({ pendencia }), { headers });
      }

      if (acao === 'medidas') {
        const { medidas } = body;
        const projeto = await sbPatch(env, `projects?id=eq.${id}`, { medidas: JSON.stringify(medidas || {}) });
        return new Response(JSON.stringify({ projeto }), { headers });
      }

      if (acao === 'valor-ajuste') {
        const { valorAjuste } = body;
        const projeto = await sbPatch(env, `projects?id=eq.${id}`, { valorAjuste: (valorAjuste ?? '').toString() });
        return new Response(JSON.stringify({ projeto }), { headers });
      }

      if (acao === 'arquivo-remover') {
        const { tipo, fileId } = body;
        if (!['croqui', 'foto', 'audaces'].includes(tipo) || !fileId) {
          return new Response(JSON.stringify({ erro: 'informe tipo (croqui|foto|audaces) e fileId' }), { status: 400, headers });
        }
        const tabela = tipo === 'croqui' ? 'project_croquis' : 'project_files';
        const [row] = await sbGet(env, `${tabela}?id=eq.${fileId}&projectId=eq.${id}&select=id,fileKey`);
        if (!row) return new Response(JSON.stringify({ erro: 'arquivo não encontrado' }), { status: 404, headers });
        await storageRemover(env, [row.fileKey]);
        await sbDelete(env, `${tabela}?id=eq.${fileId}`);
        return new Response(JSON.stringify({ ok: true }), { headers });
      }

      if (acao === 'projeto-excluir') {
        // `id` entra direto na URL do PostgREST e aqui o verbo é DELETE: um valor que não
        // seja número poderia virar outro filtro (`neq.0`) e varrer a tabela inteira.
        const pid = Number(id);
        if (!Number.isInteger(pid) || pid <= 0) {
          return new Response(JSON.stringify({ erro: 'id inválido' }), { status: 400, headers });
        }
        const [projeto] = await sbGet(env, `projects?id=eq.${pid}&select=id,title`);
        if (!projeto) return new Response(JSON.stringify({ erro: 'projeto não encontrado' }), { status: 404, headers });

        // O schema `modelagem` veio do app antigo SEM foreign key nenhuma — apagar só a linha
        // de `projects` deixaria croquis, arquivos, pagamentos e histórico órfãos no banco e os
        // objetos pendurados no Storage. Por isso cada tabela filha é apagada explicitamente
        // aqui. Se surgir tabela nova com `projectId`, ela precisa entrar nesta lista.
        const [croquis, arquivos, alteracoes, modelagens] = await Promise.all([
          sbGet(env, `project_croquis?projectId=eq.${pid}&select=fileKey`),
          sbGet(env, `project_files?projectId=eq.${pid}&select=fileKey`),
          sbGet(env, `project_changes?projectId=eq.${pid}&select=id`),
          sbGet(env, `modelagens?projectId=eq.${pid}&select=id`),
        ]);
        const idsAlteracoes = alteracoes.map(a => a.id);
        const idsModelagens = modelagens.map(m => m.id);

        // Netos: mídia de alteração e o que pende de uma "modelagem" interna (tabelas do app
        // antigo, ainda com dado dentro). `in.()` vazio é erro de sintaxe no PostgREST — daí os guardas.
        const [changeMedias, mdlAlteracoes, mdlArquivos] = await Promise.all([
          idsAlteracoes.length ? sbGet(env, `project_change_medias?changeId=in.(${idsAlteracoes})&select=fileKey`) : [],
          idsModelagens.length ? sbGet(env, `modelagem_alteracoes?modelagemId=in.(${idsModelagens})&select=id`) : [],
          idsModelagens.length ? sbGet(env, `modelagem_files?modelagemId=in.(${idsModelagens})&select=fileKey`) : [],
        ]);
        const idsMdlAlteracoes = mdlAlteracoes.map(a => a.id);
        const mdlMedias = idsMdlAlteracoes.length
          ? await sbGet(env, `modelagem_alteracao_medias?alteracaoId=in.(${idsMdlAlteracoes})&select=fileKey`)
          : [];

        await storageRemover(env, [...croquis, ...arquivos, ...changeMedias, ...mdlArquivos, ...mdlMedias].map(r => r.fileKey));

        // Filhas primeiro, `projects` por último: se algo falhar no meio, o modelo continua
        // aparecendo na lista e dá para mandar excluir de novo. Na ordem inversa o registro
        // sumiria da tela deixando lixo que ninguém mais alcança.
        if (idsMdlAlteracoes.length) await sbDelete(env, `modelagem_alteracao_medias?alteracaoId=in.(${idsMdlAlteracoes})`);
        if (idsModelagens.length) {
          await Promise.all([
            sbDelete(env, `modelagem_alteracoes?modelagemId=in.(${idsModelagens})`),
            sbDelete(env, `modelagem_files?modelagemId=in.(${idsModelagens})`),
            sbDelete(env, `modelagem_infos?modelagemId=in.(${idsModelagens})`),
          ]);
        }
        if (idsAlteracoes.length) await sbDelete(env, `project_change_medias?changeId=in.(${idsAlteracoes})`);
        await Promise.all([
          sbDelete(env, `modelagens?projectId=eq.${pid}`),
          sbDelete(env, `project_changes?projectId=eq.${pid}`),
          sbDelete(env, `project_croquis?projectId=eq.${pid}`),
          sbDelete(env, `project_fabric_consumption?projectId=eq.${pid}`),
          sbDelete(env, `project_files?projectId=eq.${pid}`),
          sbDelete(env, `project_messages?projectId=eq.${pid}`),
          sbDelete(env, `project_payments?projectId=eq.${pid}`),
          sbDelete(env, `project_pendencias?projectId=eq.${pid}`),
          sbDelete(env, `project_status_history?projectId=eq.${pid}`),
          sbDelete(env, `project_tech_info?projectId=eq.${pid}`),
        ]);
        await sbDelete(env, `projects?id=eq.${pid}`);
        return new Response(JSON.stringify({ ok: true, excluido: projeto.title }), { headers });
      }

      return new Response(JSON.stringify({ erro: 'ação desconhecida' }), { status: 400, headers });
    }

    return new Response(JSON.stringify({ erro: 'método não suportado' }), { status: 405, headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
