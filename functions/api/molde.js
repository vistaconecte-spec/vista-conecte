/**
 * Cloudflare Pages Function: /api/molde
 * O molde como o CORTE precisa ver — recorte só-leitura da aba MODELAGEM.
 *
 *   GET            → { moldes: [{ id, title, category, croquiKey, temArquivo, versao, atualizadoEm }] }
 *   GET ?id=123    → { projeto, croquis, fotos, arquivos, medidas, consumo, alteracoes }
 *
 * POR QUE NÃO REUSAR /api/modelagem-projeto (29/08/2026)
 * Esta é a única rota da modelagem que o perfil 'corte' alcança (ver _middleware.js), e o
 * detalhe completo carrega `valorAjuste` — quanto se deve à modelista por aquele projeto.
 * Dinheiro não é assunto do cortador, e a regra do app é que o aparelho da oficina não
 * chega em pedido, cliente nem preço. Aqui o campo nem é buscado: o `select` lista coluna
 * por coluna de propósito, para que coluna nova na tabela `projects` não vaze sozinha.
 *
 * A VERSÃO DO MOLDE é calculada AQUI, pela data de envio (o mais antigo é V1), e não na
 * tela: a modelista reenvia o arquivo com o mesmo nome, então o número da versão é a única
 * forma de o cortador saber se o papel na mesa dele é o atual. Com o cálculo no servidor,
 * a aba MODELAGEM e a aba CORTE não têm como discordar sobre qual é a atual.
 */
const SB_URL = 'https://hckzsblwyabmhzbjdjgx.supabase.co';

function sbHeaders(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Accept-Profile': 'modelagem',
    'Content-Profile': 'modelagem',
    'Content-Type': 'application/json',
  };
}

async function sbGet(env, path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders(env) });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

// O Postgres devolve o createdAt SEM fuso ("2026-08-03T16:52:28.9") e o valor é UTC. Sem o
// 'Z' o navegador lê como hora local e mostra 3h a mais (e o dia errado em envio da noite).
const comFuso = iso => {
  const s = String(iso || '');
  if (!s) return null;
  return /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : s + 'Z';
};
const ms = iso => {
  const t = new Date(comFuso(iso) || 0).getTime();
  return isNaN(t) ? 0 : t;
};

// Numera os arquivos de molde pela ordem de envio: o mais antigo é V1, o último é o ATUAL.
// Empate de data cai no id, que é crescente — dois envios no mesmo segundo não embaralham.
function versionar(arquivos) {
  const porData = [...arquivos].sort((a, b) => (ms(a.createdAt) - ms(b.createdAt)) || (a.id - b.id));
  return porData.map((a, i) => ({
    id: a.id,
    name: a.name,
    fileKey: a.fileKey,
    size: a.size ?? null,
    createdAt: comFuso(a.createdAt),
    versao: i + 1,
    atual: i === porData.length - 1,
  })).reverse(); // mais recente no topo, que é como as duas telas mostram
}

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ erro: 'SUPABASE_SERVICE_ROLE_KEY não configurada' }), { status: 500, headers });
  }
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ erro: 'somente leitura' }), { status: 405, headers });
  }

  const id = new URL(request.url).searchParams.get('id');

  try {
    // ── LISTA: só o suficiente para a aba CORTE casar modelo com projeto ──────
    if (!id) {
      const [projects, croquis, arquivos] = await Promise.all([
        sbGet(env, 'projects?select=id,title,category,status&order=title.asc'),
        sbGet(env, 'project_croquis?select=projectId,fileKey,createdAt&order=createdAt.desc'),
        sbGet(env, 'project_files?category=eq.audaces&select=id,projectId,createdAt'),
      ]);

      const croquiPorProjeto = {};
      for (const c of croquis) if (!croquiPorProjeto[c.projectId]) croquiPorProjeto[c.projectId] = c.fileKey;

      const arqPorProjeto = {};
      for (const a of arquivos) (arqPorProjeto[a.projectId] ||= []).push(a);

      const moldes = projects.map(p => {
        const lista = versionar(arqPorProjeto[p.id] || []);
        const atual = lista[0] || null;
        return {
          id: p.id,
          title: p.title,
          category: p.category,
          status: p.status,
          croquiKey: croquiPorProjeto[p.id] || null,
          temArquivo: !!atual,
          versao: atual ? atual.versao : 0,
          atualizadoEm: atual ? atual.createdAt : null,
        };
      });
      return new Response(JSON.stringify({ moldes }), { headers });
    }

    // ── DETALHE: o que entra no papel do cortador ─────────────────────────────
    const idNum = Number(id);
    if (!Number.isInteger(idNum) || idNum <= 0) {
      return new Response(JSON.stringify({ erro: 'id inválido' }), { status: 400, headers });
    }

    const [projetos, croquis, fotos, arquivos, consumo, alteracoes] = await Promise.all([
      // Colunas listadas uma a uma: `select=*` traria valorAjuste (ver cabeçalho).
      sbGet(env, `projects?id=eq.${idNum}&select=id,title,category,status,medidas`),
      sbGet(env, `project_croquis?projectId=eq.${idNum}&select=id,name,fileKey,createdAt&order=createdAt.desc`),
      sbGet(env, `project_files?projectId=eq.${idNum}&category=eq.foto&select=id,name,fileKey,createdAt&order=createdAt.desc`),
      sbGet(env, `project_files?projectId=eq.${idNum}&category=eq.audaces&select=id,name,fileKey,size,createdAt`),
      sbGet(env, `project_fabric_consumption?projectId=eq.${idNum}&select=larguraTecido,consumoPorPeca,observacoes`),
      sbGet(env, `project_changes?projectId=eq.${idNum}&select=id,version,description,status,createdAt&order=createdAt.desc`),
    ]);
    if (!projetos.length) {
      return new Response(JSON.stringify({ erro: 'molde não encontrado' }), { status: 404, headers });
    }
    const p = projetos[0];

    let medidas = {};
    try { medidas = p.medidas ? JSON.parse(p.medidas) : {}; } catch (_) { medidas = {}; }

    return new Response(JSON.stringify({
      projeto: { id: p.id, title: p.title, category: p.category, status: p.status },
      croquis: croquis.map(c => ({ ...c, createdAt: comFuso(c.createdAt) })),
      fotos: fotos.map(f => ({ ...f, createdAt: comFuso(f.createdAt) })),
      arquivos: versionar(arquivos),
      medidas,
      consumo: consumo[0] || null,
      alteracoes: alteracoes.map(a => ({ ...a, createdAt: comFuso(a.createdAt) })),
    }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers });
  }
}
