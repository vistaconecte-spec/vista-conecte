let modeloAtual = 'macacao-amplo';
let saveTimer = null;

// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPABASE_URL  = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhja3pzYmx3eWFibWh6Ympkamd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNTEyOTIsImV4cCI6MjA5NDcyNzI5Mn0.guif8jtidWmfqykhgDgPJiaRbWLoEEDMp1usTlAs1dQ';
// NÃO chamar de `supabase`: a biblioteca do CDN declara `var supabase` no escopo global e
// `var` não pode redeclarar um `let` que já existe. O script do CDN morria com
// "Identifier 'supabase' has already been declared", window.supabase nunca aparecia e o
// Realtime NUNCA subiu — os aparelhos só se falavam pela varredura de 15s, que não roda
// em celular dormindo. Foi o pano de fundo da bagunça de estoque de 11/08/2026.
let   supabaseCli   = null;

function initSupabase() {
  try {
    if (window.supabase && SUPABASE_KEY !== '__SUPABASE_ANON_KEY__') {
      supabaseCli = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      iniciarRealtime();
      // CDN carregou → Realtime já ativo, carregarTodosNuvem já sincronizou tudo
      // Não chamar renderModeloNuvem aqui pois sobrescreveria edições locais não salvas
    }
  } catch(e) { console.warn('Supabase não disponível:', e.message); }
}

async function renderModeloNuvem(key) {
  const dadosNuvem = await carregarNuvem(key);
  // Guard: se o usuário navegou para outro modelo enquanto esperava, descarta
  if (key !== modeloAtual) return;
  if (dadosNuvem) {
    const dadosLocal = loadLocal('vc:' + key);
    const localAt  = dadosLocal?.updated_at || dadosLocal?.est_at || '';
    const nuvemAt  = dadosNuvem?.updated_at || dadosNuvem?.est_at || '';
    // Só sobrescreve o local se a nuvem for ESTRITAMENTE mais recente (ou local vazio)
    if (!dadosLocal || nuvemAt > localAt) {
      saveLocal('vc:' + key, dadosNuvem);
    }
  }
  renderModelo(key);
}

// ─── HISTÓRICO: TODA GRAVAÇÃO VIRA UMA VERSÃO QUE DÁ PRA VOLTAR ──────────────
// salvarNuvem é o funil de TUDO (modelos, financeiro, fluxo de caixa, precificação,
// atendimento…), então gravar a versão aqui cobre o sistema inteiro de uma vez.
//
// Em 11/08/2026 a dona desfez sem querer várias trocas de etiqueta e só deu para
// reconstruir porque havia cópias soltas do estoque tiradas por acaso naquela noite.
// Isso não pode depender de sorte.
//
// A versão fica numa linha `hist:<id>` da MESMA tabela (igual precificacao e
// baixas-estoque já fazem) — sem tabela nova, sem migração.
const HIST_PREFIXO = 'hist:';
const HIST_MAX = 25; // versões guardadas por chave

// ─── CADEADO DE ENTRADA (três perfis) ────────────────────────────────────────
// Até 11/08/2026 o INÍCIO e toda a CONFECÇÃO ficavam abertos: quem tivesse o link via
// pedidos, nomes de clientes, estoque e produção sem digitar nada. Só Financeiro, Fluxo,
// Precificação, Tráfego, Atendimento e Modelagem pediam senha.
//
//   dona    → senha que já valia nas abas protegidas; abre o app inteiro
//   corte   → senha do cortador; abre SÓ a aba CORTE
//   costura → senha da costureira; abre SÓ a aba COSTURA
//
// Desde 14/08/2026 quem confere a senha é o SERVIDOR: /api/login compara com um hash
// que mora em secret do Cloudflare e devolve um cookie HttpOnly assinado, e o
// middleware de functions/api/ exige esse cookie em toda rota. Antes o hash da senha
// vinha versionado aqui e a conferência rodava no navegador — escondia a tela, não o
// dado: quem chamasse /api/shopify-orders direto na URL via os pedidos sem senha.
// O cookie é HttpOnly, então este arquivo não consegue lê-lo; o navegador o manda
// sozinho em todo fetch de mesma origem.
const PERFIL_KEY   = 'vc:perfil';
// As abas que já eram protegidas usam a MESMA senha da dona. Entrar como dona libera
// todas de uma vez e o desbloqueio fica guardado no aparelho — antes era sessionStorage
// com uma chave por aba, então era redigitar em cada uma e a cada vez que reabria o app.
const ABAS_DA_DONA = ['fin-ok', 'flx-ok', 'prc-ok', 'traf-ok', 'atd-ok', 'conf-ok'];

function perfilAtual() {
  try { return localStorage.getItem(PERFIL_KEY) || null; } catch (e) { return null; }
}

function ehPerfilCorte() { return perfilAtual() === 'corte'; }
function ehPerfilCostura() { return perfilAtual() === 'costura'; }

// Corte e costura são os perfis de OFICINA: veem uma aba só, montada com o que já veio do
// Supabase, e não chamam /api nenhuma vez (o middleware devolve 403 pros dois). Tudo que
// só a dona pode fazer — baixa de estoque, avisos de status, buscar pedido na Shopify —
// pergunta por aqui, e não por ehPerfilCorte(), senão a costureira daria baixa em estoque.
function ehPerfilOficina() { return ehPerfilCorte() || ehPerfilCostura(); }

// Manda a senha pro servidor e devolve o perfil ('dona' | 'corte' | 'costura'), null se a senha
// estiver errada, ou false se nem deu para perguntar (sem rede / servidor fora) — sem
// essa distinção, celular sem sinal acusaria "senha incorreta" e ela ficaria caçando
// uma senha que está certa.
// Também é o que renova o cookie de sessão: por isso os cadeados das abas chamam isto
// em vez de conferir hash local — acertar a senha da aba revalida a sessão que fazia as
// chamadas de API morrerem em 401.
async function conferirSenha(senha) {
  let r;
  try {
    r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha })
    });
  } catch (e) { return false; }
  if (r.status >= 500) return false; // ex.: secret de login faltando no Cloudflare
  if (!r.ok) return null;
  return (await r.json().catch(() => ({}))).perfil || null;
}

function aplicarPerfil(perfil) {
  if (perfil === 'dona') ABAS_DA_DONA.forEach(k => sessionStorage.setItem(k, '1'));
  const gate = document.getElementById('app-gate');
  if (gate) gate.style.display = 'none';
}

async function appEntrar() {
  const campo = document.getElementById('app-gate-senha');
  const erro  = document.getElementById('app-gate-erro');
  erro.textContent = 'Entrando…';
  const perfil = await conferirSenha(campo.value);
  if (perfil === false) { erro.textContent = 'Servidor não respondeu — tente de novo'; return; }
  if (!perfil) { erro.textContent = 'Senha incorreta'; campo.select(); return; }
  try { localStorage.setItem(PERFIL_KEY, perfil); } catch (e) {}
  campo.value = ''; erro.textContent = '';
  aplicarPerfil(perfil);
  iniciarApp();
}

async function appSair() {
  if (!confirm('Sair e pedir a senha de novo?')) return;
  // Derruba o cookie no servidor: só limpar o localStorage deixaria a sessão
  // valendo por 12h para quem pegasse o aparelho.
  try { await fetch('/api/logout', { method: 'POST' }); } catch (e) {}
  try { localStorage.removeItem(PERFIL_KEY); } catch (e) {}
  ABAS_DA_DONA.forEach(k => sessionStorage.removeItem(k));
  sessionStorage.removeItem('mdl-ok');
  location.reload();
}

// Declarado aqui em cima, e não junto de checarVersaoNova lá embaixo, porque a baixa de
// estoque consulta esta trava e roda antes daquele trecho do arquivo.
let _versaoAvisada = false;

function ehChaveHistorico(key) {
  return String(key || '').startsWith(HIST_PREFIXO);
}

// Nunca deixa o histórico atrapalhar o salvamento de verdade: roda solto e engole erro.
async function registrarVersao(key, dados) {
  if (ehChaveHistorico(key)) return;
  try {
    const hk = HIST_PREFIXO + key;
    const atual = await carregarNuvem(hk);
    // Leitura falhou (undefined): NÃO grava. Gravar aqui trocaria a lista inteira por
    // uma versão só — foi o que apagou 9 versões do Macacão Amplo em 11/08/2026.
    if (atual === undefined) return;
    const v = (atual && Array.isArray(atual.v)) ? atual.v : [];
    const novo = JSON.stringify(dados);
    if (v.length && JSON.stringify(v[0].d) === novo) return; // nada mudou
    v.unshift({ t: new Date().toISOString(), d: JSON.parse(novo) });
    await salvarNuvemREST(hk, { v: v.slice(0, HIST_MAX) });
  } catch (_) {}
}

async function salvarNuvem(key, dados) {
  await salvarNuvemREST(key, dados);
  registrarVersao(key, dados); // sem await: histórico nunca segura a tela
}

// Resumo do que mudou de uma versão para a outra, em português — sem isso a lista de
// versões vira um monte de horário igual e não dá para escolher para onde voltar.
function resumirDiferenca(velho, novo, key) {
  // A mais antiga da lista não tem com o que comparar: descrever "tudo que existe" ali
  // seria um despejo inútil de dezenas de linhas.
  if (!velho) return 'primeira versão guardada — ponto de partida';
  const def = MODELOS[key];
  const SZ = (def && def.tamanhos) || ['PP','P','M','G','GG'];
  const rot = i => (def && def.tamanhoUnico) ? 'Único' : (SZ[i] || '?');
  const partes = [];
  for (const campo of ['est', 'prod', 'prod2']) {
    const a = (velho && velho[campo]) || {}, b = (novo && novo[campo]) || {};
    const nome = { est: 'estoque', prod: 'leva 1', prod2: 'leva 2' }[campo];
    for (const cor of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const va = a[cor] || [], vb = b[cor] || [];
      const n = Math.max(va.length, vb.length, SZ.length);
      for (let i = 0; i < n; i++) {
        const d = (vb[i] || 0) - (va[i] || 0);
        if (d) partes.push(`${nome} ${cor} ${rot(i)} ${d > 0 ? '+' : ''}${d}`);
      }
    }
  }
  for (const campo of ['nome', 'tecido', 'consumo', 'preco', 'status', 'status2', 'prazo', 'obs', 'componentes']) {
    const a = velho ? velho[campo] : undefined, b = novo ? novo[campo] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) partes.push(`${campo}: ${JSON.stringify(a) ?? '—'} → ${JSON.stringify(b) ?? '—'}`);
  }
  const ca = JSON.stringify((velho && velho.cores) || []), cb = JSON.stringify((novo && novo.cores) || []);
  if (ca !== cb) partes.push('lista de cores mudou');
  if (!partes.length) return 'outros campos';
  return partes.slice(0, 6).join(' · ') + (partes.length > 6 ? ` · +${partes.length - 6}` : '');
}

// Abre o histórico de QUALQUER chave do sistema (modelo, financeiro, fluxo, precificação…)
async function abrirHistorico(key, titulo) {
  const modal = document.getElementById('modal-historico');
  const corpo = document.getElementById('hist-corpo');
  const tit   = document.getElementById('hist-titulo');
  if (!modal) return;
  window._histKey = key;
  tit.textContent = 'Histórico — ' + (titulo || key);
  corpo.innerHTML = '<div style="padding:14px;color:var(--text-ter);font-size:12px">carregando…</div>';
  modal.style.display = 'flex';

  const h = await carregarNuvem(HIST_PREFIXO + key);
  if (h === undefined) {
    corpo.innerHTML = '<div style="padding:14px;color:#dc2626;font-size:12px">'
      + 'Não deu para falar com a nuvem agora. Tente de novo em instantes — o histórico está lá, só não foi possível ler.</div>';
    window._histVersoes = [];
    return;
  }
  const v = (h && Array.isArray(h.v)) ? h.v : [];
  window._histVersoes = v;

  if (!v.length) {
    corpo.innerHTML = '<div style="padding:14px;color:var(--text-ter);font-size:12px">'
      + 'Ainda não há versões guardadas para esta tela. A partir de agora, cada gravação vira uma versão aqui.</div>';
    return;
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const fmt = t => { const d = new Date(t); return d.toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit' })
    + ' às ' + d.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' }); };

  corpo.innerHTML = `
    <div style="font-size:11px;color:var(--text-sec);padding:0 2px 10px">
      Cada linha é como esta tela estava depois de uma gravação, da mais recente para a mais antiga.
      <b>Restaurar</b> devolve exatamente aquele estado — e a versão de agora continua guardada,
      então dá para voltar de novo.
    </div>
    <table style="width:100%">
      <thead><tr>
        <th style="text-align:left">Quando</th>
        <th style="text-align:left">O que mudou nessa gravação</th>
        <th style="text-align:center;width:90px"></th>
      </tr></thead>
      <tbody>
        ${v.map((ver, i) => {
          const anterior = v[i + 1] ? v[i + 1].d : null;
          return `<tr>
            <td style="white-space:nowrap;font-weight:600">${esc(fmt(ver.t))}${i === 0 ? ' <span style="font-size:9px;background:rgba(22,163,74,.15);color:#16a34a;border-radius:3px;padding:1px 5px;font-weight:700">ATUAL</span>' : ''}</td>
            <td style="font-size:11px;color:var(--text-sec);line-height:1.6">${esc(resumirDiferenca(anterior, ver.d, key))}</td>
            <td style="text-align:center">${i === 0 ? '' :
              `<button class="btn-primary" style="font-size:10px;padding:5px 10px" onclick="restaurarVersao(${i}, this)">restaurar</button>`}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function fecharHistorico() {
  const m = document.getElementById('modal-historico');
  if (m) m.style.display = 'none';
}

async function restaurarVersao(i, btn) {
  const key = window._histKey;
  const ver = (window._histVersoes || [])[i];
  if (!key || !ver) return;
  const quando = new Date(ver.t).toLocaleString('pt-BR');
  if (!confirm(`Restaurar como estava em ${quando}?\n\nO estado de agora continua guardado no histórico, então dá para voltar depois.`)) return;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  saveLocal('vc:' + key, ver.d);
  await salvarNuvem(key, ver.d); // entra no histórico como versão nova: nada se perde
  fecharHistorico();

  if (MODELOS[key]) { modeloAtual = key; renderModelo(key); }
  else location.reload(); // telas fora do fluxo de modelo (financeiro, fluxo, precificação…)
}

// Devolve os dados da nuvem, ou `undefined` se NÃO deu para falar com a nuvem.
// A diferença importa: quem grava por cima precisa saber que leu de verdade. Sem isso,
// uma leitura que falhou vira "não existe" e o gravador escreve em cima do que está lá.
async function carregarNuvem(key) {
  // Usa REST direto — não depende do CDN do Supabase
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/vc_modelos?id=eq.${encodeURIComponent(key)}&select=dados`,
      // no-store: sem isso o navegador pode servir uma resposta de minutos atrás. Era o
      // que truncava o histórico de versões (a lista velha voltava e as novas sumiam).
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, cache: 'no-store' }
    );
    if (!res.ok) return undefined;
    const rows = await res.json();
    return rows[0]?.dados || null;
  } catch(e) { return undefined; }
}

// Carrega TODOS os modelos da nuvem — só atualiza se local estiver vazio ou nuvem for ESTRITAMENTE mais recente
async function carregarTodosNuvem() {
  try {
    // not.like hist:* — o histórico mora na mesma tabela e é pesado; só é buscado
    // quando a dona abre a tela de versões, nunca no carregamento da página.
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/vc_modelos?select=id,dados&id=not.like.${encodeURIComponent(HIST_PREFIXO + '*')}`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, cache: 'no-store' }
    );
    if (!res.ok) return;
    const rows = await res.json();
    rows.forEach(row => {
      if (!row.id || !row.dados) return;
      if (ehChaveHistorico(row.id)) return;
      // Nunca sobrescreve se o usuário tem edições pendentes no modelo aberto
      if (row.id === modeloAtual && (estEditado || prodEditado || cfgEditado)) return;
      // Na carga da página, a NUVEM é a fonte da verdade (evita problema de relógio
      // dessincronizado entre dispositivos — celular vs computador). Sempre puxa a
      // versão da nuvem, exceto o modelo aberto com edição pendente (guard acima).
      saveLocal('vc:' + row.id, row.dados);
    });
  } catch(e) {}
}

async function salvarNuvemREST(key, dados) {
  // Upsert com retry (3 tentativas) e alerta visual em caso de falha
  const MAX_TRIES = 3;
  for (let i = 0; i < MAX_TRIES; i++) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/vc_modelos`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({ id: key, dados })
      });
      if (res.ok || res.status === 201 || res.status === 200) {
        showCloudOk();
        return; // sucesso
      }
    } catch(e) {}
    if (i < MAX_TRIES - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  // Todas as tentativas falharam — alerta visual
  showCloudError();
}

function showCloudOk() {
  const ind = document.getElementById('save-ind');
  if (!ind) return;
  ind.innerHTML = '<i class="ti ti-cloud-check"></i> Salvo';
  ind.style.color = '';
  ind.classList.add('show');
  setTimeout(() => ind.classList.remove('show'), 2000);
}

function showCloudError() {
  const ind = document.getElementById('save-ind');
  if (!ind) return;
  ind.innerHTML = '<i class="ti ti-cloud-off"></i> Erro ao salvar na nuvem — dados locais preservados';
  ind.style.color = '#dc2626';
  ind.classList.add('show');
  // Mantém visível até o usuário salvar com sucesso
}

function iniciarRealtime() {
  if (!supabaseCli) return;
  supabaseCli
    .channel('vc_modelos_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'vc_modelos' }, payload => {
      const row = payload.new;
      if (!row || !row.id || !row.dados) return;
      // Nunca sobrescreve edições pendentes nem salvamento recente do modelo aberto
      if (modeloAbertoProtegido(row.id)) return;
      // Atualiza o localStorage do modelo alterado (qualquer modelo)
      saveLocal('vc:' + row.id, row.dados);
      // Re-renderiza a tela atual para refletir a mudança vinda de outro dispositivo
      if (modeloAtual === '__dashboard__') renderDashboard();
      else if (!estEditado && !prodEditado && !prod2Editado && !cfgEditado) renderModelo(modeloAtual);
    })
    .subscribe();
}

// Rede de segurança: re-puxa a nuvem periodicamente e re-renderiza se algo mudou.
// Garante sincronização entre dispositivos mesmo se o realtime não estiver ativo.
async function sincronizarNuvem() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/vc_modelos?select=id,dados`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, cache: 'no-store' }
    );
    if (!res.ok) return;
    const rows = await res.json();
    let mudou = false;
    rows.forEach(row => {
      if (!row.id || !row.dados) return;
      // Protege edições pendentes e salvamento recente do modelo aberto (carência)
      if (modeloAbertoProtegido(row.id)) return;
      const atual = JSON.stringify(loadLocal('vc:' + row.id));
      const novo  = JSON.stringify(row.dados);
      if (atual !== novo) { saveLocal('vc:' + row.id, row.dados); mudou = true; }
    });
    if (mudou) {
      if (modeloAtual === '__dashboard__') renderDashboard();
      else if (!estEditado && !prodEditado && !prod2Editado && !cfgEditado) renderModelo(modeloAtual);
    }
  } catch (e) {}
}
// ─────────────────────────────────────────────────────────────────────────────

const fmt = v => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function saveLocal(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {}
}

function loadLocal(key) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch(e) { return null; }
}

function showSaved() {
  const i = document.getElementById('save-ind');
  // Não sobrescreve mensagem de erro de nuvem
  if (i && i.style.color === 'rgb(220, 38, 38)') return;
  if (i) {
    i.innerHTML = '<i class="ti ti-device-floppy"></i> Salvando…';
    i.style.color = '';
    i.classList.add('show');
  }
}

function autoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(salvarModelo, 800);
}

let estEditado  = false;
let prodEditado = false;
let prod2Editado = false; // 2ª leva de produção
let cfgEditado  = false;
// Marca o último salvamento LOCAL (relógio local). Durante a carência logo após,
// a sincronização não sobrescreve o modelo aberto (evita corrida com o envio à nuvem).
let _ultimoSaveTs = 0;
const SYNC_CARENCIA_MS = 6000;
function modeloAbertoProtegido(id) {
  return id === modeloAtual &&
    (estEditado || prodEditado || prod2Editado || cfgEditado || (Date.now() - _ultimoSaveTs < SYNC_CARENCIA_MS));
}

// Salva estado atual no localStorage IMEDIATAMENTE (sem esperar o debounce)
// Garante que refresh de página não perde edições em andamento
function salvarLocalImediato() {
  if (modeloAtual === '__dashboard__') return;
  const tu = MODELOS[modeloAtual] && MODELOS[modeloAtual].tamanhoUnico;
  const est = {}, prod = {};
  document.querySelectorAll('#est-tbody tr').forEach(r => {
    if (tu) { est[r.dataset.cor] = [parseInt(r.querySelector('input')?.value) || 0, 0, 0, 0, 0]; }
    else     { est[r.dataset.cor] = Array.from(r.querySelectorAll('input')).map(i => parseInt(i.value) || 0); }
  });
  document.querySelectorAll('#prod-tbody tr').forEach(r => {
    if (tu) { prod[r.dataset.cor] = [parseInt(r.querySelector('input')?.value) || 0, 0, 0, 0, 0]; }
    else     { prod[r.dataset.cor] = Array.from(r.querySelectorAll('input')).map(i => parseInt(i.value) || 0); }
  });
  // 2ª leva: só coleta se a tabela está renderizada (leva ativa); senão preserva o que existe
  const prod2 = {};
  document.querySelectorAll('#prod2-tbody tr').forEach(r => {
    if (tu) { prod2[r.dataset.cor] = [parseInt(r.querySelector('input')?.value) || 0, 0, 0, 0, 0]; }
    else     { prod2[r.dataset.cor] = Array.from(r.querySelectorAll('input')).map(i => parseInt(i.value) || 0); }
  });
  const existente = loadLocal('vc:' + modeloAtual) || {};
  const agora = new Date().toISOString();
  saveLocal('vc:' + modeloAtual, {
    ...existente,
    est, prod,
    ...(Object.keys(prod2).length ? { prod2 } : {}),
    est_at:     estEditado   ? agora : (existente.est_at   || null),
    prod_at:    prodEditado  ? agora : (existente.prod_at  || null),
    prod2_at:   prod2Editado ? agora : (existente.prod2_at || null),
    updated_at: agora,
  });
  _ultimoSaveTs = Date.now();
}

function mostrarBtnSalvar() {
  const btn = document.getElementById('btn-salvar');
  if (btn) btn.style.display = '';
}
function esconderBtnSalvar() {
  const btn = document.getElementById('btn-salvar');
  if (btn) btn.style.display = 'none';
}
function salvarManual() {
  clearTimeout(saveTimer);
  salvarModelo();
  esconderBtnSalvar();
}

function marcarEstEditado()  { estEditado  = true; recalc(); salvarLocalImediato(); mostrarBtnSalvar(); }
function marcarProdEditado() { prodEditado = true; salvarLocalImediato(); renderResumoProducao(); mostrarBtnSalvar(); }
function marcarProd2Editado(){ prod2Editado = true; salvarLocalImediato(); renderResumoProducao(); mostrarBtnSalvar(); }
function marcarCfgEditado()  { cfgEditado  = true; mostrarBtnSalvar(); autoSave(); }

function salvarModelo() {
  const est = {}, prod = {};
  const tu = MODELOS[modeloAtual] && MODELOS[modeloAtual].tamanhoUnico;
  document.querySelectorAll('#est-tbody tr').forEach(r => {
    if (tu) {
      const v = parseInt(r.querySelector('input').value) || 0;
      est[r.dataset.cor] = [v, 0, 0, 0, 0];
    } else {
      est[r.dataset.cor] = Array.from(r.querySelectorAll('input')).map(i => parseInt(i.value) || 0);
    }
  });
  document.querySelectorAll('#prod-tbody tr').forEach(r => {
    if (tu) {
      const v = parseInt(r.querySelector('input').value) || 0;
      prod[r.dataset.cor] = [v, 0, 0, 0, 0];
    } else {
      prod[r.dataset.cor] = Array.from(r.querySelectorAll('input')).map(i => parseInt(i.value) || 0);
    }
  });
  // 2ª leva: coleta do DOM se renderizada; senão preserva o que já estava salvo
  const prod2 = {};
  document.querySelectorAll('#prod2-tbody tr').forEach(r => {
    if (tu) {
      const v = parseInt(r.querySelector('input').value) || 0;
      prod2[r.dataset.cor] = [v, 0, 0, 0, 0];
    } else {
      prod2[r.dataset.cor] = Array.from(r.querySelectorAll('input')).map(i => parseInt(i.value) || 0);
    }
  });
  const existente  = loadLocal('vc:' + modeloAtual) || {};
  const statusVal  = document.getElementById('prod-status').value;
  const statusVal2 = document.getElementById('prod2-status')?.value || '';
  const prod2Final = Object.keys(prod2).length ? prod2 : (existente.prod2 || null);
  const data = {
    est, prod,
    // ── 2ª leva (salva sempre que existir, para não perder no rebuild do JSON) ──
    ...(existente.leva2 || prod2Final ? {
      leva2:      !!existente.leva2,
      ...(prod2Final ? { prod2: prod2Final } : {}),
      status2:    statusVal2,
      prazo2:     document.getElementById('prod2-prazo')?.value || '',
      prod2_at:   prod2Editado ? new Date().toISOString() : (existente.prod2_at || null),
      status2_at: ['Comprando tecido', 'Em corte'].includes(statusVal2)
        ? (existente.status2 === statusVal2 && existente.status2_at ? existente.status2_at : new Date().toISOString())
        : null,
    } : {}),
    preco:       parseFloat(document.getElementById('preco-m').value) || 0,
    status:      statusVal,
    prazo:       document.getElementById('prod-prazo').value,
    nome:        document.getElementById('cfg-nome').value,
    tecido:      document.getElementById('cfg-tecido').value,
    consumo:     parseFloat(document.getElementById('cfg-consumo').value) || 0,
    componentes: document.getElementById('cfg-componentes').value,
    obs:         document.getElementById('cfg-obs').value,
    cores:       getCoresTags(),
    est_at:      estEditado  ? new Date().toISOString() : (existente.est_at  || null),
    prod_at:     prodEditado ? new Date().toISOString() : (existente.prod_at || null),
    updated_at:  new Date().toISOString(),
    // Registra timestamp ao entrar em status com prazo monitorado
    status_at: ['Comprando tecido', 'Em corte'].includes(statusVal)
      ? (existente.status === statusVal && existente.status_at ? existente.status_at : new Date().toISOString())
      : null,
  };
  estEditado  = false;
  prodEditado = false;
  prod2Editado = false;
  cfgEditado  = false;
  esconderBtnSalvar();
  saveLocal('vc:' + modeloAtual, data);
  _ultimoSaveTs = Date.now();   // inicia carência: protege o modelo aberto até a nuvem confirmar
  salvarNuvem(modeloAtual, data);
  showSaved();
  buildSidebar(); // atualiza badge de status no menu lateral

  // Atualiza topbar imediatamente ao editar nas configurações
  if (data.nome)    document.getElementById('model-title').textContent = data.nome;
  if (data.tecido)  document.getElementById('model-sub').textContent =
    `TECIDO: ${data.tecido.toUpperCase()} • CONSUMO: ${data.consumo}M/PEÇA`;

  // Atualiza nome no menu lateral
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(el => {
    if (el.classList.contains('active')) el.textContent = data.nome || el.textContent;
  });
}

// Só as cores FIXAS são gravadas. Cor provisória (veio de um pedido, não cadastrada) fica
// de fora de propósito — ver renderCoresTags.
function getCoresTags() {
  return Array.from(document.querySelectorAll('#cores-tags .cor-tag[data-fixa="1"] span')).map(s => s.textContent);
}

function buildSidebar() {
  const nav = document.getElementById('sidebar-nav');
  nav.innerHTML = '';

  // Perfil do corte: o menu tem CORTE e mais nada. Sem INÍCIO, sem modelos — ele não
  // chega perto de pedido, cliente, estoque nem financeiro.
  if (ehPerfilCorte()) {
    const item = document.createElement('div');
    item.className = 'nav-item nav-dashboard active';
    item.innerHTML = '<i class="ti ti-scissors"></i> CORTE';
    item.onclick = () => abrirCorte(item);
    nav.appendChild(item);

    const sair = document.createElement('div');
    sair.className = 'nav-item nav-dashboard';
    sair.innerHTML = '<i class="ti ti-logout"></i> SAIR';
    sair.onclick = appSair;
    nav.appendChild(sair);
    return;
  }

  // Mesma ideia para a costureira: COSTURA, o FATURAMENTO dela e SAIR. Os valores em R$ que
  // ela vê são só os da própria costura (decisão da Bárbara, 15/08) — pedido, cliente e o
  // resto do financeiro continuam fora do alcance dela.
  if (ehPerfilCostura()) {
    const item = document.createElement('div');
    item.className = 'nav-item nav-dashboard' + (modeloAtual === '__faturamento__' ? '' : ' active');
    item.innerHTML = '<i class="ti ti-needle-thread"></i> COSTURA';
    item.onclick = () => abrirCostura(item);
    nav.appendChild(item);

    const fat = document.createElement('div');
    fat.className = 'nav-item nav-dashboard' + (modeloAtual === '__faturamento__' ? ' active' : '');
    fat.innerHTML = '<i class="ti ti-cash"></i> FATURAMENTO';
    fat.onclick = () => abrirFaturamento(fat);
    nav.appendChild(fat);

    const sair = document.createElement('div');
    sair.className = 'nav-item nav-dashboard';
    sair.innerHTML = '<i class="ti ti-logout"></i> SAIR';
    sair.onclick = appSair;
    nav.appendChild(sair);
    return;
  }

  // Botão Dashboard no topo
  const dashItem = document.createElement('div');
  dashItem.className = 'nav-item nav-dashboard' + (modeloAtual === '__dashboard__' ? ' active' : '');
  dashItem.innerHTML = '<i class="ti ti-layout-dashboard"></i> INÍCIO';
  dashItem.onclick = () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    dashItem.classList.add('active');
    // Salva edições pendentes antes de ir ao dashboard
    if (modeloAtual !== '__dashboard__' && (estEditado || prodEditado || prod2Editado || cfgEditado)) {
      clearTimeout(saveTimer);
      salvarModelo();
    }
    estEditado = false; prodEditado = false; prod2Editado = false;
    esconderBtnSalvar();
    modeloAtual = '__dashboard__';
    location.hash = ''; // limpa hash ao voltar ao início
    document.getElementById('model-sub').textContent = '';
    document.getElementById('tabs-modelo').style.display = 'none';
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('panel-dashboard').classList.add('active');
    document.body.classList.remove('precos-mode');
    renderDashboard();
    closeSidebar();
  };
  nav.appendChild(dashItem);

  // ── CONFECÇÃO logo abaixo de INÍCIO: abre o CATÁLOGO de modelos (aba própria).
  // A lista de modelos saiu da lateral (pedido do Álvaro 03/08) — o menu fica só
  // com as áreas; os modelos vivem dentro da aba Confecção.
  const confItem = document.createElement('div');
  confItem.id = 'nav-confeccao';
  confItem.className = 'nav-item nav-dashboard' + ((modeloAtual === '__confeccao__' || MODELOS[modeloAtual]) ? ' active' : '');
  confItem.innerHTML = `<i class="ti ${confLiberada() ? 'ti-needle-thread' : 'ti-lock'}"></i> CONFECÇÃO`;
  confItem.onclick = () => abrirConfeccao(confItem);
  nav.appendChild(confItem);

  // Botão Financeiro (protegido por senha)
  const finItem = document.createElement('div');
  finItem.className = 'nav-item nav-dashboard' + (modeloAtual === '__financeiro__' ? ' active' : '');
  finItem.innerHTML = '<i class="ti ti-report-money"></i> FINANCEIRO';
  finItem.onclick = () => abrirFinanceiro(finItem);
  nav.appendChild(finItem);

  // Botão Fluxo de Caixa (mesma senha do Financeiro)
  const flxItem = document.createElement('div');
  flxItem.className = 'nav-item nav-dashboard' + (modeloAtual === '__fluxo__' ? ' active' : '');
  flxItem.innerHTML = '<i class="ti ti-cash-banknote"></i> FLUXO DE CAIXA';
  flxItem.onclick = () => abrirFluxo(flxItem);
  nav.appendChild(flxItem);

  // Botão Precificação (mesma senha do Financeiro)
  const prcItem = document.createElement('div');
  prcItem.className = 'nav-item nav-dashboard' + (modeloAtual === '__precos__' ? ' active' : '');
  prcItem.innerHTML = '<i class="ti ti-tag"></i> PRECIFICAÇÃO';
  prcItem.onclick = () => abrirPrecos(prcItem);
  nav.appendChild(prcItem);

  // Botão Tráfego & Conversão (mesma senha do Financeiro)
  const trfItem = document.createElement('div');
  trfItem.className = 'nav-item nav-dashboard' + (modeloAtual === '__trafego__' ? ' active' : '');
  trfItem.innerHTML = '<i class="ti ti-chart-line"></i> TRÁFEGO';
  trfItem.onclick = () => abrirTrafego(trfItem);
  nav.appendChild(trfItem);

  // Botão Atendimento — SAC/Troca/Devolução/Vendas (mesma senha do Financeiro)
  const atdItem = document.createElement('div');
  atdItem.className = 'nav-item nav-dashboard' + (modeloAtual === '__atendimento__' ? ' active' : '');
  atdItem.innerHTML = '<i class="ti ti-headset"></i> ATENDIMENTO';
  atdItem.onclick = () => abrirAtendimento(atdItem);
  nav.appendChild(atdItem);

  // Botão Modelagem (arquivos Audaces, croquis, consumo e alterações por modelo)
  const mdlItem = document.createElement('div');
  mdlItem.className = 'nav-item nav-dashboard' + (modeloAtual === '__modelagem__' ? ' active' : '');
  mdlItem.innerHTML = '<i class="ti ti-shirt"></i> MODELAGEM';
  mdlItem.onclick = () => abrirModelagem(mdlItem);
  nav.appendChild(mdlItem);

  // Botão Corte — a mesma tela que o cortador vê, para conferir o que está na mão dele
  const crtItem = document.createElement('div');
  crtItem.className = 'nav-item nav-dashboard' + (modeloAtual === '__corte__' ? ' active' : '');
  crtItem.innerHTML = '<i class="ti ti-scissors"></i> CORTE';
  crtItem.onclick = () => abrirCorte(crtItem);
  nav.appendChild(crtItem);

  // Botão Costura — a mesma tela que a costureira vê
  const cstItem = document.createElement('div');
  cstItem.className = 'nav-item nav-dashboard' + (modeloAtual === '__costura__' ? ' active' : '');
  cstItem.innerHTML = '<i class="ti ti-needle-thread"></i> COSTURA';
  cstItem.onclick = () => abrirCostura(cstItem);
  nav.appendChild(cstItem);

  // Botão Faturamento da costura — quanto vale o que está na máquina e o que falta pagar
  const fatItem = document.createElement('div');
  fatItem.className = 'nav-item nav-dashboard' + (modeloAtual === '__faturamento__' ? ' active' : '');
  fatItem.innerHTML = '<i class="ti ti-cash"></i> FATURAMENTO';
  fatItem.onclick = () => abrirFaturamento(fatItem);
  nav.appendChild(fatItem);

  // Sair — limpa o perfil deste aparelho e volta a pedir senha
  const sairItem = document.createElement('div');
  sairItem.className = 'nav-item nav-dashboard';
  sairItem.innerHTML = '<i class="ti ti-logout"></i> SAIR';
  sairItem.onclick = appSair;
  nav.appendChild(sairItem);

}

// Rótulo de um modelo (nome + selos de etapa das duas levas) — usado pelos cards
// do catálogo da aba Confecção (antes era o item da lateral).
function modeloLabelHtml(key) {
      const def = MODELOS[key];
      if (!def) return '';
      const saved  = loadLocal('vc:' + key) || {};
      const status = saved.status || '';
      const item   = { innerHTML: '' }; // acumula o HTML no mesmo formato do antigo item da lateral
      const nome      = saved.nome || def.nome;
      const statusAt  = saved.status_at ? new Date(saved.status_at).getTime() : null;
      const horas     = statusAt ? Math.floor((Date.now() - statusAt) / 3600000) : 0;
      if (status === 'Comprando tecido') {
        const vencido = statusAt && horas >= 24;
        if (vencido) {
          item.innerHTML = `<span style="color:#f59e0b;font-weight:600">${nome}</span>&nbsp;<span style="font-size:9px;background:rgba(245,158,11,0.18);color:#f59e0b;border-radius:3px;padding:1px 5px;letter-spacing:0.04em;vertical-align:middle">⚠ ${horas}h</span>`;
        } else {
          item.innerHTML = `<span style="color:var(--gold);font-weight:600">${nome}</span>&nbsp;<span style="font-size:9px;background:rgba(196,168,130,0.18);color:var(--gold);border-radius:3px;padding:1px 5px;letter-spacing:0.04em;vertical-align:middle">TECIDO</span>`;
        }
      } else if (status === 'Em corte') {
        const vencido = statusAt && horas >= 48;
        const urgente = statusAt && horas >= 60;
        const cor = urgente ? '#dc2626' : '#7C3AED';
        const bg  = urgente ? 'rgba(220,38,38,0.12)' : 'rgba(124,58,237,0.12)';
        const badge = vencido
          ? `<span style="font-size:9px;background:${bg};color:${cor};border-radius:3px;padding:1px 5px;letter-spacing:0.04em;vertical-align:middle">CORTE ✂</span>&nbsp;<span style="font-size:9px;background:rgba(220,38,38,0.12);color:#dc2626;border-radius:3px;padding:1px 5px;letter-spacing:0.04em;vertical-align:middle">⚠ ${horas}h</span>`
          : `<span style="font-size:9px;background:${bg};color:${cor};border-radius:3px;padding:1px 5px;letter-spacing:0.04em;vertical-align:middle">CORTE ✂</span>`;
        item.innerHTML = `<span style="color:${cor};font-weight:600">${nome}</span>&nbsp;${badge}`;
      } else if (status === 'Em costura') {
        const vencido = statusAt && horas >= 48;
        const urgente = statusAt && horas >= 60;
        const cor = urgente ? '#dc2626' : '#0891b2';
        const bg  = urgente ? 'rgba(220,38,38,0.12)' : 'rgba(8,145,178,0.12)';
        const badge = vencido
          ? `<span style="font-size:9px;background:${bg};color:${cor};border-radius:3px;padding:1px 5px;letter-spacing:0.04em;vertical-align:middle">COSTURA 🧵</span>&nbsp;<span style="font-size:9px;background:rgba(220,38,38,0.12);color:#dc2626;border-radius:3px;padding:1px 5px;letter-spacing:0.04em;vertical-align:middle">⚠ ${horas}h</span>`
          : `<span style="font-size:9px;background:${bg};color:${cor};border-radius:3px;padding:1px 5px;letter-spacing:0.04em;vertical-align:middle">COSTURA 🧵</span>`;
        item.innerHTML = `<span style="color:${cor};font-weight:600">${nome}</span>&nbsp;${badge}`;
      } else {
        item.innerHTML = nome;
      }
      // Badge da 2ª leva (status próprio, independente da leva principal)
      const status2 = saved.status2 || '';
      const BADGE2 = {
        'Comprando tecido': ['var(--gold)', 'rgba(196,168,130,0.18)', '2ª TECIDO'],
        'Em corte':         ['#7C3AED', 'rgba(124,58,237,0.12)', '2ª CORTE ✂'],
        'Em costura':       ['#0891b2', 'rgba(8,145,178,0.12)', '2ª COSTURA 🧵'],
      };
      if (BADGE2[status2]) {
        const [c2, bg2, lb2] = BADGE2[status2];
        item.innerHTML += `&nbsp;<span style="font-size:9px;background:${bg2};color:${c2};border-radius:3px;padding:1px 5px;letter-spacing:0.04em;vertical-align:middle">${lb2}</span>`;
      }
      return item.innerHTML;
}

// Abre um modelo pelo NOME exibido — substitui o antigo "clique no item da lateral"
// usado pelas tabelas do dashboard (a lateral não lista mais os modelos).
function abrirModeloPorNome(nome) {
  const alvo = String(nome || '').trim();
  if (!alvo) return;
  for (const [key, def] of Object.entries(MODELOS)) {
    const n = String(((loadLocal('vc:' + key) || {}).nome || def.nome)).trim();
    if (n === alvo || alvo.startsWith(n)) { selectModel(null, key); return; }
  }
}

// ─── ABA FINANCEIRA ──────────────────────────────────────────────────────────
// A senha da dona não mora mais aqui: os cadeados destas abas chamam conferirSenha(),
// que pergunta ao /api/login. Só a da Modelagem continua sendo conferida no navegador
// (é uma senha à parte, sem secret correspondente no Cloudflare).
const MDL_HASH = 'a01b9981184c6b9627fb38968441bc17686288e37a8e81e8dec2b6c926b6dca7'; // senha da aba Modelagem (SHA-256)
const CUSTO_DEFS = [
  ['trafego', 'Tráfego (anúncios)', '#D85A30'],
  ['tecido', 'Tecido', '#1D9E75'],
  ['faccao', 'Corte & Costura (facção)', '#65a30d'],
  ['logistica', 'Logística / frete', '#0891b2'],
  ['salarios', 'Salários', '#7C3AED'],
  ['fixos', 'Fixos / serviços', '#C4A882'],
  ['plataformas', 'Plataformas a revisar', '#888780'],
  ['naoessencial', 'Não-essencial', '#b45309'],
  ['outros', 'Outros', '#6b7280'],
  ['retirada', 'Retirada de sócio', '#9a3412'],
];
const finBRL = v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Subcategorias por mês (extraídas dos extratos Stone e Mercado Pago "(MP)"). Cada item: [descrição, valor].
const FIN_SUBS_DEFAULT = {
  '2026-05': {
    trafego: [['Meta Ads (Facebook)', 35273.49]],
    tecido: [['Costa Rica Malhas (tecido)', 10711.30], ['Costa Rica Malhas (MP)', 4474.33]],
    faccao: [['Maria Elizete (facção)', 12437.30], ['Anselmo Costa (facção)', 1771.10], ['Sanmaq (máquinas)', 794.95], ['Sancris Linhas e Fios', 372.06]],
    logistica: [['L4B Logística', 11268.86], ['São João Transportes', 546.45]],
    salarios: [['Marcelly', 2520.00], ['Emanuela', 2025.00]],
    fixos: [['Lithium Software', 1943.67], ['Shopify', 1384.47], ['Amil (plano de saúde)', 999.61], ['Trindade Gráfica', 832.50], ['Confseg (contabilidade)', 760.00], ['Letícia (advocacia)', 760.00], ['Angelo de Lemos', 500.00], ['LWSA (hospedagem)', 220.00], ['NIC.br (domínio)', 76.00], ['DARE SC (imposto)', 72.24], ['Microsoft', 51.00], ['RKZ Combustíveis', 47.47], ['Multidisplay', 40.00], ['Safe2Pay', 35.90], ['Ebanx', 35.00]],
    plataformas: [['PagueVeloz (MP)', 3663.24], ['Nu Pagamentos', 1792.63], ['Mercado Pago', 1069.15], ['Moda Mundial Pagamentos (MP)', 1040.36], ['PIX Marketplace', 963.77], ['Lithium Software (MP)', 383.11], ['Pagar.me', 246.98], ['Safe2Pay (MP)', 227.83], ['Nubank (MP)', 190.44], ['Shopee Pay (MP)', 136.73]],
    naoessencial: [['Alimentação/restaurantes (MP)', 1573.76], ['Compras online (MP)', 1253.86], ['Mercado/farmácia (MP)', 1186.02], ['SDB Alimentos', 643.81], ['Airbnb (MP)', 615.17], ['Decoração Bali Guarda (MP)', 468.00], ['Hiper Select (mercado)', 178.48], ['iFood', 134.62], ['Uber', 109.30], ['ELS Alimentos', 61.50], ['Travel Café', 52.00], ['Combustível/estacionamento (MP)', 49.96], ['Armazém Açores', 44.90], ['Inbox Alimentos', 37.97], ['Bionnutri', 20.00]],
    outros: [['Pix diversos (MP)', 2202.51], ['Alvaro Alves (MP)', 2000.00], ['Fernanda Hanemann (MP)', 1000.00], ['Eunice', 800.00], ['Aline Fernandes (MP)', 539.00], ['Eventos (MP)', 400.00], ['E A Manoel (MP)', 345.20], ['Paola Bandeira', 300.00], ['Leandro Macario (MP)', 256.30], ['Paola Bandeira (MP)', 200.00], ['Joana Bandeira (MP)', 200.00], ['Marcio Eduardo (MP)', 200.00], ['Aline Chaves (MP)', 136.10], ['Adriano Borges (MP)', 126.00], ['Amanda Madeira', 82.00], ['Andrea Alcirene', 72.00], ['Laurinara', 70.00], ['Ivan (MP)', 50.00], ['Luis Gustavo', 30.00], ['Schmitt dos Santos (MP)', 30.00], ['Ubaldino (MP)', 16.00], ['Transferência interna', 6.45]],
    retirada: [['Barbara', 2781.00]],
  },
  '2026-06': {
    trafego: [['Meta Ads (Facebook)', 39270.92]],
    tecido: [['Costa Rica Malhas (tecido) — estimado ~50% proporção maio, ajustar c/ extrato', 22771.27], ['Alvaro Alves (tecidos, parcelado no cartão)', 3982.46]],
    faccao: [['Maria Elizete+Anselmo+Sanmaq (facção) — estimado ~50% proporção maio, ajustar c/ extrato', 22497.93], ['Aviamentos/Etiquetas (Makro+YBR+RGB)', 3551.88], ['PIX Marketplace (embalagem/aviamentos)', 1298.71], ['Natalia Urbanetto (modelista)', 100.00]],
    logistica: [['L4B+São João Transportes', 10695.23], ['Correios - Sedex/PAC/logística reversa (Lithium Software)', 5353.29], ['Denise de Araujo Moreira', 150.00]],
    salarios: [['Marcelly (inclui atraso de maio, pago 01/06)', 5282.00], ['Emanuela', 2065.00]],
    fixos: [['Confseg (contabilidade)', 286.05], ['Obvio Brasil (Reclame Aqui)', 1573.50], ['LWSA (hospedagem)', 240.00], ['Adobe', 95.00], ['Wati.io', 55.36], ['Microsoft (PPRO)', 51.00], ['Multidisplay', 40.00], ['Eunice - limpeza', 900.00], ['Leticia (advocacia)', 450.00], ['Obra da empresa (Renato Chaves+Duarte Sul+Elias Bassani)', 788.00], ['Claude/Anthropic', 1394.65], ['Manus AI', 109.87], ['Google Brasil', 9.99]],
    plataformas: [['Mercado Pago Instituição', 578.93], ['Ebanx', 35.00], ['Shopify', 1817.26], ['SHPP Brasil', 262.20]],
    naoessencial: [['Uber', 148.50], ['INBOX Comércio Alimentos', 24.99], ['Mercado Livre', 858.92]],
    outros: [['DC Comercio Besen Ltda (não identificado)', 136.04], ['EBANX Ltda MP (não identificado)', 23.90], ['Andrea Alcirene Pires (não identificado)', 103.75], ['Christofer Venancio de Camargo (não identificado)', 25.00], ['Alexandre Francisco Bazzo (não identificado)', 100.00], ['Daniela Leivas Di Bari (não identificado)', 5.00], ['Transferências sem identificação (3x)', 295.56]],
    retirada: [['Barbara (Stone)', 3390.00], ['Barbara (MP)', 8443.72], ['Jose Claudio Barbosa - auto-escola', 250.00], ['JD Comercio Garden - floricultura', 646.95], ['RL Sorvetes', 98.80], ['SDB Comercio Alimentos - mercado', 874.95], ['Surf Bar - restaurante', 235.00], ['DP Gastronomia', 62.00], ['Savas Armazem', 32.50], ['Raia Drogasil', 84.46], ['iFood', 39.30], ['Celesc - energia', 1124.23]],
  },
};
const FIN_SUBS_VERSION = 4; // v3: fechamento completo de jun/2026 (Stone+MP linha a linha)
const finSubsSum = arr => (arr || []).reduce((s, i) => s + (parseFloat(i[1]) || 0), 0);

function finGetSubs(cfg, mes) {
  // Defaults novos (versão maior) têm precedência sobre subs salvos com versão antiga
  const salvo = cfg.subs && cfg.subs[mes];
  const ver = (cfg.subsV && cfg.subsV[mes]) || 0;
  const desatualizado = FIN_SUBS_DEFAULT[mes] && ver < FIN_SUBS_VERSION;
  const base = (salvo && !desatualizado) ? salvo : (FIN_SUBS_DEFAULT[mes] || salvo || {});
  const out = JSON.parse(JSON.stringify(base));
  if (out.producao) { out.faccao = (out.faccao || []).concat(out.producao); delete out.producao; }
  return out;
}

function finGetConfig() {
  return loadLocal('vc:financeiro') || { taxas: { credito: 4.8, pix: 0, dinheiro: 0 }, meses: {} };
}
function finDefaults(mes) {
  if (mes === '2026-05') return { trafego: 35273.49, tecido: 15185.63, faccao: 15375.41, logistica: 11815.31, salarios: 4545, fixos: 7757.86, plataformas: 9714.24, naoessencial: 6429.35, outros: 9061.56, retirada: 2781 };
  return { trafego: 0, tecido: 0, faccao: 0, logistica: 0, salarios: 0, fixos: 0, plataformas: 0, naoessencial: 0, outros: 0, retirada: 0 };
}

function abrirFinanceiro(item) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (item) item.classList.add('active');
  if (modeloAtual !== '__dashboard__' && modeloAtual !== '__financeiro__' && (estEditado || prodEditado || cfgEditado)) {
    clearTimeout(saveTimer); salvarModelo();
  }
  estEditado = false; prodEditado = false; cfgEditado = false; esconderBtnSalvar();
  modeloAtual = '__financeiro__';
  location.hash = 'financeiro';
  document.getElementById('model-title').innerHTML = '<span style="font-family:\'Bebas Neue\',\'Arial Narrow\',sans-serif;font-weight:400;font-size:26px;letter-spacing:0.1em">FINANCEIRO</span>';
  document.getElementById('model-sub').textContent = '';
  document.getElementById('topbar-actions').style.display = 'none';
  document.getElementById('tabs-modelo').style.display = 'none';
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-financeiro').classList.add('active');
  document.body.classList.remove('precos-mode');
  finPopularMeses();
  const ok = sessionStorage.getItem('fin-ok') === '1';
  document.getElementById('fin-gate').style.display = ok ? 'none' : '';
  document.getElementById('fin-content').style.display = ok ? '' : 'none';
  if (ok) renderFinanceiro(); else setTimeout(() => document.getElementById('fin-senha')?.focus(), 60);
  closeSidebar();
}

async function finUnlock() {
  const v = document.getElementById('fin-senha').value;
  if (await conferirSenha(v) === 'dona') {
    sessionStorage.setItem('fin-ok', '1');
    document.getElementById('fin-erro').textContent = '';
    document.getElementById('fin-senha').value = '';
    document.getElementById('fin-gate').style.display = 'none';
    document.getElementById('fin-content').style.display = '';
    renderFinanceiro();
  } else {
    document.getElementById('fin-erro').textContent = 'Senha incorreta';
  }
}
// ── Confecção (mesma senha do Financeiro) ────────────────────────────────────
// O catálogo de modelos abre estoque, produção e pedidos de cada peça, então passou a
// ter cadeado como as outras áreas. Entrando como dona ele já vem aberto (ABAS_DA_DONA);
// a tela abaixo só aparece se alguém trancar de propósito ou entrar por outro perfil.
function confLiberada() { return sessionStorage.getItem('conf-ok') === '1'; }

function abrirConfeccao(item) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  ((item) || document.getElementById('nav-confeccao'))?.classList.add('active');
  if (MODELOS[modeloAtual] && (estEditado || prodEditado || prod2Editado || cfgEditado)) {
    clearTimeout(saveTimer); salvarModelo();
  }
  estEditado = false; prodEditado = false; prod2Editado = false; cfgEditado = false; esconderBtnSalvar();
  modeloAtual = '__confeccao__';
  location.hash = 'confeccao';
  document.getElementById('model-title').innerHTML = '<span style="font-family:\'Bebas Neue\',\'Arial Narrow\',sans-serif;font-weight:400;font-size:26px;letter-spacing:0.1em">CONFECÇÃO</span>';
  document.getElementById('model-sub').textContent = '';
  document.getElementById('topbar-actions').style.display = 'none';
  document.getElementById('tabs-modelo').style.display = 'none';
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-confeccao').classList.add('active');
  document.body.classList.remove('precos-mode');
  const ok = confLiberada();
  document.getElementById('conf-gate').style.display = ok ? 'none' : '';
  document.getElementById('conf-content').style.display = ok ? '' : 'none';
  if (ok) renderConfeccao(); else setTimeout(() => document.getElementById('conf-senha')?.focus(), 60);
  closeSidebar();
}

async function confUnlock() {
  const v = document.getElementById('conf-senha').value;
  if (await conferirSenha(v) !== 'dona') {
    document.getElementById('conf-erro').textContent = 'Senha incorreta';
    return;
  }
  sessionStorage.setItem('conf-ok', '1');
  document.getElementById('conf-senha').value = '';
  document.getElementById('conf-erro').textContent = '';
  buildSidebar(); // troca o cadeado pela agulha no item CONFECÇÃO
  document.getElementById('nav-confeccao')?.classList.add('active');
  document.getElementById('conf-gate').style.display = 'none';
  document.getElementById('conf-content').style.display = '';
  renderConfeccao();
}

// Catálogo de modelos dentro da aba Confecção (grupos de SIDEBAR_ESTRUTURA, com busca)
function renderConfeccao() {
  const el = document.getElementById('conf-catalogo');
  if (!el) return;
  const busca = (document.getElementById('conf-busca')?.value || '').trim().toLowerCase();
  const html = SIDEBAR_ESTRUTURA.map(grupo => {
    const cards = grupo.modelos
      .filter(k => MODELOS[k])
      .filter(k => !busca || String(((loadLocal('vc:' + k) || {}).nome || MODELOS[k].nome)).toLowerCase().includes(busca))
      .map(k => `<div class="conf-card" onclick="selectModel(null,'${k}')">${modeloLabelHtml(k)}</div>`)
      .join('');
    if (!cards) return '';
    return `<div class="card" style="margin-bottom:14px">
      <div class="card-title" style="margin-bottom:10px">${grupo.titulo}</div>
      <div class="conf-grid">${cards}</div>
    </div>`;
  }).join('');
  el.innerHTML = html || '<div style="color:var(--text-ter);font-size:13px;text-align:center;padding:24px">Nenhum modelo encontrado.</div>';
}

function finLock() {
  sessionStorage.removeItem('fin-ok');
  document.getElementById('fin-gate').style.display = '';
  document.getElementById('fin-content').style.display = 'none';
}

// ── Tráfego & Conversão (mesma senha do Financeiro) ──────────────────────────
function trafCarregarFrame() {
  const f = document.getElementById('traf-frame');
  if (f && !(f.getAttribute('src') || '').includes('trafego.html')) f.setAttribute('src', '/trafego.html?embed=1&v=2026062301');
}
function abrirTrafego(item) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (item) item.classList.add('active');
  if (!['__dashboard__', '__financeiro__', '__precos__', '__trafego__'].includes(modeloAtual) && (estEditado || prodEditado || cfgEditado)) {
    clearTimeout(saveTimer); salvarModelo();
  }
  estEditado = false; prodEditado = false; cfgEditado = false; esconderBtnSalvar();
  modeloAtual = '__trafego__';
  location.hash = 'trafego';
  document.getElementById('model-title').innerHTML = '<span style="font-family:\'Bebas Neue\',\'Arial Narrow\',sans-serif;font-weight:400;font-size:26px;letter-spacing:0.1em">TRÁFEGO</span>';
  document.getElementById('model-sub').textContent = '';
  document.getElementById('topbar-actions').style.display = 'none';
  document.getElementById('tabs-modelo').style.display = 'none';
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-trafego').classList.add('active');
  document.body.classList.remove('precos-mode');
  const ok = sessionStorage.getItem('fin-ok') === '1';
  document.getElementById('traf-gate').style.display = ok ? 'none' : '';
  document.getElementById('traf-content').style.display = ok ? '' : 'none';
  if (ok) trafCarregarFrame(); else setTimeout(() => document.getElementById('traf-senha')?.focus(), 60);
  closeSidebar();
}
async function trafUnlock() {
  const v = document.getElementById('traf-senha').value;
  if (await conferirSenha(v) === 'dona') {
    sessionStorage.setItem('fin-ok', '1');
    document.getElementById('traf-erro').textContent = '';
    document.getElementById('traf-senha').value = '';
    document.getElementById('traf-gate').style.display = 'none';
    document.getElementById('traf-content').style.display = '';
    trafCarregarFrame();
  } else {
    document.getElementById('traf-erro').textContent = 'Senha incorreta';
  }
}
function trafLock() {
  sessionStorage.removeItem('fin-ok');
  document.getElementById('traf-gate').style.display = '';
  document.getElementById('traf-content').style.display = 'none';
}

// ── Atendimento — SAC / Troca / Devolução / Vendas (mesma senha do Financeiro) ──
function abrirAtendimento(item) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (item) item.classList.add('active');
  if (!['__dashboard__', '__financeiro__', '__precos__', '__trafego__', '__fluxo__', '__atendimento__'].includes(modeloAtual) && (estEditado || prodEditado || cfgEditado)) {
    clearTimeout(saveTimer); salvarModelo();
  }
  estEditado = false; prodEditado = false; cfgEditado = false; esconderBtnSalvar();
  modeloAtual = '__atendimento__';
  location.hash = 'atendimento';
  document.getElementById('model-title').innerHTML = '<span style="font-family:\'Bebas Neue\',\'Arial Narrow\',sans-serif;font-weight:400;font-size:26px;letter-spacing:0.1em">ATENDIMENTO</span>';
  document.getElementById('model-sub').textContent = '';
  document.getElementById('topbar-actions').style.display = 'none';
  document.getElementById('tabs-modelo').style.display = 'none';
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-atendimento').classList.add('active');
  document.body.classList.add('precos-mode'); // esconde menu lateral p/ tela ampliada, igual Precificação
  const ok = sessionStorage.getItem('fin-ok') === '1';
  document.getElementById('atd-gate').style.display = ok ? 'none' : '';
  document.getElementById('atd-content').style.display = ok ? '' : 'none';
  if (ok) atdShowSub('sac'); else setTimeout(() => document.getElementById('atd-senha')?.focus(), 60);
  closeSidebar();
}
async function atdUnlock() {
  const v = document.getElementById('atd-senha').value;
  if (await conferirSenha(v) === 'dona') {
    sessionStorage.setItem('fin-ok', '1');
    document.getElementById('atd-erro').textContent = '';
    document.getElementById('atd-senha').value = '';
    document.getElementById('atd-gate').style.display = 'none';
    document.getElementById('atd-content').style.display = '';
    atdShowSub('sac');
  } else {
    document.getElementById('atd-erro').textContent = 'Senha incorreta';
  }
}
function atdLock() {
  sessionStorage.removeItem('fin-ok');
  document.getElementById('atd-gate').style.display = '';
  document.getElementById('atd-content').style.display = 'none';
}

// Alterna entre as 4 sub-seções (pílulas) dentro do painel Atendimento
function atdShowSub(sub) {
  ['kanban', 'sac', 'retorno', 'estorno'].forEach(s => {
    const el = document.getElementById('atd-sub-' + s);
    if (el) el.style.display = (s === sub) ? '' : 'none';
    const pill = document.getElementById('atd-pill-' + s);
    if (pill) pill.classList.toggle('active', s === sub);
  });
  if (sub === 'sac') sacRender();
  else if (sub === 'retorno') { retRender(); retSincronizarShopify(); }
  else if (sub === 'estorno') { estRender(); estSincronizarShopify(); }
  else if (sub === 'kanban') kbAbrir();
}

// ── SAC ──────────────────────────────────────────────────────────────────────
function sacGetConfig() {
  return loadLocal('vc:sac') || { tickets: [], updated_at: null };
}

// Busca o pedido na Shopify (debounced) e mostra cliente/itens/status assim que digita o número.
function sacBuscarPedido() {
  const numero = (document.getElementById('sac-pedido').value || '').trim();
  const preview = document.getElementById('sac-pedido-preview');
  clearTimeout(window._sacBuscaTimer);
  if (!numero) { preview.style.display = 'none'; preview.innerHTML = ''; return; }
  window._sacBuscaTimer = setTimeout(async () => {
    preview.style.display = '';
    preview.innerHTML = 'buscando pedido...';
    try {
      const res = await fetch(`/api/shopify-pedido-lookup?numero=${encodeURIComponent(numero)}`);
      const d = await res.json();
      if (document.getElementById('sac-pedido').value.trim() !== numero) return; // digitou algo novo enquanto buscava
      if (!d.encontrado) { preview.innerHTML = '<span style="color:var(--text-ter)">Pedido não encontrado.</span>'; return; }
      const itensTxt = (d.itens || []).map(i => `${i.qtd}× ${i.titulo}${i.variante ? ' (' + i.variante + ')' : ''}`).join(', ');
      const statusCor = d.cancelado ? '#dc2626' : (d.status_financeiro === 'paid' ? '#16a34a' : '#b45309');
      preview.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline">
          <strong>${d.numero}</strong>
          <span>${d.cliente || '(sem nome)'}</span>
          <span style="color:${statusCor};font-weight:600">${d.cancelado ? 'cancelado' : d.status_financeiro}</span>
          <span style="color:var(--text-ter)">${d.status_envio === 'fulfilled' ? 'enviado' : d.status_envio === 'partial' ? 'parcialmente enviado' : 'não enviado'}</span>
          ${d.rastreio ? `<span style="color:var(--text-ter)">rastreio: ${d.rastreio}</span>` : ''}
        </div>
        <div style="margin-top:4px;color:var(--text-ter)">${itensTxt || '(sem itens)'}</div>`;
      // Preenche o rastreio automaticamente se o campo ainda estiver vazio
      const rastreioEl = document.getElementById('sac-rastreio');
      if (d.rastreio && rastreioEl && !rastreioEl.value) rastreioEl.value = d.rastreio;
    } catch (e) {
      preview.innerHTML = '<span style="color:#dc2626">Erro ao buscar pedido.</span>';
    }
  }, 500);
}

function sacSalvar(cfg) {
  cfg.updated_at = new Date().toISOString();
  saveLocal('vc:sac', cfg);
  clearTimeout(window._sacSaveTimer);
  window._sacSaveTimer = setTimeout(() => salvarNuvem('sac', cfg), 900);
}
function sacAdd() {
  const pedido = (document.getElementById('sac-pedido').value || '').trim();
  const caso = (document.getElementById('sac-caso').value || '').trim();
  const rastreio = (document.getElementById('sac-rastreio').value || '').trim();
  if (!pedido || !caso) { alert('Preencha ao menos o nº do pedido e a informação do caso.'); return; }
  const cfg = sacGetConfig();
  const novo = {
    id: 'sac' + Date.now(), pedido, caso, info_expedicao: '',
    rastreio, status: 'pendente', criado_em: new Date().toISOString(),
  };
  cfg.tickets.push(novo);
  sacSalvar(cfg);
  sacRender();
  sacCarregarItens(novo.id, pedido); // busca itens/cliente em segundo plano
  ['sac-pedido', 'sac-caso', 'sac-rastreio'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('sac-pedido-preview').style.display = 'none';
  document.getElementById('sac-pedido').focus();
}

// Busca cliente/itens do pedido na Shopify e grava no ticket (uma vez só — fica salvo).
const _sacBuscandoItens = new Set();
async function sacCarregarItens(id, pedido) {
  if (_sacBuscandoItens.has(id)) return;
  _sacBuscandoItens.add(id);
  try {
    const res = await fetch(`/api/shopify-pedido-lookup?numero=${encodeURIComponent(pedido)}`);
    const d = await res.json();
    const cfg = sacGetConfig();
    const t = cfg.tickets.find(x => x.id === id); if (!t) return;
    t.cliente = d.encontrado ? (d.cliente || null) : null;
    t.itens = d.encontrado ? (d.itens || []) : [];
    t.itens_busca_em = new Date().toISOString();
    sacSalvar(cfg);
    sacRender();
    // Se o popup de seleção estava aberto pra esse ticket esperando os itens carregarem, atualiza com a lista.
    const popup = document.getElementById('sac-linha-itens-popup');
    if (popup && popup.dataset.ticketId === id && popup.style.display !== 'none') {
      const inputEl = document.querySelector(`[data-sac-info-id="${id}"]`);
      if (inputEl) sacMostrarItensLinha(id, inputEl);
    }
  } catch (e) {
  } finally {
    _sacBuscandoItens.delete(id);
  }
}

// Ao focar o campo "Info expedição" de um ticket já criado, mostra um popup com os itens
// do pedido (checkbox) pra marcar o que está faltando, igual ao formulário do topo.
function sacMostrarItensLinha(id, inputEl) {
  const cfg = sacGetConfig();
  const t = cfg.tickets.find(x => x.id === id); if (!t) return;
  const popup = document.getElementById('sac-linha-itens-popup');
  if (!popup) return;
  popup.dataset.ticketId = id;
  if (!t.itens || !t.itens.length) {
    popup.innerHTML = '<div style="padding:8px 10px;font-size:12px;color:var(--text-ter)">buscando itens do pedido...</div>';
    sacCarregarItens(id, t.pedido);
  } else {
    const itensHtml = t.itens.map((i, idx) => `
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;padding:3px 4px;font-size:12px;white-space:nowrap">
        <input type="checkbox" onchange="sacLinhaFaltanteToggle('${id}')" data-sac-linha-idx="${idx}">
        ${i.qtd}× ${i.titulo}${i.variante ? ' (' + i.variante + ')' : ''}
      </label>`).join('');
    popup.innerHTML = `<div style="font-size:10px;font-weight:700;color:var(--text-ter);padding:4px 4px 2px;text-transform:uppercase">marque o que está faltando</div>${itensHtml}`;
  }
  const r = inputEl.getBoundingClientRect();
  popup.style.left = Math.round(r.left) + 'px';
  popup.style.top = Math.round(r.bottom + 4) + 'px';
  popup.style.width = Math.max(r.width, 220) + 'px';
  popup.style.display = 'block';
}
function sacLinhaFaltanteToggle(id) {
  const popup = document.getElementById('sac-linha-itens-popup');
  const cfg = sacGetConfig();
  const t = cfg.tickets.find(x => x.id === id); if (!t || !popup) return;
  const marcados = Array.from(popup.querySelectorAll('[data-sac-linha-idx]:checked'))
    .map(el => t.itens[parseInt(el.dataset.sacLinhaIdx)])
    .filter(Boolean);
  const texto = marcados.length ? 'Faltando: ' + marcados.map(i => `${i.titulo}${i.variante ? ' (' + i.variante + ')' : ''}`).join(', ') : '';
  const inputEl = document.querySelector(`[data-sac-info-id="${id}"]`);
  if (inputEl) inputEl.value = texto;
  sacEdit(id, 'info_expedicao', texto);
}
document.addEventListener('click', (e) => {
  const popup = document.getElementById('sac-linha-itens-popup');
  if (!popup || popup.style.display === 'none') return;
  if (e.target.closest('#sac-linha-itens-popup') || e.target.closest('[data-sac-info-id]')) return;
  popup.style.display = 'none';
});
function sacToggle(id) {
  const cfg = sacGetConfig();
  const t = cfg.tickets.find(x => x.id === id); if (!t) return;
  t.status = (t.status === 'resolvido') ? 'pendente' : 'resolvido';
  t.resolvido_em = (t.status === 'resolvido') ? new Date().toISOString() : null;
  sacSalvar(cfg);
  atdSyncViews();
}
function sacEdit(id, campo, val) {
  const cfg = sacGetConfig();
  const t = cfg.tickets.find(x => x.id === id); if (!t) return;
  t[campo] = val;
  sacSalvar(cfg);
}
function sacDel(id) {
  if (!confirm('Excluir esse ticket de SAC?')) return;
  const cfg = sacGetConfig();
  cfg.tickets = cfg.tickets.filter(x => x.id !== id);
  sacSalvar(cfg);
  atdSyncViews();
}
function sacRender() {
  const cfg = sacGetConfig();
  const mostrarResolvidos = document.getElementById('sac-mostrar-resolvidos')?.checked;
  const lista = cfg.tickets
    .filter(t => mostrarResolvidos || t.status !== 'resolvido')
    .sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''));
  const itensPlano = t => {
    if (!t.itens || !t.itens.length) return '(sem itens carregados)';
    return t.itens.map(i => `${i.qtd}× ${i.titulo}${i.variante ? ' (' + i.variante + ')' : ''}`).join(', ');
  };
  const esc = v => (v || '').replace(/"/g, '&quot;');
  const rows = lista.map(t => `
    <tr style="${t.status === 'resolvido' ? 'opacity:0.5' : ''}">
      <td style="padding:4px;text-align:center;vertical-align:middle"><input type="checkbox" ${t.status === 'resolvido' ? 'checked' : ''} onchange="sacToggle('${t.id}')" title="marcar como resolvido"></td>
      <td style="padding:4px;width:100px;max-width:100px;font-weight:700;white-space:nowrap;text-align:left;vertical-align:middle" title="Itens do pedido: ${esc(itensPlano(t))}">${t.pedido}${t.cliente ? `<div style="font-weight:400;font-size:11px;color:var(--text-ter);overflow:hidden;text-overflow:ellipsis">${t.cliente}</div>` : ''}</td>
      <td style="padding:4px;vertical-align:middle"><input value="${esc(t.caso !== undefined ? t.caso : t.motivo)}" oninput="sacEdit('${t.id}','caso',this.value)" style="width:100%;min-width:180px;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px;${t.status === 'resolvido' ? 'text-decoration:line-through' : ''}"></td>
      <td style="padding:4px;vertical-align:middle"><input value="${esc(t.info_expedicao || t.itens_faltantes)}" data-sac-info-id="${t.id}" oninput="sacEdit('${t.id}','info_expedicao',this.value)" onfocus="sacMostrarItensLinha('${t.id}', this)" style="width:100%;min-width:220px;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:4px;vertical-align:middle"><input value="${esc(t.rastreio)}" oninput="sacEdit('${t.id}','rastreio',this.value)" style="width:130px;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:4px;text-align:center;vertical-align:middle"><button onclick="sacDel('${t.id}')" title="excluir" style="background:none;border:none;cursor:pointer;color:var(--text-ter);font-size:15px">×</button></td>
    </tr>`).join('');
  document.getElementById('sac-tbody').innerHTML = rows ||
    '<tr><td colspan="6" style="text-align:center;color:var(--text-ter);font-size:12px;padding:12px">Nenhum ticket ' + (mostrarResolvidos ? '' : 'pendente') + '.</td></tr>';
  const total = cfg.tickets.filter(t => t.status !== 'resolvido').length;
  const totalEl = document.getElementById('sac-total-pendentes');
  if (totalEl) totalEl.textContent = total + ' pendente' + (total === 1 ? '' : 's');
  // Busca itens em segundo plano pros tickets que ainda não têm (ex.: criados antes dessa função existir)
  lista.filter(t => t.itens === undefined).forEach(t => sacCarregarItens(t.id, t.pedido));
}

// ── Retorno (Troca) ───────────────────────────────────────────────────────────
function retGetConfig() {
  return loadLocal('vc:retorno') || { itens: [], updated_at: null };
}
function retSalvar(cfg) {
  cfg.updated_at = new Date().toISOString();
  saveLocal('vc:retorno', cfg);
  clearTimeout(window._retSaveTimer);
  window._retSaveTimer = setTimeout(() => salvarNuvem('retorno', cfg), 900);
}
// Busca o pedido na Shopify (debounced) e mostra os itens com checkbox pra marcar o(s) que está(ão) na troca.
function retBuscarPedido() {
  const numero = (document.getElementById('ret-pedido').value || '').trim();
  const preview = document.getElementById('ret-pedido-preview');
  clearTimeout(window._retBuscaTimer);
  if (!numero) { preview.style.display = 'none'; preview.innerHTML = ''; return; }
  window._retBuscaTimer = setTimeout(async () => {
    preview.style.display = '';
    preview.innerHTML = 'buscando pedido...';
    try {
      const res = await fetch(`/api/shopify-pedido-lookup?numero=${encodeURIComponent(numero)}`);
      const d = await res.json();
      if (document.getElementById('ret-pedido').value.trim() !== numero) return;
      if (!d.encontrado) { preview.innerHTML = '<span style="color:var(--text-ter)">Pedido não encontrado.</span>'; return; }
      window._retItensAtuais = d.itens || [];
      const itensHtml = (d.itens || []).map((i, idx) => `
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer;padding:2px 0">
          <input type="checkbox" onchange="retTrocaToggle()" data-ret-troca="${idx}">
          ${i.qtd}× ${i.titulo}${i.variante ? ' (' + i.variante + ')' : ''}
        </label>`).join('');
      preview.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline">
          <strong>${d.numero}</strong>
          <span>${d.cliente || '(sem nome)'}</span>
        </div>
        <div style="margin-top:4px">${itensHtml || '<span style="color:var(--text-ter)">(sem itens)</span>'}</div>
        ${(d.itens || []).length ? '<div style="font-size:11px;color:var(--text-ter);margin-top:2px">marque a(s) peça(s) que fazem parte da troca</div>' : ''}`;
      const clienteEl = document.getElementById('ret-cliente');
      if (d.cliente && clienteEl && !clienteEl.value) clienteEl.value = d.cliente;
    } catch (e) {
      preview.innerHTML = '<span style="color:#dc2626">Erro ao buscar pedido.</span>';
    }
  }, 500);
}
// Monta "Produtos" a partir das peças marcadas na prévia do pedido.
function retTrocaToggle() {
  const marcados = Array.from(document.querySelectorAll('[data-ret-troca]:checked'))
    .map(el => window._retItensAtuais[parseInt(el.dataset.retTroca)])
    .filter(Boolean);
  const produtosEl = document.getElementById('ret-produtos');
  if (!produtosEl) return;
  if (marcados.length === 0) { produtosEl.value = ''; return; }
  produtosEl.value = marcados.map(i => `${i.titulo}${i.variante ? ' (' + i.variante + ')' : ''}`).join(', ');
}
function retAdd() {
  const pedido      = (document.getElementById('ret-pedido').value || '').trim();
  const cliente     = (document.getElementById('ret-cliente').value || '').trim();
  const produtos    = (document.getElementById('ret-produtos').value || '').trim();
  const obs         = (document.getElementById('ret-obs').value || '').trim();
  const codigo      = (document.getElementById('ret-codigo').value || '').trim();
  const logReversa  = (document.getElementById('ret-logistica-reversa').value || '').trim();
  if (!cliente || !produtos) { alert('Preencha ao menos o cliente e os produtos.'); return; }
  const cfg = retGetConfig();
  cfg.itens.push({ id: 'ret' + Date.now(), pedido, cliente, produtos, obs, codigo_reenvio: codigo, codigo_logistica_reversa: logReversa, chegou_reversa: false, data_chegada_reversa: '', status: 'pendente', criado_em: new Date().toISOString() });
  retSalvar(cfg);
  retRender();
  ['ret-pedido', 'ret-cliente', 'ret-produtos', 'ret-obs', 'ret-codigo', 'ret-logistica-reversa'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('ret-pedido-preview').style.display = 'none';
  document.getElementById('ret-pedido').focus();
}
function retChegouReversaToggle(id) {
  const cfg = retGetConfig();
  const t = cfg.itens.find(x => x.id === id); if (!t) return;
  t.chegou_reversa = !t.chegou_reversa;
  retSalvar(cfg);
}
// Data em que a peça chegou dos Correios (logística reversa). Preencher a data marca "chegou"; limpar desmarca.
function retDataReversa(id, value) {
  const cfg = retGetConfig();
  const t = cfg.itens.find(x => x.id === id); if (!t) return;
  t.data_chegada_reversa = value || '';
  t.chegou_reversa = !!value;
  retSalvar(cfg);
  atdSyncViews();
}
function retToggle(id) {
  const cfg = retGetConfig();
  const t = cfg.itens.find(x => x.id === id); if (!t) return;
  t.status = (t.status === 'resolvido') ? 'pendente' : 'resolvido';
  t.resolvido_em = (t.status === 'resolvido') ? new Date().toISOString() : null;
  retSalvar(cfg);
  atdSyncViews();
}
function retEdit(id, campo, val) {
  const cfg = retGetConfig();
  const t = cfg.itens.find(x => x.id === id); if (!t) return;
  t[campo] = val;
  retSalvar(cfg);
}
function retDel(id) {
  if (!confirm('Excluir esse registro de troca?')) return;
  const cfg = retGetConfig();
  cfg.itens = cfg.itens.filter(x => x.id !== id);
  retSalvar(cfg);
  atdSyncViews();
}

// Puxa da Shopify as trocas solicitadas (devolução com exchangeLineItems — cliente pediu
// outra peça em vez do dinheiro) e adiciona as que ainda não estão na lista.
async function retSincronizarShopify() {
  const statusEl = document.getElementById('atd-ret-sync-status');
  if (statusEl) statusEl.textContent = 'buscando trocas na Shopify...';
  try {
    const res = await fetch('/api/shopify-devolucoes-pendentes');
    const d = await res.json();
    if (!d.trocas) { if (statusEl) statusEl.textContent = 'erro ao buscar trocas da Shopify'; return; }
    const cfg = retGetConfig();
    const existentes = new Set(cfg.itens.map(t => t.shopify_id).filter(Boolean));
    let novos = 0;
    d.trocas.forEach(tr => {
      if (existentes.has(tr.id)) return; // já importado antes — não duplica nem sobrescreve
      cfg.itens.push({
        id: 'ret' + Date.now() + Math.random().toString(36).slice(2, 6),
        shopify_id: tr.id,
        cliente: tr.cliente || '',
        data: tr.data ? new Date(tr.data).toLocaleDateString('pt-BR') : '',
        produtos: `${tr.produtos} → troca por ${tr.troca_por}`,
        obs: `Pedido ${tr.pedido}${tr.motivo ? ' — ' + tr.motivo : ''}`,
        codigo_reenvio: '',
        status: 'pendente',
        criado_em: new Date().toISOString(),
      });
      novos++;
    });
    if (novos > 0) { retSalvar(cfg); retRender(); }
    if (statusEl) statusEl.textContent = novos > 0 ? `${novos} troca${novos > 1 ? 's' : ''} nova${novos > 1 ? 's' : ''} importada${novos > 1 ? 's' : ''} da Shopify` : 'sincronizado — nenhuma troca nova';
  } catch (e) {
    if (statusEl) statusEl.textContent = 'erro ao buscar trocas da Shopify';
  }
}
const RET_TAMANHOS = ['PP', 'P', 'M', 'G', 'GG'];
// Faixas de envelhecimento (tempo na fila aguardando resolução) — quanto mais tempo, tom mais forte.
// bg = fundo da LINHA nas listas (fundo branco liso). cardBg = fundo do CARD no Kanban, mais
// forte (o card é vidro fosco, então tint fraco some) — mesma cor, alpha maior.
const RET_BUCKETS = [
  { min: 14, label: '🔴 Crítico · 14+ dias na fila', bg: 'rgba(255,59,48,.30)', cardBg: 'rgba(255,59,48,.26)',  bar: '#ff3b30', bold: true },
  { min: 7,  label: '🔴 Atrasado · 7 a 13 dias',      bg: 'rgba(255,59,48,.15)', cardBg: 'rgba(255,59,48,.16)',  bar: '#ff3b30', bold: false },
  { min: 4,  label: '🟠 Atenção · 4 a 6 dias',        bg: 'rgba(255,149,0,.14)', cardBg: 'rgba(255,149,0,.20)',  bar: '#ff9500', bold: false },
  { min: 2,  label: '🟡 Recente · 2 a 3 dias',        bg: 'rgba(255,204,0,.10)', cardBg: 'rgba(255,204,0,.20)',  bar: '#ffcc00', bold: false },
  { min: 0,  label: '⚪ Novo · hoje / ontem',          bg: '',                    cardBg: '',                     bar: 'var(--border)', bold: false },
];
function retDiasNaFila(t) {
  // Prefere a data real da solicitação/pedido (campo `data`, DD/MM/YYYY) — o criado_em costuma
  // ser a data do cadastro em massa no sistema, que não reflete o tempo real de espera.
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t.data || '');
  if (m) {
    const ms = Date.now() - new Date(+m[3], +m[2] - 1, +m[1]).getTime();
    if (!isNaN(ms)) return Math.max(0, Math.floor(ms / 86400000));
  }
  if (!t.criado_em) return 0;
  const ms = Date.now() - new Date(t.criado_em).getTime();
  return isNaN(ms) ? 0 : Math.max(0, Math.floor(ms / 86400000));
}
function retBucket(dias) {
  return RET_BUCKETS.find(b => dias >= b.min) || RET_BUCKETS[RET_BUCKETS.length - 1];
}
function retRowHtml(t, esc, bg, bold, dias) {
  const resolvido = t.status === 'resolvido';
  const obsVal = t.obs || '';
  const obsCustom = (obsVal && !RET_TAMANHOS.includes(obsVal)) ? `<option value="${esc(obsVal)}" selected>${esc(obsVal)}</option>` : '';
  const obsOptions = RET_TAMANHOS.map(s => `<option value="${s}" ${obsVal === s ? 'selected' : ''}>${s}</option>`).join('');
  const badge = (!resolvido && dias >= 2) ? `<div><span style="display:inline-block;margin-top:2px;font-size:10px;font-weight:700;color:#fff;background:${retBucket(dias).bar};border-radius:4px;padding:1px 5px">${dias} dias na fila</span></div>` : '';
  const trStyle = resolvido ? 'opacity:0.5' : (bg ? `background:${bg};${bold ? 'font-weight:600;' : ''}` : '');
  return `
    <tr style="${trStyle}">
      <td style="padding:4px;text-align:center;vertical-align:middle"><input type="checkbox" ${resolvido ? 'checked' : ''} onchange="retToggle('${t.id}')" title="marcar como resolvido"></td>
      <td style="padding:4px;vertical-align:middle"><input value="${esc(t.cliente)}" oninput="retEdit('${t.id}','cliente',this.value)" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px;${resolvido ? 'text-decoration:line-through' : ''}">${t.pedido ? `<div style="font-size:10px;color:var(--text-ter);margin-top:2px">pedido ${esc(t.pedido)}</div>` : ''}${badge}</td>
      <td style="padding:4px;vertical-align:middle"><input value="${esc(t.produtos)}" oninput="retEdit('${t.id}','produtos',this.value)" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:4px;vertical-align:middle"><select onchange="retEdit('${t.id}','obs',this.value)" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px">
        <option value="" ${!obsVal ? 'selected' : ''}>—</option>
        ${obsCustom}
        ${obsOptions}
      </select></td>
      <td style="padding:4px;vertical-align:middle"><input value="${esc(t.codigo_logistica_reversa)}" oninput="retEdit('${t.id}','codigo_logistica_reversa',this.value)" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:4px;text-align:center;vertical-align:middle"><input type="date" value="${t.data_chegada_reversa || ''}" onchange="retDataReversa('${t.id}',this.value)" onclick="try{this.showPicker()}catch(e){}" title="clique para abrir o calendário — data em que a peça chegou dos Correios (logística reversa)" style="cursor:pointer;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px;${t.chegou_reversa ? 'background:rgba(52,199,89,.12)' : ''}"></td>
      <td style="padding:4px;vertical-align:middle"><input value="${esc(t.codigo_reenvio)}" oninput="retEdit('${t.id}','codigo_reenvio',this.value)" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:4px;text-align:center;vertical-align:middle"><button onclick="retDel('${t.id}')" title="excluir" style="background:none;border:none;cursor:pointer;color:var(--text-ter);font-size:15px">×</button></td>
    </tr>`;
}
function retRender() {
  const cfg = retGetConfig();
  const mostrarResolvidos = document.getElementById('ret-mostrar-resolvidos')?.checked;
  const esc = v => (v || '').replace(/"/g, '&quot;');
  // Pendentes: agrupados por tempo na fila, mais antigos (tom mais forte) primeiro.
  const pendentes = cfg.itens
    .filter(t => t.status !== 'resolvido')
    .map(t => ({ t, dias: retDiasNaFila(t) }))
    .sort((a, b) => b.dias - a.dias);
  let html = '';
  let lastBucket = null;
  pendentes.forEach(({ t, dias }) => {
    const b = retBucket(dias);
    if (b.label !== lastBucket) {
      lastBucket = b.label;
      const n = pendentes.filter(x => retBucket(x.dias).label === b.label).length;
      html += `<tr><td colspan="8" style="padding:9px 6px 4px;border-left:3px solid ${b.bar};background:${b.bg || 'transparent'}"><span style="font-size:11px;font-weight:700;color:var(--text-sec);text-transform:uppercase;letter-spacing:.3px">${b.label} · ${n}</span></td></tr>`;
    }
    html += retRowHtml(t, esc, b.bg, b.bold, dias);
  });
  if (mostrarResolvidos) {
    const resolvidos = cfg.itens
      .filter(t => t.status === 'resolvido')
      .sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''));
    if (resolvidos.length) {
      html += `<tr><td colspan="8" style="padding:9px 6px 4px"><span style="font-size:11px;font-weight:700;color:var(--text-ter);text-transform:uppercase;letter-spacing:.3px">✅ Resolvidos · ${resolvidos.length}</span></td></tr>`;
      resolvidos.forEach(t => { html += retRowHtml(t, esc, '', false, retDiasNaFila(t)); });
    }
  }
  document.getElementById('ret-tbody').innerHTML = html ||
    '<tr><td colspan="8" style="text-align:center;color:var(--text-ter);font-size:12px;padding:12px">Nenhum registro ' + (mostrarResolvidos ? '' : 'pendente') + '.</td></tr>';
  const total = cfg.itens.filter(t => t.status !== 'resolvido').length;
  const totalEl = document.getElementById('ret-total-pendentes');
  if (totalEl) totalEl.textContent = total + ' pendente' + (total === 1 ? '' : 's');
}

// ── Estorno (Devolução) ───────────────────────────────────────────────────────
function estGetConfig() {
  return loadLocal('vc:estorno') || { itens: [], updated_at: null };
}
function estSalvar(cfg) {
  cfg.updated_at = new Date().toISOString();
  saveLocal('vc:estorno', cfg);
  clearTimeout(window._estSaveTimer);
  window._estSaveTimer = setTimeout(() => salvarNuvem('estorno', cfg), 900);
}
function estAdd() {
  const cliente = (document.getElementById('atd-est-cliente').value || '').trim();
  const pecas   = (document.getElementById('atd-est-pecas').value || '').trim();
  const valor   = parseFloat((document.getElementById('atd-est-valor').value || '0').replace(',', '.')) || 0;
  const codigo  = (document.getElementById('atd-est-codigo').value || '').trim();
  const data    = (document.getElementById('atd-est-data').value || '').trim();
  const motivo  = (document.getElementById('atd-est-motivo').value || '').trim();
  if (!cliente || !pecas) { alert('Preencha ao menos o cliente e as peças.'); return; }
  const cfg = estGetConfig();
  cfg.itens.push({ id: 'est' + Date.now(), cliente, pecas, valor, codigo_devolucao: codigo, data, motivo, criado_em: new Date().toISOString() });
  estSalvar(cfg);
  estRender();
  ['atd-est-cliente', 'atd-est-pecas', 'atd-est-valor', 'atd-est-codigo', 'atd-est-data', 'atd-est-motivo'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('atd-est-cliente').focus();
}
function estEdit(id, campo, val) {
  const cfg = estGetConfig();
  const t = cfg.itens.find(x => x.id === id); if (!t) return;
  t[campo] = (campo === 'valor') ? (parseFloat(String(val).replace(',', '.')) || 0) : val;
  estSalvar(cfg);
  // Sem re-render a cada tecla (mataria o foco do input e, com ordenação ativa, a linha
  // trocaria de posição no meio da digitação) — mesmo padrão do retEdit. Só o total atualiza.
  if (campo === 'valor') {
    const total = cfg.itens.reduce((s, x) => s + (x.valor || 0), 0);
    const totalEl = document.getElementById('atd-est-total-valor');
    if (totalEl) totalEl.textContent = 'R$ ' + total.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
function estDel(id) {
  if (!confirm('Excluir esse registro de devolução?')) return;
  const cfg = estGetConfig();
  cfg.itens = cfg.itens.filter(x => x.id !== id);
  estSalvar(cfg);
  atdSyncViews();
}

// Puxa da Shopify as devoluções solicitadas (ainda não processadas) e adiciona as que
// ainda não estão na lista (não sobrescreve o que já foi editado manualmente).
async function estSincronizarShopify() {
  const statusEl = document.getElementById('atd-est-sync-status');
  if (statusEl) statusEl.textContent = 'buscando devoluções na Shopify...';
  try {
    const res = await fetch('/api/shopify-devolucoes-pendentes');
    const d = await res.json();
    if (!d.devolucoes) { if (statusEl) statusEl.textContent = 'erro ao buscar devoluções da Shopify'; return; }
    const cfg = estGetConfig();
    const existentes = new Set(cfg.itens.map(t => t.shopify_id).filter(Boolean));
    let novos = 0;
    d.devolucoes.forEach(dv => {
      if (existentes.has(dv.id)) return; // já importado antes — não duplica nem sobrescreve
      cfg.itens.push({
        id: 'est' + Date.now() + Math.random().toString(36).slice(2, 6),
        shopify_id: dv.id,
        cliente: dv.cliente || '',
        pecas: `${dv.peca} — pedido ${dv.pedido}`,
        valor: dv.valor || 0,
        codigo_devolucao: dv.codigo_devolucao || '',
        data: dv.data ? new Date(dv.data).toLocaleDateString('pt-BR') : '',
        motivo: dv.motivo + (dv.motivo_nota ? ' — ' + dv.motivo_nota : ''),
        criado_em: new Date().toISOString(),
      });
      novos++;
    });
    if (novos > 0) { estSalvar(cfg); estRender(); }
    if (statusEl) statusEl.textContent = novos > 0 ? `${novos} devolução${novos > 1 ? 'ões' : ''} nova${novos > 1 ? 's' : ''} importada${novos > 1 ? 's' : ''} da Shopify` : 'sincronizado — nenhuma devolução nova';
  } catch (e) {
    if (statusEl) statusEl.textContent = 'erro ao buscar devoluções da Shopify';
  }
}
function estConcluida(t) { return t.status === 'resolvido' || t.etapa === 'concluido'; }
// Tempo na fila da DEVOLUÇÃO: usa a data real da solicitação (campo `data`, DD/MM/YYYY) —
// o `criado_em` é a data do import em massa (13/07), que zeraria o tempo de espera real.
// Lê a data digitada. Aceita "DD/MM/AAAA" (formato do import da Shopify) e também
// "DD/MM" — que é o formato que o próprio placeholder do campo sugere ("ex.: 03/08") e
// era lido como data vazia: o registro manual perdia o tempo de fila e caía no fim da
// ordenação por data. Sem ano, assume o ano corrente; se cair no futuro, o anterior.
function estDataMs(valor) {
  const s = String(valor || '').trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]).getTime();
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) {
    const ano = new Date().getFullYear();
    const ts = new Date(ano, +m[2] - 1, +m[1]).getTime();
    return ts > Date.now() + 86400000 ? new Date(ano - 1, +m[2] - 1, +m[1]).getTime() : ts;
  }
  return null;
}
function estDiasNaFila(t) {
  const ms = estDataMs(t.data);
  if (ms !== null && !isNaN(ms)) return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
  return retDiasNaFila(t);
}
function estRowHtml(t, bg, bold, dias) {
  const esc = v => (v || '').replace(/"/g, '&quot;');
  const concl = estConcluida(t);
  const badge = (!concl && dias >= 2) ? `<div><span style="display:inline-block;margin-top:2px;font-size:10px;font-weight:700;color:#fff;background:${retBucket(dias).bar};border-radius:4px;padding:1px 5px">${dias} dias na fila</span></div>` : '';
  const trStyle = concl ? 'opacity:0.5' : (bg ? `background:${bg};${bold ? 'font-weight:600;' : ''}` : '');
  return `
    <tr style="${trStyle}">
      <td style="padding:4px"><input value="${esc(t.cliente)}" oninput="estEdit('${t.id}','cliente',this.value)" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px">${badge}</td>
      <td style="padding:4px"><input value="${esc(t.pecas)}" oninput="estEdit('${t.id}','pecas',this.value)" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:4px"><input type="number" step="0.01" value="${t.valor}" oninput="estEdit('${t.id}','valor',this.value)" style="width:100%;text-align:right;font-size:12px;font-weight:700;color:var(--gold-dark);padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:4px"><input value="${esc(t.codigo_devolucao)}" oninput="estEdit('${t.id}','codigo_devolucao',this.value)" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:4px;white-space:nowrap">${t.data || ''}</td>
      <td style="padding:4px"><input value="${esc(t.motivo)}" oninput="estEdit('${t.id}','motivo',this.value)" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:4px;text-align:center"><button onclick="estDel('${t.id}')" title="excluir" style="background:none;border:none;cursor:pointer;color:var(--text-ter);font-size:15px">×</button></td>
    </tr>`;
}
// Ordenação por coluna (clique no cabeçalho): 1º clique asc, 2º desc, 3º volta à visão padrão (fila).
let estSort = null; // { campo, dir: 1 | -1 }
function estOrdenar(campo) {
  if (estSort && estSort.campo === campo) estSort = estSort.dir === 1 ? { campo, dir: -1 } : null;
  else estSort = { campo, dir: 1 };
  estRender();
}
function estChaveOrdenacao(t, campo) {
  if (campo === 'valor') return t.valor || 0;
  if (campo === 'data') {
    const ms = estDataMs(t.data);
    return ms === null ? '' : ms;
  }
  return String(t[campo] || '').trim().toLowerCase();
}
function estComparar(a, b) {
  const va = estChaveOrdenacao(a, estSort.campo), vb = estChaveOrdenacao(b, estSort.campo);
  // Vazios sempre no fim, independente da direção.
  if (va === '' && vb !== '') return 1;
  if (vb === '' && va !== '') return -1;
  const cmp = (typeof va === 'number' && typeof vb === 'number') ? va - vb : String(va).localeCompare(String(vb), 'pt-BR');
  return cmp * estSort.dir;
}
function estAtualizarSetas() {
  document.querySelectorAll('#atd-sub-estorno th[data-sort]').forEach(th => {
    const s = th.querySelector('.est-arrow');
    if (s) s.textContent = (estSort && estSort.campo === th.dataset.sort) ? (estSort.dir === 1 ? '▲' : '▼') : '';
  });
}
function estRender() {
  const cfg = estGetConfig();
  const pendentes = cfg.itens
    .filter(t => !estConcluida(t))
    .map(t => ({ t, dias: estDiasNaFila(t) }));
  let html = '';
  if (estSort) {
    // Visão ordenada por coluna: lista corrida (sem faixas), mantendo a cor de urgência por linha.
    pendentes.sort((a, b) => estComparar(a.t, b.t));
    pendentes.forEach(({ t, dias }) => {
      const b = retBucket(dias);
      html += estRowHtml(t, b.bg, b.bold, dias);
    });
  } else {
    // Visão padrão: primeiro as lançadas À MÃO no atendimento (não têm `shopify_id`),
    // depois as importadas da Shopify; dentro de cada grupo, da data MAIS RECENTE para a
    // mais antiga. A cor de urgência e o selo "N dias na fila" continuam por linha, então
    // dá para ver o que está crítico sem depender do agrupamento por tempo de fila.
    const grupos = [
      { label: 'Inseridas manualmente', itens: pendentes.filter(x => !x.t.shopify_id) },
      { label: 'Importadas da Shopify', itens: pendentes.filter(x =>  x.t.shopify_id) },
    ];
    grupos.forEach(g => {
      if (!g.itens.length) return;
      // Sem data preenchida vai para o fim do grupo (empate resolve pelo tempo de fila).
      g.itens.sort((a, b) => {
        const da = estChaveOrdenacao(a.t, 'data'), db = estChaveOrdenacao(b.t, 'data');
        if (da === '' && db === '') return b.dias - a.dias;
        if (da === '') return 1;
        if (db === '') return -1;
        return db - da;
      });
      html += `<tr><td colspan="7" style="padding:9px 6px 4px;border-left:3px solid var(--border)"><span style="font-size:11px;font-weight:700;color:var(--text-sec);text-transform:uppercase;letter-spacing:.3px">${g.label} · ${g.itens.length}</span></td></tr>`;
      g.itens.forEach(({ t, dias }) => {
        const b = retBucket(dias);
        html += estRowHtml(t, b.bg, b.bold, dias);
      });
    });
  }
  const concluidas = cfg.itens
    .filter(estConcluida)
    .sort(estSort ? estComparar : ((a, b) => (b.criado_em || '').localeCompare(a.criado_em || '')));
  if (concluidas.length) {
    html += `<tr><td colspan="7" style="padding:9px 6px 4px"><span style="font-size:11px;font-weight:700;color:var(--text-ter);text-transform:uppercase;letter-spacing:.3px">✅ Concluídas · ${concluidas.length}</span></td></tr>`;
    concluidas.forEach(t => { html += estRowHtml(t, '', false, estDiasNaFila(t)); });
  }
  document.getElementById('atd-est-tbody').innerHTML = html ||
    '<tr><td colspan="7" style="text-align:center;color:var(--text-ter);font-size:12px;padding:12px">Nenhum registro de devolução.</td></tr>';
  const total = cfg.itens.reduce((s, t) => s + (t.valor || 0), 0);
  const totalEl = document.getElementById('atd-est-total-valor');
  if (totalEl) totalEl.textContent = 'R$ ' + total.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  estAtualizarSetas();
}

// ── CRM Kanban — solicitações em andamento (SAC + Trocas + Devoluções) ───────
// Agrega os itens ABERTOS das três listas do Atendimento num quadro de etapas.
// A etapa fica gravada no PRÓPRIO item (`etapa`/`etapa_em`) dentro do storage de origem
// (vc:sac / vc:retorno / vc:estorno) — sem storage novo, e a lista de origem continua
// sendo a fonte da verdade. Concluído no kanban ⇒ resolvido na lista (e vice-versa).
const KB_ETAPAS = [
  ['novo', 'Novo', '#5b8def'],
  ['andamento', 'Em andamento', '#c99a3c'],
  ['aguardando', 'Aguardando cliente', '#8a63d2'],
  ['concluido', 'Concluído', '#3aa76d'],
];
const KB_TIPOS = {
  sac: { rotulo: 'SAC', badge: 'kb-b-sac', pill: 'sac' },
  ret: { rotulo: 'Troca', badge: 'kb-b-ret', pill: 'retorno' },
  est: { rotulo: 'Devolução', badge: 'kb-b-est', pill: 'estorno' },
};
function kbGet(tipo) {
  if (tipo === 'sac') { const cfg = sacGetConfig(); return { cfg, arr: cfg.tickets, salvar: sacSalvar }; }
  if (tipo === 'ret') { const cfg = retGetConfig(); return { cfg, arr: cfg.itens, salvar: retSalvar }; }
  const cfg = estGetConfig(); return { cfg, arr: cfg.itens, salvar: estSalvar };
}
function kbEtapaDe(tipo, t) {
  if (t.etapa && KB_ETAPAS.some(([k]) => k === t.etapa)) {
    // status resolvido na lista prevalece sobre uma etapa antiga não-concluída (e vice-versa)
    if (tipo !== 'est' && t.status === 'resolvido' && t.etapa !== 'concluido') return 'concluido';
    if (tipo !== 'est' && t.status !== 'resolvido' && t.etapa === 'concluido') return 'andamento';
    return t.etapa;
  }
  if (tipo !== 'est' && t.status === 'resolvido') return 'concluido';
  if (tipo === 'ret' && t.chegou_reversa) return 'andamento';
  return 'novo';
}
// Abre o quadro: renderiza já e, em paralelo, importa trocas/devoluções novas da Shopify.
function kbAbrir() {
  kbRender();
  const st = document.getElementById('kb-status');
  if (st) st.textContent = 'sincronizando com a Shopify...';
  Promise.allSettled([retSincronizarShopify(), estSincronizarShopify()]).then(() => {
    kbRender();
    if (st) st.textContent = 'sincronizado ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  });
}
function kbRender() {
  const board = document.getElementById('kb-board');
  if (!board) return;
  const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const cards = [];
  sacGetConfig().tickets.forEach(t => cards.push({
    tipo: 'sac', t,
    nome: (t.pedido ? '#' + t.pedido + ' · ' : '') + (t.cliente || 'sem cliente'),
    corpo: t.caso !== undefined ? t.caso : (t.motivo || ''),
    meta: [t.info_expedicao, t.rastreio ? 'rastreio ' + t.rastreio : ''].filter(Boolean).join(' · '),
  }));
  retGetConfig().itens.forEach(t => cards.push({
    tipo: 'ret', t,
    nome: t.cliente || 'sem cliente',
    corpo: t.produtos || '',
    meta: [t.obs ? 'tam. ' + t.obs : '', t.chegou_reversa ? ('chegou' + (t.data_chegada_reversa ? ' ' + t.data_chegada_reversa.split('-').reverse().join('/') : '')) : (t.codigo_logistica_reversa ? 'reversa ' + t.codigo_logistica_reversa : ''), t.codigo_reenvio ? 'reenvio ' + t.codigo_reenvio : ''].filter(Boolean).join(' · '),
  }));
  estGetConfig().itens.forEach(t => cards.push({
    tipo: 'est', t,
    nome: t.cliente || 'sem cliente',
    corpo: [t.pecas, t.motivo].filter(Boolean).join(' — '),
    meta: [t.valor ? 'R$ ' + Number(t.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '', t.data || ''].filter(Boolean).join(' · '),
  }));
  const corte = Date.now() - 14 * 24 * 3600 * 1000; // Concluído mostra só os últimos 14 dias
  const porEtapa = Object.fromEntries(KB_ETAPAS.map(([k]) => [k, []]));
  cards.forEach(c => {
    const etapa = kbEtapaDe(c.tipo, c.t);
    if (etapa === 'concluido') {
      const quando = new Date(c.t.resolvido_em || c.t.etapa_em || c.t.criado_em || 0).getTime();
      if (quando < corte) return;
    }
    porEtapa[etapa].push({ ...c, etapa });
  });
  const dataDe = t => t.criado_em ? new Date(t.criado_em).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '';
  board.innerHTML = KB_ETAPAS.map(([key, titulo, cor]) => {
    // Concluído: mais recentes no topo. Demais etapas: mais tempo na fila (mais urgente) no topo.
    const diasCard = c => c.tipo === 'est' ? estDiasNaFila(c.t) : retDiasNaFila(c.t);
    const lista = porEtapa[key].sort((a, b) => key === 'concluido'
      ? (b.t.criado_em || '').localeCompare(a.t.criado_em || '')
      : diasCard(b) - diasCard(a));
    const cardsHtml = lista.map(c => {
      const tp = KB_TIPOS[c.tipo];
      const mover = KB_ETAPAS.map(([k, l]) => `<option value="${k}" ${k === c.etapa ? 'selected' : ''}>${l}</option>`).join('');
      // Heatmap de envelhecimento — mesma lógica das listas (só nas não-concluídas).
      const dias = diasCard(c);
      const b = retBucket(dias);
      const isConcl = c.etapa === 'concluido';
      const cardStyle = isConcl ? '' : `border-left:5px solid ${b.bar};${b.cardBg ? 'background:' + b.cardBg + ';backdrop-filter:none;-webkit-backdrop-filter:none;' : ''}`;
      const agingBadge = (!isConcl && dias >= 2) ? `<span class="kb-badge" style="background:${b.bar};color:#fff" title="tempo na fila aguardando resolução">${dias}d na fila</span>` : '';
      return `
      <div class="kb-card" draggable="true" style="${cardStyle}"
           ondragstart="kbDragStart(event,'${c.tipo}','${c.t.id}')" ondragend="kbDragEnd(event)">
        <span class="kb-badge ${tp.badge}" style="cursor:pointer" title="abrir na lista de ${tp.rotulo}" onclick="atdShowSub('${tp.pill}')">${tp.rotulo}</span>
        ${agingBadge}
        <div class="kb-nome" title="${esc(c.nome)}">${esc(c.nome)}</div>
        ${c.corpo ? `<div class="kb-corpo">${esc(c.corpo)}</div>` : ''}
        <div class="kb-meta">
          ${c.meta ? `<span>${esc(c.meta)}</span>` : ''}
          <span>${dataDe(c.t)}</span>
          <select class="kb-mover" title="mover de etapa (alternativa ao arrastar)" onchange="kbSetEtapa('${c.tipo}','${c.t.id}',this.value)">${mover}</select>
        </div>
      </div>`;
    }).join('');
    return `
    <div class="kb-col" ondragover="kbAllowDrop(event)" ondragleave="kbLeave(event)" ondrop="kbDrop(event,'${key}')">
      <div class="kb-col-head">
        <span class="kb-dot" style="background:${cor};color:${cor}"></span>
        <span class="kb-col-title">${titulo}</span>
        <span class="kb-count">${lista.length}</span>
      </div>
      ${cardsHtml || `<div class="kb-vazio">${key === 'concluido' ? 'nada concluído nos últimos 14 dias' : 'nenhuma solicitação'}</div>`}
    </div>`;
  }).join('');
}
let _kbDrag = null;
function kbDragStart(ev, tipo, id) {
  _kbDrag = { tipo, id };
  ev.dataTransfer.effectAllowed = 'move';
  try { ev.dataTransfer.setData('text/plain', tipo + ':' + id); } catch (e) {}
  ev.currentTarget.classList.add('kb-drag');
}
function kbDragEnd(ev) {
  ev.currentTarget.classList.remove('kb-drag');
  document.querySelectorAll('#atd-sub-kanban .kb-col').forEach(c => c.classList.remove('kb-over'));
}
function kbAllowDrop(ev) { ev.preventDefault(); ev.currentTarget.classList.add('kb-over'); }
function kbLeave(ev) { ev.currentTarget.classList.remove('kb-over'); }
function kbDrop(ev, etapa) {
  ev.preventDefault();
  ev.currentTarget.classList.remove('kb-over');
  if (!_kbDrag) return;
  kbSetEtapa(_kbDrag.tipo, _kbDrag.id, etapa);
  _kbDrag = null;
}
function kbSetEtapa(tipo, id, etapa) {
  const { cfg, arr, salvar } = kbGet(tipo);
  const t = arr.find(x => x.id === id); if (!t) return;
  t.etapa = etapa;
  t.etapa_em = new Date().toISOString();
  if (tipo !== 'est') { // mantém o kanban e a lista de origem em acordo
    if (etapa === 'concluido' && t.status !== 'resolvido') { t.status = 'resolvido'; t.resolvido_em = new Date().toISOString(); }
    if (etapa !== 'concluido' && t.status === 'resolvido') { t.status = 'pendente'; t.resolvido_em = null; }
  }
  salvar(cfg);
  atdSyncViews();
}
// Sincroniza as 3 listas (SAC, Trocas, Devolução) + o quadro Kanban de uma vez. Todas leem o
// mesmo storage (vc:sac / vc:retorno / vc:estorno), então qualquer ação — resolver, mover
// etapa, marcar chegada, excluir — reflete na hora em TODAS as abas, esteja qual estiver visível.
function atdSyncViews() {
  try { if (document.getElementById('sac-tbody')) sacRender(); } catch (e) {}
  try { if (document.getElementById('ret-tbody')) retRender(); } catch (e) {}
  try { if (document.getElementById('atd-est-tbody')) estRender(); } catch (e) {}
  try { if (document.getElementById('kb-board')) kbRender(); } catch (e) {}
}

function finPopularMeses() {
  const sel = document.getElementById('fin-mes');
  if (sel.options.length) return;
  const nomes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const hoje = new Date();
  for (let i = 0; i < 8; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    const val = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const o = document.createElement('option');
    o.value = val; o.textContent = nomes[d.getMonth()] + '/' + d.getFullYear();
    sel.appendChild(o);
  }
  // padrão: mês ATUAL (primeira opção) — a saúde financeira abre sempre no mês corrente
}

function finBuildParams(cfg, custos) {
  const t = cfg.taxas || { credito: 4.8, pix: 0, dinheiro: 0 };
  const mes = document.getElementById('fin-mes').value;
  window._finSubs = finGetSubs(cfg, mes);
  const row = (id, label, val, suf) => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0">
    <label style="flex:1;font-size:13px;color:var(--text-sec)">${label}</label>
    <input id="${id}" type="number" step="0.01" value="${val}" oninput="finSalvarParam()" style="width:130px;text-align:right;padding:6px 8px;border:1px solid var(--border);border-radius:6px">
    <span style="font-size:12px;color:var(--text-ter);width:14px">${suf || ''}</span></div>`;
  const catRow = ([k, l]) => {
    const subs = window._finSubs[k] || [];
    const tem = subs.length > 0;
    const val = tem ? finSubsSum(subs).toFixed(2) : (custos[k] || 0);
    return `<div style="border-bottom:1px solid #f0ede8">
      <div style="display:flex;align-items:center;gap:6px;padding:4px 0">
        <button id="fin-chev-${k}" onclick="finToggleSub('${k}')" style="background:none;border:none;cursor:pointer;padding:2px;color:var(--text-ter);font-size:11px;width:18px;transition:transform 0.15s">▸</button>
        <label style="flex:1;font-size:13px;color:var(--text-sec);cursor:pointer" onclick="finToggleSub('${k}')">${l}${tem ? ` <span style="font-size:10px;color:var(--text-ter)">(${subs.length})</span>` : ''}</label>
        <input id="fin-c-${k}" type="number" step="0.01" value="${val}" ${tem ? 'readonly' : ''} oninput="finSalvarParam()" style="width:130px;text-align:right;padding:6px 8px;border:1px solid ${tem ? 'transparent' : 'var(--border)'};border-radius:6px;${tem ? 'background:transparent;font-weight:600;' : ''}">
        <span style="font-size:12px;color:var(--text-ter);width:14px">R$</span>
      </div>
      <div id="fin-sub-${k}" style="display:none;padding:2px 0 8px 24px">${finSubsHTML(k)}</div>
    </div>`;
  };
  document.getElementById('fin-params').innerHTML =
    `<div style="font-size:11px;font-weight:700;color:var(--text-ter);letter-spacing:0.05em;margin:2px 0 4px">TAXAS DE PAGAMENTO</div>` +
    row('fin-taxa-credito', 'Cartão de crédito', t.credito, '%') +
    row('fin-taxa-pix', 'Pix', t.pix, '%') +
    row('fin-taxa-dinheiro', 'Dinheiro / manual', t.dinheiro, '%') +
    `<div style="font-size:11px;font-weight:700;color:var(--text-ter);letter-spacing:0.05em;margin:12px 0 4px">CUSTOS DO MÊS</div>` +
    CUSTO_DEFS.map(catRow).join('');
}

function finSubsHTML(k) {
  const subs = window._finSubs[k] || [];
  return subs.map((s, i) => `<div style="display:flex;align-items:center;gap:6px;padding:2px 0">
      <input value="${String(s[0]).replace(/"/g, '&quot;')}" oninput="finSubEdit('${k}',${i},0,this.value)" style="flex:1;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px;color:var(--text-sec);min-width:0">
      <input type="number" step="0.01" value="${s[1]}" oninput="finSubEdit('${k}',${i},1,this.value)" style="width:104px;text-align:right;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px">
      <button onclick="finSubDel('${k}',${i})" title="Remover item" style="background:none;border:none;cursor:pointer;color:var(--text-ter);font-size:14px;width:18px;padding:0">×</button>
    </div>`).join('') +
    `<button onclick="finSubAdd('${k}')" style="background:none;border:1px dashed var(--border);border-radius:5px;cursor:pointer;color:var(--text-ter);font-size:11px;padding:3px 8px;margin-top:4px">+ adicionar item</button>`;
}

function finToggleSub(k) {
  const el = document.getElementById('fin-sub-' + k);
  const aberto = el.style.display !== 'none';
  el.style.display = aberto ? 'none' : '';
  document.getElementById('fin-chev-' + k).style.transform = aberto ? '' : 'rotate(90deg)';
}

function finSubRefresh(k) {
  document.getElementById('fin-sub-' + k).innerHTML = finSubsHTML(k);
  const inp = document.getElementById('fin-c-' + k);
  const subs = window._finSubs[k] || [];
  if (subs.length) {
    inp.value = finSubsSum(subs).toFixed(2);
    inp.readOnly = true;
    inp.style.border = '1px solid transparent'; inp.style.background = 'transparent'; inp.style.fontWeight = '600';
  } else {
    inp.readOnly = false;
    inp.style.border = '1px solid var(--border)'; inp.style.background = ''; inp.style.fontWeight = '';
  }
}

function finSubEdit(k, i, campo, val) {
  const s = (window._finSubs[k] || [])[i]; if (!s) return;
  s[campo] = campo === 1 ? (parseFloat(val) || 0) : val;
  if (campo === 1) document.getElementById('fin-c-' + k).value = finSubsSum(window._finSubs[k]).toFixed(2);
  finSalvarParam();
}

function finSubAdd(k) {
  window._finSubs[k] = window._finSubs[k] || [];
  window._finSubs[k].push(['Novo item', 0]);
  finSubRefresh(k);
  const el = document.getElementById('fin-sub-' + k);
  if (el.style.display === 'none') finToggleSub(k);
  finSalvarParam();
}

function finSubDel(k, i) {
  (window._finSubs[k] || []).splice(i, 1);
  finSubRefresh(k);
  finSalvarParam();
}

function finSalvarParam() {
  const cfg = finGetConfig();
  cfg.taxas = {
    credito: parseFloat(document.getElementById('fin-taxa-credito').value) || 0,
    pix: parseFloat(document.getElementById('fin-taxa-pix').value) || 0,
    dinheiro: parseFloat(document.getElementById('fin-taxa-dinheiro').value) || 0,
  };
  const mes = document.getElementById('fin-mes').value;
  const subs = window._finSubs || {};
  const c = {};
  CUSTO_DEFS.forEach(([k]) => {
    c[k] = (subs[k] && subs[k].length)
      ? Math.round(finSubsSum(subs[k]) * 100) / 100
      : (parseFloat(document.getElementById('fin-c-' + k).value) || 0);
  });
  cfg.meses = cfg.meses || {}; cfg.meses[mes] = c;
  cfg.subs = cfg.subs || {}; cfg.subs[mes] = subs;
  cfg.subsV = (cfg.subsV && typeof cfg.subsV === 'object') ? cfg.subsV : {};
  cfg.subsV[mes] = FIN_SUBS_VERSION;
  cfg.meta = (cfg.meta && typeof cfg.meta === 'object') ? cfg.meta : {};
  cfg.meta[mes] = Object.assign({}, cfg.meta[mes], { atualizado: new Date().toISOString() });
  cfg.updated_at = new Date().toISOString();
  saveLocal('vc:financeiro', cfg);
  clearTimeout(window._finSaveTimer);
  window._finSaveTimer = setTimeout(() => salvarNuvem('financeiro', cfg), 900);
  finRecompute();
  finUpdateStatus();
}

async function renderFinanceiro() {
  const mes = document.getElementById('fin-mes').value;
  const cfg = finGetConfig();
  const custos = (cfg.meses && cfg.meses[mes]) || finDefaults(mes);
  finBuildParams(cfg, custos);
  const load = document.getElementById('fin-loading');
  load.textContent = 'carregando Shopify…';
  try {
    const res = await fetch('/api/shopify-faturamento?mes=' + mes + '&t=' + Date.now());
    window._finFat = await res.json();
    load.textContent = '';
  } catch (e) {
    window._finFat = { vendas_totais: 0, por_gateway: {} };
    load.textContent = 'falha ao carregar Shopify';
  }
  await finPullMeta(mes);
  finRecompute();
  finUpdateStatus();
  mpRenderCard('fin-mp', mes); // conferência Mercado Pago (entradas/saídas reais do mês)
  finAplicarVendas(mes); // custo de produção das vendidas entra como despesa (tecido + facção)
}

// Puxa o gasto de tráfego do Meta (Marketing API) e mantém o subitem "Meta Ads (Facebook)" atualizado.
// Só atua no mês corrente (parcial); meses fechados mantêm o valor reconciliado pelo extrato.
async function finPullMeta(mes) {
  const hoje = new Date();
  const mesAtual = hoje.getFullYear() + '-' + String(hoje.getMonth() + 1).padStart(2, '0');
  if (mes !== mesAtual) return;
  try {
    const desde = mes + '-01';
    const ate = hoje.toISOString().slice(0, 10);
    const r = await fetch('/api/meta-insights?nivel=account&desde=' + desde + '&ate=' + ate + '&t=' + Date.now());
    const d = await r.json();
    const gasto = (d && d.total && typeof d.total.gasto === 'number') ? d.total.gasto : null;
    if (gasto == null) return;

    // Grava direto no mês "mes" (capturado no momento da chamada), nunca no mês
    // que estiver selecionado no dropdown no momento em que o fetch resolver —
    // evita salvar o gasto de um mês dentro de outro se o usuário trocar o mês
    // enquanto o fetch está em andamento.
    const cfgFin = finGetConfig();
    const subs = (cfgFin.subs && cfgFin.subs[mes]) ? cfgFin.subs[mes] : (finGetSubs(cfgFin, mes));
    subs.trafego = subs.trafego || [];
    const idx = subs.trafego.findIndex(s => /^meta ads/i.test(s[0]));
    if (idx >= 0) subs.trafego[idx][1] = gasto;
    else subs.trafego.unshift(['Meta Ads (Facebook)', gasto]);
    // Impostos sobre o gasto Meta (PIS/COFINS/ISS): não aparecem no gerenciador, mas saem
    // do caixa — taxa configurada na caixa de tráfego do Fluxo (padrão 12,15%).
    const _flxCfg = loadLocal('vc:fluxo_caixa');
    const pctImp = (_flxCfg && _flxCfg.trafegoCfg && typeof _flxCfg.trafegoCfg.impostoPct === 'number')
      ? _flxCfg.trafegoCfg.impostoPct : FLX_TRAFEGO_DEFAULT.impostoPct;
    const idxImp = subs.trafego.findIndex(s => /^impostos s\/ meta ads/i.test(s[0]));
    if (pctImp > 0) {
      const rotImp = 'Impostos s/ Meta Ads (' + String(pctImp).replace('.', ',') + '%)';
      const vImp = Math.round(gasto * pctImp) / 100;
      if (idxImp >= 0) { subs.trafego[idxImp][0] = rotImp; subs.trafego[idxImp][1] = vImp; }
      else subs.trafego.splice((idx >= 0 ? idx : 0) + 1, 0, [rotImp, vImp]);
    } else if (idxImp >= 0) {
      subs.trafego.splice(idxImp, 1);
    }
    cfgFin.subs = cfgFin.subs || {};
    cfgFin.subs[mes] = subs;
    cfgFin.subsV = cfgFin.subsV || {};
    cfgFin.subsV[mes] = FIN_SUBS_VERSION;
    cfgFin.meses = cfgFin.meses || {};
    cfgFin.meses[mes] = Object.assign({}, cfgFin.meses[mes], { trafego: Math.round(finSubsSum(subs.trafego) * 100) / 100 });
    cfgFin.meta = cfgFin.meta || {};
    cfgFin.meta[mes] = Object.assign({}, cfgFin.meta[mes], { atualizado: new Date().toISOString() });
    cfgFin.updated_at = new Date().toISOString();
    saveLocal('vc:financeiro', cfgFin);
    salvarNuvem('financeiro', cfgFin);

    // Só mexe na UI/estado em memória se o mês ainda em tela for o mesmo que acabou de ser atualizado.
    const mesNaTela = document.getElementById('fin-mes') && document.getElementById('fin-mes').value;
    if (mesNaTela === mes) {
      window._finSubs = window._finSubs || {};
      window._finSubs.trafego = subs.trafego;
      finSubRefresh('trafego');
      finRecompute();
      finUpdateStatus();
    }
  } catch (e) { /* token expirado / sem rede: mantém o valor atual */ }
}

// Selo "parcial / atualizado em" — mês corrente é parcial (acompanhamento semanal); meses passados são fechados
function finUpdateStatus() {
  const el = document.getElementById('fin-status'); if (!el) return;
  const mes = document.getElementById('fin-mes').value;
  const cfg = finGetConfig();
  const atual = (cfg.meta && cfg.meta[mes] && cfg.meta[mes].atualizado) || null;
  const hoje = new Date();
  const mesAtual = hoje.getFullYear() + '-' + String(hoje.getMonth() + 1).padStart(2, '0');
  const fmt = iso => { const d = new Date(iso); return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0'); };
  if (mes === mesAtual) {
    el.style.color = '#d97706';
    el.innerHTML = '<i class="ti ti-clock-pause"></i> Parcial' + (atual ? ' · atualizado em ' + fmt(atual) : ' · aguardando extrato');
  } else if (atual) {
    el.style.color = 'var(--text-ter)';
    el.innerHTML = '<i class="ti ti-circle-check"></i> Fechado · atualizado em ' + fmt(atual);
  } else {
    el.innerHTML = '';
  }
}

function finRecompute() {
  const fat = window._finFat; if (!fat) return;
  const credito = parseFloat(document.getElementById('fin-taxa-credito').value) || 0;
  const pix = parseFloat(document.getElementById('fin-taxa-pix').value) || 0;
  const dinheiro = parseFloat(document.getElementById('fin-taxa-dinheiro').value) || 0;
  let credT = 0, pixT = 0, dinT = 0;
  for (const [g, v] of Object.entries(fat.por_gateway || {})) {
    const tt = v.total || 0;
    if (/pix/i.test(g)) pixT += tt;
    else if (/manual|sem_gateway/i.test(g)) dinT += tt;
    else credT += tt;
  }
  const taxas = credT * credito / 100 + pixT * pix / 100 + dinT * dinheiro / 100;
  const vendas = fat.vendas_totais || 0;
  const receitaLiq = vendas - taxas;
  const custos = {}; let custoTotal = 0, retirada = 0;
  CUSTO_DEFS.forEach(([k]) => {
    const v = parseFloat(document.getElementById('fin-c-' + k).value) || 0;
    custos[k] = v;
    if (k === 'retirada') retirada = v; else custoTotal += v;
  });
  const resOp = receitaLiq - custoTotal;
  const resultado = resOp - retirada;
  const corR = r => r >= 0 ? '#16a34a' : '#dc2626';

  document.getElementById('fin-metrics').innerHTML = `
    <div class="metric"><div class="label">VENDAS TOTAIS</div><div class="val val-areia" style="font-size:17px">${finBRL(vendas)}</div></div>
    <div class="metric"><div class="label">RECEITA LÍQUIDA</div><div class="val" style="font-size:17px">${finBRL(receitaLiq)}</div></div>
    <div class="metric"><div class="label">CUSTOS</div><div class="val val-escuro" style="font-size:17px">${finBRL(custoTotal)}</div></div>
    <div class="metric"><div class="label">RESULTADO</div><div class="val" style="font-size:17px;color:${corR(resultado)}">${finBRL(resultado)}</div></div>`;

  const lin = (lbl, val, o = {}) => `<tr style="${o.strong ? 'font-weight:700;' : ''}border-top:${o.top ? '1px solid var(--border)' : 'none'}">
    <td style="padding:6px 8px">${lbl}</td>
    <td style="text-align:right;padding:6px 8px;${o.color ? 'color:' + o.color : ''}">${o.neg ? '− ' : ''}${finBRL(val)}</td></tr>`;
  document.getElementById('fin-dre').innerHTML = `<table style="width:100%;font-size:13px">
    ${lin('Vendas totais (Shopify)', vendas, { strong: true })}
    ${lin('(−) Taxas de pagamento', taxas, { neg: true })}
    ${lin('= Receita líquida', receitaLiq, { strong: true, top: true })}
    ${lin('(−) Custos operacionais', custoTotal, { neg: true })}
    ${lin('= Resultado operacional', resOp, { strong: true, top: true, color: corR(resOp) })}
    ${lin('(−) Retirada de sócio', retirada, { neg: true })}
    ${lin('= Resultado do mês', resultado, { strong: true, top: true, color: corR(resultado) })}
  </table>`;

  const itens = CUSTO_DEFS.filter(([k]) => k !== 'retirada').map(([k, l, cor]) => [l, custos[k], cor, k]).filter(i => i[1] > 0).sort((a, b) => b[1] - a[1]);
  const maxv = Math.max(...itens.map(i => i[1]), 1);
  const chartRow = i => {
    const subs = (window._finSubs && window._finSubs[i[3]]) || [];
    const det = subs.length
      ? subs.slice().sort((a, b) => (parseFloat(b[1]) || 0) - (parseFloat(a[1]) || 0)).map(sub => `
          <div style="display:flex;justify-content:space-between;gap:8px;padding:2px 0;font-size:12px;color:var(--text-sec)">
            <span>${String(sub[0])}</span><span style="white-space:nowrap">${finBRL(parseFloat(sub[1]) || 0)}</span>
          </div>`).join('')
      : '<div style="font-size:11px;color:var(--text-ter);padding:2px 0">valor lançado direto (sem subitens) — detalhe nos Parâmetros abaixo</div>';
    return `
    <div onclick="finChartToggle('${i[3]}')" title="clique para ver os custos detalhados" style="display:flex;align-items:center;gap:8px;margin:5px 0;font-size:12px;cursor:pointer">
      <span id="fin-chart-chev-${i[3]}" style="width:10px;color:var(--text-ter);font-size:10px;transition:transform 0.15s">▸</span>
      <span style="width:130px;color:var(--text-sec)">${i[0]}${subs.length ? ` <span style=\"font-size:10px;color:var(--text-ter)\">(${subs.length})</span>` : ''}</span>
      <div style="flex:1;background:#f0ede8;border-radius:4px;height:16px;overflow:hidden"><div style="height:100%;width:${Math.round(i[1] / maxv * 100)}%;background:${i[2]}"></div></div>
      <span style="width:95px;text-align:right;font-weight:600">${finBRL(i[1])}</span>
      <span style="width:42px;text-align:right;color:var(--text-ter)">${vendas ? Math.round(i[1] / vendas * 100) : 0}%</span>
    </div>
    <div id="fin-chart-det-${i[3]}" style="display:none;margin:0 0 8px 18px;padding:6px 10px;border-left:2px solid ${i[2]};background:rgba(0,0,0,0.02);border-radius:0 6px 6px 0">${det}</div>`;
  };
  const totalChart = itens.reduce((s, i) => s + i[1], 0);
  const linhaTotal = itens.length ? `
    <div style="display:flex;align-items:center;gap:8px;margin:8px 0 0;padding-top:8px;border-top:2px solid var(--border);font-size:13px;font-weight:700">
      <span style="width:10px"></span>
      <span style="width:130px">Total de custos</span>
      <div style="flex:1"></div>
      <span style="width:95px;text-align:right">${finBRL(totalChart)}</span>
      <span style="width:42px;text-align:right;color:var(--text-ter);font-weight:400">${vendas ? Math.round(totalChart / vendas * 100) : 0}%</span>
    </div>` : '';
  document.getElementById('fin-chart').innerHTML = (itens.map(chartRow).join('') + linhaTotal) || '<div style="font-size:12px;color:var(--text-ter);padding:8px 0">Preencha os custos do mês abaixo para ver a composição.</div>';
}

// Expande/recolhe os custos detalhados de uma categoria na Composição de Custos
function finChartToggle(k) {
  const el = document.getElementById('fin-chart-det-' + k); if (!el) return;
  const aberto = el.style.display !== 'none';
  el.style.display = aberto ? 'none' : '';
  const chev = document.getElementById('fin-chart-chev-' + k);
  if (chev) chev.style.transform = aberto ? '' : 'rotate(90deg)';
}

// ─── ABA FLUXO DE CAIXA (visão prospectiva de solvência) ─────────────────────
// Pergunta que responde: "com o dinheiro que já tenho nas contas, quanto aguento
// pagar dos compromissos que vencem no mês, sem contar vendas novas?"
// Saldos: Stone manual + MP/Pagar.me via API. Pagamentos: recorrentes semeados + pontuais.
// SEM projeção de entradas futuras (visão conservadora escolhida em 2026-07-05).

// Config padrão do tráfego (Meta cobra por LIMITE de faturamento, não valor fechado no fim do mês).
// impostoPct: a Meta Brasil cobra impostos POR CIMA do gasto do gerenciador (PIS 1,65% +
// COFINS 7,6% + ISS ~2,9% ≈ 12,15%). Não aparecem no gerenciador, mas saem do caixa —
// as provisões e o DRE precisam incluí-los. Ajustável na caixa de tráfego do Fluxo.
const FLX_TRAFEGO_DEFAULT = { estimativa: 39000, limite: 3000, impostoPct: 12.15 };

function flxDiasNoMes(mes) {
  const [Y, M] = mes.split('-').map(Number);
  return new Date(Y, M, 0).getDate();
}

// Tráfego é FRACIONADO: a Meta debita quando o GASTO DO GERENCIADOR acumulado bate o
// limite (ex.: R$3.000) — mas a COBRANÇA REAL sai com impostos por cima (limite × (1+imposto)).
// `estimativa` e `limite` são em valores do gerenciador (sem imposto); as provisões saem em
// valor de caixa (com imposto) — mesma unidade das cobranças reais do extrato MP.
function flxTrafegoCharges(estimativa, limite, diasNoMes, impostoPct) {
  estimativa = parseFloat(estimativa) || 0;
  limite = parseFloat(limite) || 3000;
  const fator = 1 + ((parseFloat(impostoPct) || 0) / 100);
  const out = [];
  if (estimativa <= 0 || limite <= 0) return out;
  const diario = estimativa / diasNoMes;
  const n = Math.floor(estimativa / limite);
  const resto = Math.round((estimativa - n * limite) * 100) / 100;
  const rotuloLim = limite.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sufImposto = fator > 1 ? ' + impostos' : '';
  for (let k = 1; k <= n; k++) {
    const dia = Math.min(diasNoMes, Math.max(1, Math.ceil(k * limite / diario)));
    out.push({ id: 'trf' + k, desc: 'Meta Ads — cobrança ' + k + ' (R$ ' + rotuloLim + sufImposto + ')', valor: Math.round(limite * fator * 100) / 100, dia, cat: 'trafego', rec: true, pago: false });
  }
  if (resto > 0) out.push({ id: 'trf' + (n + 1), desc: 'Meta Ads — saldo do mês' + sufImposto, valor: Math.round(resto * fator * 100) / 100, dia: diasNoMes, cat: 'trafego', rec: true, pago: false });
  return out;
}

// Template de contas recorrentes por mês. Fixos previsíveis vêm com valor real;
// variáveis (tecido/facção/logística) vêm como placeholder p/ a Bárbara ajustar.
// Tráfego é gerado fracionado (flxTrafegoCharges). cat = taxonomia do DRE (CUSTO_DEFS).
function flxRecorrentesTemplate(mes, trafegoCfg, vendasAuto) {
  let base = [
    ['Salário — Marcelly',           2065.00, 5,  'salarios'],
    ['Salário — Emanuela',           2065.00, 5,  'salarios'],
    ['Eunice (limpeza)',              900.00, 5,  'fixos'],
    ['Shopify',                      1817.00, 8,  'fixos'],
    ['Amil (plano de saúde)',        1000.00, 10, 'fixos'],
    ['Confseg (contabilidade)',       760.00, 10, 'fixos'],
    ['Letícia (advocacia)',           450.00, 10, 'fixos'],
    ['LWSA (hospedagem)',             240.00, 10, 'fixos'],
    ['Celesc (energia)',             1124.00, 15, 'fixos'],
    ['Tecido — Costa Rica Malhas (ajustar valor/dia)', 11000.00, 10, 'tecido'],
    ['Facção — Maria Elizete e cia (ajustar valor/dia)', 15000.00, 15, 'faccao'],
    ['Logística — L4B + Correios (ajustar valor/dia)',  8000.00, 20, 'logistica'],
  ];
  // Com vendas Shopify ligadas, tecido/facção/logística das vendidas entram automáticos → sem placeholder manual
  if (vendasAuto) base = base.filter(r => !['tecido', 'faccao', 'logistica'].includes(r[3]));
  const fixas = base.map((r, i) => ({ id: 'rec' + i, desc: r[0], valor: r[1], dia: r[2], cat: r[3], rec: true, pago: false }));
  const tc = trafegoCfg || FLX_TRAFEGO_DEFAULT;
  const dias = flxDiasNoMes(mes || (new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0')));
  return fixas.concat(flxTrafegoCharges(tc.estimativa, tc.limite, dias, tc.impostoPct));
}

function flxCatNome(k) {
  const d = CUSTO_DEFS.find(c => c[0] === k);
  return d ? d[1] : k;
}
function flxCatCor(k) {
  const d = CUSTO_DEFS.find(c => c[0] === k);
  return d ? d[2] : '#6b7280';
}

function flxGetConfig() {
  const cfg = loadLocal('vc:fluxo_caixa') || {
    saldos: { stone: { v: 0, at: null }, mp: { v: 0, at: null }, pagarme: { v: 0, at: null } },
    pag: {}, updated_at: null
  };
  if (!cfg.trafegoCfg) cfg.trafegoCfg = Object.assign({}, FLX_TRAFEGO_DEFAULT);
  if (cfg.trafegoCfg.impostoPct === undefined) cfg.trafegoCfg.impostoPct = FLX_TRAFEGO_DEFAULT.impostoPct;
  if (cfg.vendasAuto === undefined) cfg.vendasAuto = true; // custo das vendidas puxado da Shopify
  if (!cfg.ignorados || typeof cfg.ignorados !== 'object') cfg.ignorados = {}; // ids removidos pelo × (não voltam nos syncs)
  if (!cfg.rotulos || typeof cfg.rotulos !== 'object') cfg.rotulos = {}; // identificação manual por source_id (✎) — aplicada em todo lugar
  if (!cfg.vendasIncluir) cfg.vendasIncluir = { tecido: true, corte: true, costura: true, frete: true };
  return cfg;
}

// Garante que o mês tenha lista de pagamentos (semeia recorrentes na 1ª vez).
function flxSeedMes(cfg, mes) {
  cfg.pag = cfg.pag || {};
  if (!cfg.pag[mes]) cfg.pag[mes] = flxRecorrentesTemplate(mes, cfg.trafegoCfg, cfg.vendasAuto);
  return cfg.pag[mes];
}

function flxSaldoTotal(cfg) {
  const s = cfg.saldos || {};
  return (s.stone?.v || 0) + (s.mp?.v || 0) + (s.pagarme?.v || 0);
}

function flxPopularMeses() {
  const sel = document.getElementById('flx-mes');
  if (!sel || sel.options.length) return;
  const nomes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const hoje = new Date();
  // 1 mês atrás → 2 meses à frente (fluxo é sobre agora e o que vem)
  for (let i = -1; i <= 2; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() + i, 1);
    const val = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const o = document.createElement('option');
    o.value = val; o.textContent = nomes[d.getMonth()] + '/' + d.getFullYear();
    sel.appendChild(o);
  }
  const mesAtual = hoje.getFullYear() + '-' + String(hoje.getMonth() + 1).padStart(2, '0');
  sel.value = mesAtual;
}

function abrirFluxo(item) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (item) item.classList.add('active');
  if (!['__dashboard__', '__financeiro__', '__precos__', '__trafego__', '__fluxo__', '__atendimento__'].includes(modeloAtual) && (estEditado || prodEditado || cfgEditado)) {
    clearTimeout(saveTimer); salvarModelo();
  }
  estEditado = false; prodEditado = false; cfgEditado = false; esconderBtnSalvar();
  modeloAtual = '__fluxo__';
  location.hash = 'fluxo';
  document.getElementById('model-title').innerHTML = '<span style="font-family:\'Bebas Neue\',\'Arial Narrow\',sans-serif;font-weight:400;font-size:26px;letter-spacing:0.1em">FLUXO DE CAIXA</span>';
  document.getElementById('model-sub').textContent = '';
  document.getElementById('topbar-actions').style.display = 'none';
  document.getElementById('tabs-modelo').style.display = 'none';
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-fluxo').classList.add('active');
  document.body.classList.remove('precos-mode');
  flxPopularMeses();
  const ok = sessionStorage.getItem('fin-ok') === '1';
  document.getElementById('flx-gate').style.display = ok ? 'none' : '';
  document.getElementById('flx-content').style.display = ok ? '' : 'none';
  if (ok) renderFluxo(); else setTimeout(() => document.getElementById('flx-senha')?.focus(), 60);
  closeSidebar();
}

async function flxUnlock() {
  const v = document.getElementById('flx-senha').value;
  if (await conferirSenha(v) === 'dona') {
    sessionStorage.setItem('fin-ok', '1');
    document.getElementById('flx-erro').textContent = '';
    document.getElementById('flx-senha').value = '';
    document.getElementById('flx-gate').style.display = 'none';
    document.getElementById('flx-content').style.display = '';
    renderFluxo();
  } else {
    document.getElementById('flx-erro').textContent = 'Senha incorreta';
  }
}
function flxLock() {
  sessionStorage.removeItem('fin-ok');
  document.getElementById('flx-gate').style.display = '';
  document.getElementById('flx-content').style.display = 'none';
}

async function renderFluxo() {
  const cfg = flxGetConfig();
  const mes = document.getElementById('flx-mes').value;
  flxSeedMes(cfg, mes);
  saveLocal('vc:fluxo_caixa', cfg);
  flxRenderSaldos(cfg);
  flxRenderPagamentos(cfg, mes);
  flxProjFormInit(mes);
  flxRecompute();
  // Em background (não bloqueiam a UI; falha → mantém manual/placeholder):
  flxAtualizarSaldos(true);              // saldos MP/Pagar.me
  if (cfg.vendasAuto) flxSincronizarVendas(true); // custo das vendidas Shopify
  mpRenderCard('flx-mp', mes);           // movimentações reais do Mercado Pago
  flxAtualizarMetaSaldo(mes);            // saldo devedor real da Meta (cache 6h)
  flxIniciarPollSaldos();                // quase-tempo-real: saldo re-puxado a cada 3 min com a aba aberta
}

// ── Mercado Pago — movimentações REAIS da conta (entradas Pix, pagamentos, transferências) ──
// Fonte: /api/mp-movimentos (release_report da API MP). Usado no Fluxo (flx-mp) e no Financeiro (fin-mp).
async function mpRenderCard(elId, mes) {
  const el = document.getElementById(elId); if (!el) return;
  const [Y, M] = mes.split('-').map(Number);
  const desde = mes + '-01';
  const hoje = new Date();
  const ehMesAtual = (Y === hoje.getFullYear() && M === hoje.getMonth() + 1);
  const ate = ehMesAtual ? hoje.toISOString().slice(0, 10) : mes + '-' + String(new Date(Y, M, 0).getDate()).padStart(2, '0');
  el.innerHTML = '<div style="font-size:12px;color:var(--text-ter);padding:6px 0">carregando Mercado Pago…</div>';
  try {
    const r = await fetch('/api/mp-movimentos?desde=' + desde + '&ate=' + ate + '&t=' + Date.now());
    const j = await r.json();
    if (!r.ok || j.erro) { el.innerHTML = '<div style="font-size:12px;color:var(--text-ter)">MP indisponível: ' + (j.erro || r.status) + '</div>'; return; }
    if (j.gerando && !window._mpCardRetry) {
      window._mpCardRetry = setTimeout(() => { window._mpCardRetry = null; const el2 = document.getElementById(elId); if (el2) mpRenderCard(elId, mes); }, 150000);
    }
    // no Fluxo, os pagamentos reais feitos pelo MP entram sozinhos na tabela de contas (como pagos)
    if (elId === 'flx-mp') {
      window._flxMP = { mes, dados: j };
      flxAplicarSaidasMP(j, mes);
      if (modeloAtual === '__fluxo__' && document.getElementById('flx-mes').value === mes) flxRecompute();
    }
    if (elId === 'fin-mp') finAplicarMP(j, mes); // DRE do mês corrente importa os pagamentos reais do MP
    const ddmm = iso => String(iso || '').slice(8, 10) + '/' + String(iso || '').slice(5, 7);
    const detHTML = (itens, sinal) => (itens && itens.length)
      ? itens.slice().sort((a, b) => String(a.dia).localeCompare(String(b.dia))).map(t => {
          const rot = flxRotulo(t.source_id);
          const nome = rot || t.descricao || t.origem || '';
          return `
          <div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--text-sec);padding:1px 0;align-items:center">
            <span>${nome ? nome + ' · ' : ''}${ddmm(t.dia)}${t.hora ? ' ' + t.hora : ''}${t.autorizado ? ' (em liquidação)' : ''}${rot ? '' : ''}</span>
            <span style="white-space:nowrap;${sinal === '+' ? 'color:#16a34a' : ''}">${sinal === '+' ? '+' : '−'} ${finBRL(t.valor || 0)}
              ${t.source_id ? `<button onclick="flxRotular('${t.source_id}','${mes}')" title="identificar/renomear este movimento" style="background:none;border:none;cursor:pointer;color:var(--text-ter);font-size:11px;padding:0 0 0 3px">✎</button>` : ''}</span></div>`;
        }).join('')
      : '<div style="font-size:11px;color:var(--text-ter)">sem itens no período</div>';
    const linha = (lbl, val, cor, detId, detConteudo) => {
      const clic = detId ? ` onclick="(function(x){x.style.display=x.style.display==='none'?'':'none'})(document.getElementById('${detId}'))" style="cursor:pointer"` : '';
      return `<div${detId ? clic : ''}>
        <div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #f0ede8;font-size:13px${detId ? ';cursor:pointer' : ''}">
          <span style="color:var(--text-sec)">${detId ? '<span style=\"font-size:9px;color:var(--text-ter)\">▸</span> ' : ''}${lbl}</span>
          <span style="font-weight:600;color:${cor || 'inherit'}">${val}</span></div>
        ${detId ? `<div id="${detId}" style="display:none;margin:2px 0 6px 12px;padding:4px 8px;border-left:2px solid var(--border)">${detConteudo}</div>` : ''}
      </div>`;
    };
    const s = j.saidas || {};
    const tEnv = s.transferencias?.enviadas, tInt = s.transferencias?.internas;
    const tItens = (s.transferencias && s.transferencias.itens) || [];
    const entPorDia = (j.entradas && j.entradas.itens && j.entradas.itens.length)
      ? j.entradas.itens.map(t => ({ dia: t.dia, valor: t.valor, descricao: 'recebido' + (t.hora ? ' ' + t.hora : '') }))
      : Object.entries((j.entradas && j.entradas.por_dia) || {}).sort().map(([dia, v]) => ({ dia, valor: v }));
    el.innerHTML =
      linha('Entradas (recebimentos líquidos)', finBRL(j.entradas?.total_liquido || 0) + ' · ' + (j.entradas?.qtd || 0) + 'x', '#16a34a',
        elId + '-det-ent', detHTML(entPorDia, '+')) +
      linha('Pagamentos feitos pela conta', s.pagamentos?.total == null ? '—' : ('− ' + finBRL(s.pagamentos.total) + ' · ' + s.pagamentos.qtd + 'x'), '#b45309',
        elId + '-det-pag', detHTML(s.pagamentos?.itens)) +
      linha('Pix/transferências enviadas', tEnv == null ? '—' : ('− ' + finBRL(tEnv)), '#b45309',
        elId + '-det-env', detHTML(tItens.filter(t => !t.provavel_interna))) +
      linha('Varredura p/ banco próprio (interna)', tInt == null ? '—' : ('− ' + finBRL(tInt)), 'var(--text-ter)',
        elId + '-det-int', detHTML(tItens.filter(t => t.provavel_interna))) +
      (j.saldo_final != null ? linha('Saldo na conta (fim do extrato)', finBRL(j.saldo_final), 'var(--gold-dark)') : '') +
      `<div style="font-size:10px;color:var(--text-ter);margin-top:6px">${j.gerando ? '⏳ extrato completo sendo gerado (~2 min) — atualize em instantes' : 'extrato até ' + String(ate).split('-').reverse().slice(0, 2).join('/')} · fonte: ${j.fonte === 'release_report' ? 'extrato MP' : 'pagamentos (parcial)'}</div>`;
  } catch (e) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-ter)">falha ao consultar o Mercado Pago</div>';
  }
}

// Importa os pagamentos REAIS do MP para o DRE (subcategorias) do MÊS CORRENTE — assim a
// "Composição de custos" reflete o que de fato saiu das contas.
// Regras: (1) só mês corrente (mês fechado = reconciliação manual pelo extrato, não tocamos);
// (2) pagamentos ao Facebook/Meta ficam FORA (o gasto Meta do mês já entra inteiro via
//     /api/meta-insights no subitem "Meta Ads (Facebook)" — importar de novo duplicaria);
// (3) itens marcados "· MP auto" são substituídos a cada sync (idempotente) — os manuais ficam.
function finAplicarMP(j, mes) {
  const hoje = new Date();
  const mesAtual = hoje.getFullYear() + '-' + String(hoje.getMonth() + 1).padStart(2, '0');
  if (mes !== mesAtual) return;
  const pag = j && j.saidas && j.saidas.pagamentos;
  if (!pag || !Array.isArray(pag.itens)) return;
  const TAG = ' · MP auto';
  const catDe = d => {
    const t = (d || '').toLowerCase();
    if (/facebk|facebook|meta ads/.test(t)) return null; // coberto pelo gasto Meta via API
    if (/anthropic|wati|apple|claro|google|adobe|microsoft|manus|shopify|certifica/.test(t)) return 'fixos';
    if (/etiqueta|frete|loggi|correios|l4b|transporte/.test(t)) return 'logistica';
    return 'outros';
  };
  const cfg = finGetConfig();
  const subs = (cfg.subs && cfg.subs[mes]) ? cfg.subs[mes] : finGetSubs(cfg, mes);
  Object.keys(subs).forEach(k => { subs[k] = (subs[k] || []).filter(i => !String(i[0]).endsWith(TAG)); });
  let mudou = false;
  for (const it of pag.itens) {
    const c = catDe(it.descricao);
    if (!c || !(it.valor > 0)) continue;
    subs[c] = subs[c] || [];
    subs[c].push([(it.descricao || 'Pagamento via MP') + TAG, Math.round(it.valor * 100) / 100]);
    mudou = true;
  }
  const envItens = ((j.saidas.transferencias && j.saidas.transferencias.itens) || [])
    .filter(t => !t.provavel_interna && t.valor > 0 && t.dia && t.dia.startsWith(mes));
  if (envItens.length) {
    subs.outros = subs.outros || [];
    for (const t of envItens) {
      subs.outros.push(['Pix enviado ' + t.dia.slice(8, 10) + '/' + t.dia.slice(5, 7) + ' (destino a classificar)' + TAG, Math.round(t.valor * 100) / 100]);
    }
    mudou = true;
  } else {
    // fallback: só o total disponível (extrato sem itens) — agrega
    const env = j.saidas.transferencias && j.saidas.transferencias.enviadas;
    if (env > 0) { subs.outros = subs.outros || []; subs.outros.push(['Pix/transferências enviadas via MP (classificar)' + TAG, Math.round(env * 100) / 100]); mudou = true; }
  }
  if (!mudou && !Object.values(subs).some(a => (a || []).length)) return;
  cfg.subs = cfg.subs || {}; cfg.subs[mes] = subs;
  cfg.subsV = (cfg.subsV && typeof cfg.subsV === 'object') ? cfg.subsV : {}; cfg.subsV[mes] = FIN_SUBS_VERSION;
  cfg.meses = cfg.meses || {};
  const c2 = {};
  CUSTO_DEFS.forEach(([k]) => {
    c2[k] = (subs[k] && subs[k].length) ? Math.round(finSubsSum(subs[k]) * 100) / 100 : ((cfg.meses[mes] || {})[k] || 0);
  });
  cfg.meses[mes] = Object.assign({}, cfg.meses[mes], c2);
  cfg.meta = (cfg.meta && typeof cfg.meta === 'object') ? cfg.meta : {};
  cfg.meta[mes] = Object.assign({}, cfg.meta[mes], { atualizado: new Date().toISOString() });
  cfg.updated_at = new Date().toISOString();
  saveLocal('vc:financeiro', cfg);
  salvarNuvem('financeiro', cfg);
  if (modeloAtual === '__financeiro__' && document.getElementById('fin-mes') && document.getElementById('fin-mes').value === mes) {
    finBuildParams(cfg, cfg.meses[mes]);
    finRecompute();
    finUpdateStatus();
  }
}

// Importa o CUSTO DE PRODUÇÃO das peças vendidas (Shopify × Precificação) como despesa
// do DRE no MÊS CORRENTE: subitens '· vendas auto' em Tecido e Corte&Costura.
// Frete NÃO entra aqui — o frete real já chega via pagamentos do extrato (ex.: etiquetafrete
// · MP auto em Logística); somar o frete do pedido junto contaria em dobro.
async function finAplicarVendas(mes) {
  const hoje = new Date();
  const mesAtual = hoje.getFullYear() + '-' + String(hoje.getMonth() + 1).padStart(2, '0');
  if (mes !== mesAtual) return; // mês fechado = reconciliação manual
  const vendas = await flxCarregarVendas(mes);
  if (!vendas) return;
  const cfgFlx = flxGetConfig();
  const { pagamentos } = flxVendasParaPagamentos(vendas, cfgFlx.vendasIncluir);
  const soma = cat => Math.round(pagamentos.filter(p => p.cat === cat).reduce((s, p) => s + (p.valor || 0), 0) * 100) / 100;
  const tec = soma('tecido'), fac = soma('faccao');
  const TAG = ' · vendas auto';
  const cfg = finGetConfig();
  const subs = (cfg.subs && cfg.subs[mes]) ? cfg.subs[mes] : finGetSubs(cfg, mes);
  ['tecido', 'faccao'].forEach(k => { subs[k] = (subs[k] || []).filter(i => !String(i[0]).endsWith(TAG)); });
  if (tec > 0) { subs.tecido = subs.tecido || []; subs.tecido.push(['Tecido das peças vendidas (Shopify × Precificação)' + TAG, tec]); }
  if (fac > 0) { subs.faccao = subs.faccao || []; subs.faccao.push(['Corte+costura das peças vendidas (Shopify × Precificação)' + TAG, fac]); }
  if (!(tec > 0) && !(fac > 0)) return;
  cfg.subs = cfg.subs || {}; cfg.subs[mes] = subs;
  cfg.subsV = (cfg.subsV && typeof cfg.subsV === 'object') ? cfg.subsV : {}; cfg.subsV[mes] = FIN_SUBS_VERSION;
  cfg.meses = cfg.meses || {};
  const c2 = {};
  CUSTO_DEFS.forEach(([k]) => {
    c2[k] = (subs[k] && subs[k].length) ? Math.round(finSubsSum(subs[k]) * 100) / 100 : ((cfg.meses[mes] || {})[k] || 0);
  });
  cfg.meses[mes] = Object.assign({}, cfg.meses[mes], c2);
  cfg.meta = (cfg.meta && typeof cfg.meta === 'object') ? cfg.meta : {};
  cfg.meta[mes] = Object.assign({}, cfg.meta[mes], { atualizado: new Date().toISOString() });
  cfg.updated_at = new Date().toISOString();
  saveLocal('vc:financeiro', cfg);
  salvarNuvem('financeiro', cfg);
  if (modeloAtual === '__financeiro__' && document.getElementById('fin-mes') && document.getElementById('fin-mes').value === mes) {
    finBuildParams(cfg, cfg.meses[mes]);
    finRecompute();
    finUpdateStatus();
  }
}

// Gera as cobranças provisionadas de tráfego do mês JÁ ABATENDO o que a Meta cobrou de verdade
// (pagamentos reais via MP categorizados como 'trafego'). Consome as provisões em ordem de dia:
// remove inteiras enquanto couber e apara a próxima pelo resto — provisão restante = estimativa − real.
// Determinística (recalculável a cada sync, sem consumir duas vezes).
function flxTrafegoLiquido(cfg, mes) {
  const _ign = flxIgnorados(cfg, mes);
  const _filtra = arr => arr.filter(p => !_ign.has(p.id));
  const tc = cfg.trafegoCfg || FLX_TRAFEGO_DEFAULT;
  const hoje = new Date();
  const mesAtual = hoje.getFullYear() + '-' + String(hoje.getMonth() + 1).padStart(2, '0');

  // MÊS CORRENTE: nada de estimativa — entra o SALDO DEVEDOR REAL da conta Meta
  // (API /api/meta-conta-status, cache 6h em cfg.metaSaldo) + impostos. É o que a Meta
  // vai cobrar de fato; quando ela cobra (aparece o pagamento no MP), o saldo da API
  // cai junto — a reconciliação é automática, sem risco de dupla contagem.
  if (mes === mesAtual && cfg.metaSaldo && typeof cfg.metaSaldo.v === 'number') {
    if (cfg.metaSaldo.v <= 0) return [];
    const fator = 1 + ((parseFloat(tc.impostoPct) || 0) / 100);
    const at = cfg.metaSaldo.at ? new Date(cfg.metaSaldo.at) : null;
    const selo = at ? ' (API ' + String(at.getDate()).padStart(2, '0') + '/' + String(at.getMonth() + 1).padStart(2, '0') + ' ' + String(at.getHours()).padStart(2, '0') + 'h)' : '';
    return _filtra([{
      id: 'trfsaldo',
      desc: 'Meta Ads — saldo devedor atual + impostos' + selo,
      valor: Math.round(cfg.metaSaldo.v * fator * 100) / 100,
      dia: hoje.getDate(), cat: 'trafego', rec: true, pago: false
    }]);
  }

  // MESES FUTUROS (planejamento) ou fallback sem dado da API: cronograma estimado,
  // abatendo o que a Meta já cobrou de verdade no mês (pagamentos MP cat trafego).
  const gerados = flxTrafegoCharges(tc.estimativa, tc.limite, flxDiasNoMes(mes), tc.impostoPct);
  let real = ((cfg.pag && cfg.pag[mes]) || [])
    .filter(p => p.auto === 'mp' && p.cat === 'trafego')
    .reduce((s, p) => s + (p.valor || 0), 0);
  if (real <= 0) return _filtra(gerados);
  const out = [];
  for (const g of gerados) {
    if (real <= 0.005) { out.push(g); continue; }
    if (g.valor <= real + 0.005) { real -= g.valor; continue; } // provisão inteira consumida pela cobrança real
    out.push(Object.assign({}, g, {
      valor: Math.round((g.valor - real) * 100) / 100,
      desc: g.desc + ' (abatido o já cobrado)'
    }));
    real = 0;
  }
  return _filtra(out);
}

// Atualiza o saldo devedor da conta Meta (cache de 6h) e regenera o item de tráfego do mês corrente.
async function flxAtualizarMetaSaldo(mes, forcar) {
  const hoje = new Date();
  const mesAtual = hoje.getFullYear() + '-' + String(hoje.getMonth() + 1).padStart(2, '0');
  if (mes !== mesAtual) return;
  let cfg = flxGetConfig();
  const at = (cfg.metaSaldo && cfg.metaSaldo.at) ? new Date(cfg.metaSaldo.at).getTime() : 0;
  const fresco = (Date.now() - at) < 6 * 3600 * 1000;
  if (!fresco || forcar) {
    try {
      const r = await fetch('/api/meta-conta-status?t=' + Date.now());
      const d = await r.json();
      const bal = parseFloat(d && d.balance);
      if (!isNaN(bal)) {
        cfg = flxGetConfig(); // recarrega (outros syncs podem ter salvo nesse meio-tempo)
        cfg.metaSaldo = { v: Math.round(bal) / 100, at: new Date().toISOString() };
        saveLocal('vc:fluxo_caixa', cfg);
      }
    } catch (e) { /* API indisponível → mantém cache/estimativas */ }
  }
  // regenera o item de tráfego do mês corrente com o saldo (cache ou recém-buscado)
  cfg = flxGetConfig();
  if (!(cfg.metaSaldo && typeof cfg.metaSaldo.v === 'number')) return;
  cfg.pag = cfg.pag || {}; cfg.pag[mes] = cfg.pag[mes] || [];
  const outras = cfg.pag[mes].filter(p => !(p.cat === 'trafego' && p.rec && p.auto !== 'mp'));
  cfg.pag[mes] = outras.concat(flxTrafegoLiquido(cfg, mes));
  flxSalvarPag(cfg);
  if (modeloAtual === '__fluxo__' && document.getElementById('flx-mes') && document.getElementById('flx-mes').value === mes) {
    flxRenderPagamentos(cfg, mes);
    flxRecompute();
  }
}

// Injeta os PAGAMENTOS REAIS feitos pela conta MP na tabela de contas do mês (auto:'mp', já pagos).
// Cobranças da Meta (Facebk*/Facebook) entram como cat 'trafego' e CONSOMEM as provisionadas.
// Anti-duplicação: pula se já existe conta manual no mesmo dia com o mesmo valor (±1%).
function flxAplicarSaidasMP(j, mes) {
  const pagtos = j && j.saidas && j.saidas.pagamentos && Array.isArray(j.saidas.pagamentos.itens) ? j.saidas.pagamentos.itens : null;
  if (!pagtos) return; // extrato ainda gerando — mantém o que está
  // Transferências ENVIADAS (não-internas) também são dinheiro saindo — entram p/ classificação.
  const transf = (j.saidas.transferencias && Array.isArray(j.saidas.transferencias.itens))
    ? j.saidas.transferencias.itens.filter(t => !t.provavel_interna) : [];
  const cfg = flxGetConfig();
  cfg.pag = cfg.pag || {};
  const manuais = (cfg.pag[mes] || []).filter(p => p.auto !== 'mp');
  const novos = [];
  const addItem = (it, i, descBase) => {
    if (!it || !(it.valor > 0) || !it.dia || !it.dia.startsWith(mes)) return;
    const dia = parseInt(it.dia.slice(8, 10), 10);
    // já existe conta LANÇADA À MÃO equivalente (mesmo dia, valor ±1%)? então não duplica.
    // (itens auto:'vendas' são provisões de custo — natureza diferente, não contam como duplicata)
    const jaTem = manuais.some(p => !p.auto && p.dia === dia && Math.abs((p.valor || 0) - it.valor) <= it.valor * 0.01);
    if (jaTem) return;
    // cobrança da Meta detectada pela descrição → categoria Tráfego (e vai abater as provisionadas)
    const ehMeta = /facebk|facebook|meta ads/i.test(descBase);
    novos.push({
      id: 'mp-' + mes + '-' + (it.source_id || descBase + i),
      desc: descBase + (it.autorizado ? ' (em liquidação)' : '') + ' · MP auto',
      valor: Math.round(it.valor * 100) / 100,
      dia, cat: ehMeta ? 'trafego' : 'outros', rec: false, auto: 'mp',
      pago: true // o dinheiro JÁ saiu — conta no "já pago", não no "a pagar"
    });
  };
  pagtos.forEach((it, i) => addItem(it, i, flxRotulo(it.source_id) || it.descricao || 'Pagamento via conta MP'));
  transf.forEach((it, i) => addItem(it, i, flxRotulo(it.source_id) || 'Pix/transferência enviada (conferir destino)'));
  const ignM = flxIgnorados(cfg, mes);
  const novosFiltrados = novos.filter(p => !ignM.has(p.id));
  const antes = JSON.stringify((cfg.pag[mes] || []).filter(p => p.auto === 'mp'));
  if (antes === JSON.stringify(novosFiltrados)) return; // nada mudou — evita re-render/salvamento à toa
  cfg.pag[mes] = manuais.concat(novosFiltrados);
  // Reconciliação do tráfego: regenera as provisões abatendo o que a Meta já cobrou de verdade.
  // (preserva itens pontuais manuais de tráfego — só as provisionadas rec são regeradas)
  const semProvisaoTrafego = cfg.pag[mes].filter(p => !(p.rec && p.cat === 'trafego' && p.auto !== 'mp'));
  cfg.pag[mes] = semProvisaoTrafego.concat(flxTrafegoLiquido(cfg, mes));
  flxSalvarPag(cfg);
  if (modeloAtual === '__fluxo__' && document.getElementById('flx-mes').value === mes) {
    flxRenderPagamentos(cfg, mes);
    flxRecompute();
  }
}

// Polling de saldos enquanto a aba Fluxo estiver aberta e visível (quase-tempo-real).
// A cada 3 min: saldos MP/Pagar.me; a cada 2 ciclos (6 min): card MP + tabela (movimentações).
function flxIniciarPollSaldos() {
  if (window._flxPoll) return;
  let ciclo = 0;
  window._flxPoll = setInterval(() => {
    if (modeloAtual !== '__fluxo__' || document.hidden) return;
    ciclo++;
    flxAtualizarSaldos(true);
    if (ciclo % 2 === 0) {
      const mes = document.getElementById('flx-mes') && document.getElementById('flx-mes').value;
      if (mes) mpRenderCard('flx-mp', mes);
    }
  }, 180000);
}

// Busca saldos via API. silencioso=true evita status na carga inicial.
async function flxAtualizarSaldos(silencioso) {
  const cfg = flxGetConfig();
  cfg.saldos = cfg.saldos || { stone: { v: 0, at: null }, mp: { v: 0, at: null }, pagarme: { v: 0, at: null } };
  const st = document.getElementById('flx-saldo-status');
  if (st && !silencioso) st.textContent = 'atualizando saldos…';
  const pull = async (url, chave) => {
    try {
      const r = await fetch(url + '?t=' + Date.now());
      const d = await r.json();
      // extrato novo sendo gerado → re-puxa sozinho em ~2,5 min (uma vez) p/ trocar estimativa pelo exato
      if (d && d.gerando && !window._flxSaldoRetry) {
        window._flxSaldoRetry = setTimeout(() => { window._flxSaldoRetry = null; if (modeloAtual === '__fluxo__') flxAtualizarSaldos(true); }, 150000);
      }
      if (d && typeof d.disponivel === 'number') {
        cfg.saldos[chave] = { v: Math.round(d.disponivel * 100) / 100, at: new Date().toISOString(), auto: true };
        return true;
      }
    } catch (e) {}
    return false;
  };
  const [okMp, okPg] = await Promise.all([
    pull('/api/mp-saldo', 'mp'),
    pull('/api/pagarme-saldo', 'pagarme')
  ]);
  cfg.updated_at = new Date().toISOString();
  saveLocal('vc:fluxo_caixa', cfg);
  if (okMp || okPg) salvarNuvem('fluxo_caixa', cfg);
  if (st) st.textContent = (okMp || okPg)
    ? ('saldos atualizados ' + (okMp ? '' : '(MP falhou) ') + (okPg ? '' : '(Pagar.me falhou)')).trim()
    : (silencioso ? '' : 'API de saldo indisponível — use os valores manuais');
  // só re-renderiza se ainda estiver na aba
  if (modeloAtual === '__fluxo__') { flxRenderSaldos(cfg); flxRecompute(); }
}

function flxRenderSaldos(cfg) {
  const s = cfg.saldos || {};
  const fmtAt = at => { if (!at) return ''; const d = new Date(at); return '· ' + String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + 'h' + String(d.getMinutes()).padStart(2, '0'); };
  const linha = (chave, label, obj, auto) => `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f0ede8">
      <label style="flex:1;font-size:13px;color:var(--text-sec)">${label}${auto ? ' <span style="font-size:10px;color:var(--text-ter)">auto ' + (obj.at ? fmtAt(obj.at) : '· pendente') + '</span>' : ' <span style="font-size:10px;color:var(--text-ter)">manual</span>'}</label>
      <span style="font-size:12px;color:var(--text-ter)">R$</span>
      <input id="flx-saldo-${chave}" type="number" step="0.01" value="${(obj && obj.v) || 0}" oninput="flxSaldoManual('${chave}')" style="width:130px;text-align:right;padding:6px 8px;border:1px solid var(--border);border-radius:6px">
    </div>`;
  document.getElementById('flx-saldos').innerHTML =
    linha('stone', 'Stone (banco)', s.stone || {}, false) +
    linha('mp', 'Mercado Pago', s.mp || {}, true) +
    linha('pagarme', 'Pagar.me', s.pagarme || {}, true) +
    `<div style="display:flex;align-items:center;gap:8px;padding:8px 0 0;font-weight:700">
      <span style="flex:1;font-size:13px">Saldo total disponível</span>
      <span id="flx-saldo-total" style="font-size:15px;color:var(--gold-dark)">${finBRL(flxSaldoTotal(cfg))}</span>
    </div>`;
}

function flxSaldoManual(chave) {
  const cfg = flxGetConfig();
  cfg.saldos = cfg.saldos || {};
  const v = parseFloat(document.getElementById('flx-saldo-' + chave).value) || 0;
  cfg.saldos[chave] = { v, at: new Date().toISOString(), auto: false };
  cfg.updated_at = new Date().toISOString();
  saveLocal('vc:fluxo_caixa', cfg);
  clearTimeout(window._flxSaveTimer);
  window._flxSaveTimer = setTimeout(() => salvarNuvem('fluxo_caixa', cfg), 900);
  const el = document.getElementById('flx-saldo-total');
  if (el) el.textContent = finBRL(flxSaldoTotal(cfg));
  flxRecompute();
}

function flxRenderPagamentos(cfg, mes) {
  const tc = cfg.trafegoCfg || FLX_TRAFEGO_DEFAULT;
  const estEl = document.getElementById('flx-trf-est'); if (estEl) estEl.value = tc.estimativa;
  const limEl = document.getElementById('flx-trf-lim'); if (limEl) limEl.value = tc.limite;
  const impEl = document.getElementById('flx-trf-imp'); if (impEl) impEl.value = (tc.impostoPct !== undefined ? tc.impostoPct : FLX_TRAFEGO_DEFAULT.impostoPct);
  const lista = (cfg.pag && cfg.pag[mes]) || [];
  const ordenada = lista.map((p, i) => ({ p, i })).sort((a, b) => (a.p.dia - b.p.dia) || (b.p.valor - a.p.valor));
  const opCats = CUSTO_DEFS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  const rows = ordenada.map(({ p, i }) => `<tr style="${p.pago ? 'opacity:0.5' : ''}">
      <td style="padding:3px 4px;text-align:center"><input type="checkbox" ${p.pago ? 'checked' : ''} onchange="flxPagToggle(${i})" title="marcar como pago"></td>
      <td style="padding:3px 4px"><input value="${String(p.desc).replace(/"/g, '&quot;')}" oninput="flxPagEdit(${i},'desc',this.value)" style="width:100%;min-width:150px;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px;${p.pago ? 'text-decoration:line-through' : ''}"></td>
      <td style="padding:3px 4px"><select onchange="flxPagEdit(${i},'cat',this.value)" style="font-size:11px;padding:4px 6px;border:1px solid var(--border);border-radius:5px">${opCats.replace('value="' + p.cat + '"', 'value="' + p.cat + '" selected')}</select></td>
      <td style="padding:3px 4px"><input type="number" min="1" max="31" value="${p.dia}" oninput="flxPagEdit(${i},'dia',this.value)" style="width:52px;text-align:center;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:3px 4px"><input type="number" step="0.01" value="${p.valor}" oninput="flxPagEdit(${i},'valor',this.value)" style="width:104px;text-align:right;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:3px 4px;text-align:center"><button onclick="flxPagDel(${i})" title="remover" style="background:none;border:none;cursor:pointer;color:var(--text-ter);font-size:15px">×</button></td>
    </tr>`).join('');
  document.getElementById('flx-pag-tbody').innerHTML = rows ||
    '<tr><td colspan="6" style="text-align:center;color:var(--text-ter);font-size:12px;padding:12px">Sem contas cadastradas. Clique em “+ adicionar conta”.</td></tr>';
}

function flxPagEdit(i, campo, val) {
  const cfg = flxGetConfig();
  const mes = document.getElementById('flx-mes').value;
  const p = (cfg.pag[mes] || [])[i]; if (!p) return;
  if (campo === 'valor') p.valor = parseFloat(val) || 0;
  else if (campo === 'dia') p.dia = Math.min(31, Math.max(1, parseInt(val) || 1));
  else p[campo] = val;
  flxSalvarPag(cfg);
  flxRecompute();
}
function flxPagToggle(i) {
  const cfg = flxGetConfig();
  const mes = document.getElementById('flx-mes').value;
  const p = (cfg.pag[mes] || [])[i]; if (!p) return;
  p.pago = !p.pago;
  flxSalvarPag(cfg);
  flxRenderPagamentos(cfg, mes);
  flxRecompute();
}
// Rótulo manual de um movimento MP (por source_id) — identificação que a API não fornece.
function flxRotulo(sid) {
  if (!sid) return null;
  const cfg = flxGetConfig();
  return (cfg.rotulos && cfg.rotulos[String(sid)]) || null;
}
function flxRotular(sid, mes) {
  if (!sid) return;
  const atual = flxRotulo(sid) || '';
  const nome = prompt('Identificação deste movimento (ex.: "Álvaro", "Maria Elizete facção"):', atual);
  if (nome === null) return;
  const cfg = flxGetConfig();
  cfg.rotulos = cfg.rotulos || {};
  if (nome.trim()) cfg.rotulos[String(sid)] = nome.trim(); else delete cfg.rotulos[String(sid)];
  flxSalvarPag(cfg);
  // re-aplica em tudo que deriva dos dados MP
  if (window._flxMP && window._flxMP.mes === mes) {
    flxAplicarSaidasMP(window._flxMP.dados, mes);
    flxRecompute();
  }
  mpRenderCard('flx-mp', mes);
  const fin = document.getElementById('fin-mp'); if (fin && fin.innerHTML) mpRenderCard('fin-mp', document.getElementById('fin-mes') ? document.getElementById('fin-mes').value : mes);
}

// Expande/recolhe os recebimentos individuais de um dia no card REALIZADO
function flxToggleEntGrupo(grp) {
  let aberto = false;
  document.querySelectorAll('tr[data-grp="' + grp + '"]').forEach(tr => {
    aberto = tr.style.display === 'none';
    tr.style.display = aberto ? '' : 'none';
  });
  const ch = document.getElementById('chev-' + grp);
  if (ch) ch.style.transform = aberto ? 'rotate(90deg)' : '';
}

function flxIgnorados(cfg, mes) {
  return new Set((cfg.ignorados && cfg.ignorados[mes]) || []);
}
// Remove um lançamento direto da projeção (×). O id vai para a lista de ignorados do mês —
// itens automáticos (vendas/MP/tráfego) NÃO voltam nos próximos syncs. Desfazer: botão "recorrentes".
function flxProjRemover(id) {
  const cfg = flxGetConfig();
  const mes = document.getElementById('flx-mes').value;
  cfg.ignorados = cfg.ignorados || {};
  cfg.ignorados[mes] = cfg.ignorados[mes] || [];
  if (!cfg.ignorados[mes].includes(id)) cfg.ignorados[mes].push(id);
  cfg.pag[mes] = (cfg.pag[mes] || []).filter(p => p.id !== id);
  flxSalvarPag(cfg);
  flxRenderPagamentos(cfg, mes);
  flxRecompute();
}

function flxPagDel(i) {
  const cfg = flxGetConfig();
  const mes = document.getElementById('flx-mes').value;
  const rem = (cfg.pag[mes] || [])[i];
  if (rem && rem.id) {
    cfg.ignorados = cfg.ignorados || {};
    cfg.ignorados[mes] = cfg.ignorados[mes] || [];
    if (!cfg.ignorados[mes].includes(rem.id)) cfg.ignorados[mes].push(rem.id);
  }
  (cfg.pag[mes] || []).splice(i, 1);
  flxSalvarPag(cfg);
  flxRenderPagamentos(cfg, mes);
  flxRecompute();
}
// Lançamento rápido de pagamento previsto direto no card da Projeção Diária.
function flxProjFormInit(mes) {
  const sel = document.getElementById('flx-proj-cat');
  if (sel && !sel.options.length) {
    CUSTO_DEFS.forEach(([k, l]) => { const o = document.createElement('option'); o.value = k; o.textContent = l; sel.appendChild(o); });
    sel.value = 'outros';
  }
  const diaEl = document.getElementById('flx-proj-dia');
  if (diaEl && !diaEl.value) {
    const hoje = new Date();
    const mesAtual = hoje.getFullYear() + '-' + String(hoje.getMonth() + 1).padStart(2, '0');
    diaEl.value = (mes === mesAtual) ? hoje.getDate() : 1;
  }
}

function flxProjAdd() {
  const msg = document.getElementById('flx-proj-add-msg');
  const desc = (document.getElementById('flx-proj-desc').value || '').trim();
  const valor = parseFloat(document.getElementById('flx-proj-valor').value) || 0;
  const dia = Math.min(31, Math.max(1, parseInt(document.getElementById('flx-proj-dia').value) || 0));
  const cat = document.getElementById('flx-proj-cat').value || 'outros';
  if (!desc || valor <= 0 || !dia) { if (msg) msg.textContent = 'preencha descrição, dia e valor'; return; }
  const cfg = flxGetConfig();
  const mes = document.getElementById('flx-mes').value;
  cfg.pag = cfg.pag || {}; cfg.pag[mes] = cfg.pag[mes] || [];
  cfg.pag[mes].push({ id: 'p' + Date.now(), desc, valor: Math.round(valor * 100) / 100, dia, cat, rec: false, pago: false });
  flxSalvarPag(cfg);
  flxRenderPagamentos(cfg, mes);
  flxRecompute();
  document.getElementById('flx-proj-desc').value = '';
  document.getElementById('flx-proj-valor').value = '';
  if (msg) { msg.textContent = '✓ adicionado'; setTimeout(() => { if (msg.textContent === '✓ adicionado') msg.textContent = ''; }, 2500); }
  document.getElementById('flx-proj-desc').focus();
}

function flxPagAdd() {
  const cfg = flxGetConfig();
  const mes = document.getElementById('flx-mes').value;
  cfg.pag[mes] = cfg.pag[mes] || [];
  const hoje = new Date();
  const diaBase = (mes === hoje.getFullYear() + '-' + String(hoje.getMonth() + 1).padStart(2, '0')) ? hoje.getDate() : 1;
  cfg.pag[mes].push({ id: 'p' + Date.now(), desc: 'Nova conta', valor: 0, dia: diaBase, cat: 'outros', rec: false, pago: false });
  flxSalvarPag(cfg);
  flxRenderPagamentos(cfg, mes);
  flxRecompute();
}
function flxResetRecorrentes() {
  if (!confirm('Recarregar as contas recorrentes padrão neste mês? As contas pontuais que você adicionou são mantidas; as recorrentes voltam ao modelo.')) return;
  const cfg = flxGetConfig();
  const mes = document.getElementById('flx-mes').value;
  // desfaz também as remoções individuais (×) do mês — restaura tudo ao padrão
  cfg.ignorados = cfg.ignorados || {}; cfg.ignorados[mes] = [];
  // mantém pontuais E as auto-vendas (que são regeneradas pela sincronização de vendas)
  const preservar = (cfg.pag[mes] || []).filter(p => !p.rec || p.auto === 'vendas');
  cfg.pag[mes] = flxRecorrentesTemplate(mes, cfg.trafegoCfg, cfg.vendasAuto).concat(preservar);
  flxSalvarPag(cfg);
  flxRenderPagamentos(cfg, mes);
  flxRecompute();
}

// Regenera só as cobranças de tráfego (fracionadas) a partir da estimativa do mês e do limite de cobrança.
function flxRecalcTrafego() {
  const cfg = flxGetConfig();
  const mes = document.getElementById('flx-mes').value;
  const est = parseFloat(document.getElementById('flx-trf-est').value) || 0;
  const lim = parseFloat(document.getElementById('flx-trf-lim').value) || 3000;
  const impEl = document.getElementById('flx-trf-imp');
  const imp = impEl ? (parseFloat(impEl.value) || 0) : FLX_TRAFEGO_DEFAULT.impostoPct;
  cfg.trafegoCfg = { estimativa: est, limite: lim, impostoPct: imp };
  // remove só as cobranças de tráfego recorrentes (mantém tráfego pontual manual, itens MP reais e as demais contas)
  const outras = (cfg.pag[mes] || []).filter(p => !(p.cat === 'trafego' && p.rec && p.auto !== 'mp'));
  cfg.pag[mes] = outras;
  cfg.pag[mes] = outras.concat(flxTrafegoLiquido(cfg, mes)); // mês corrente = saldo real Meta; futuros = estimativa
  flxSalvarPag(cfg);
  flxAtualizarMetaSaldo(mes, true); // força refresh do saldo devedor (ignora cache de 6h)
  flxRenderPagamentos(cfg, mes);
  flxRecompute();
}

function flxSalvarPag(cfg) {
  cfg.updated_at = new Date().toISOString();
  saveLocal('vc:fluxo_caixa', cfg);
  clearTimeout(window._flxSaveTimer);
  window._flxSaveTimer = setTimeout(() => salvarNuvem('fluxo_caixa', cfg), 900);
}

// ── Integração com as VENDAS Shopify: cada peça vendida vira custo de produção ──
// "Vendeu → precisa ser produzido → já é um custo". O custo (tecido+corte+costura+frete)
// das peças vendidas na semana é injetado como obrigação futura aos DOMINGOS.
// Custo por modelo vem da aba Precificação (vc:precificacao); conjuntos = soma das peças.

function flxPrecoCfg() { return loadLocal('vc:precificacao') || { global: {}, modelos: {} }; }

// Custo de produção (tecido/corte/costura) de 1 peça de um modelo. Frete vem separado (do pedido Shopify).
function flxCustoModelo(pc, slug, _depth) {
  _depth = _depth || 0;
  const g = pc.global || {};
  const md = (typeof MODELOS !== 'undefined' && MODELOS[slug]) || {};
  const cfgM = (pc.modelos && pc.modelos[slug]) || {};
  if (_depth < 3 && typeof CONJUNTO_PECAS !== 'undefined' && CONJUNTO_PECAS[slug]) {
    let t = 0, c = 0, s = 0;
    for (const peca of CONJUNTO_PECAS[slug]) {
      const pk = (typeof peca === 'string') ? peca : peca.key;
      const r = flxCustoModelo(pc, pk, _depth + 1);
      t += r.tecido; c += r.corte; s += r.costura;
    }
    return { tecido: t, corte: c, costura: s };
  }
  const consumo = (cfgM.consumo != null ? cfgM.consumo : (md.consumo || 0));
  const preco = cfgM.preco || md.preco || g.custoMetro || 0;
  return { tecido: (consumo || 0) * (preco || 0), corte: cfgM.corte || 0, costura: cfgM.costura || 0 };
}

// Busca vendas por modelo/semana no intervalo do mês. Retorna null se o endpoint não existir.
// Contrato: { semanas: { 'YYYY-MM-DD'(domingo): { unidades, receita_liquida, frete, porModelo:{slug:qtd} } }, naoMapeados:[{titulo,qtd}] }
async function flxCarregarVendas(mes) {
  const [Y, M] = mes.split('-').map(Number);
  const desde = mes + '-01';
  const ate = mes + '-' + String(new Date(Y, M, 0).getDate()).padStart(2, '0');
  try {
    const r = await fetch('/api/shopify-vendas-modelo?desde=' + desde + '&ate=' + ate + '&t=' + Date.now());
    if (!r.ok) return null;
    const d = await r.json();
    return (d && d.semanas) ? d : null;
  } catch (e) { return null; }
}

// Converte as vendas da semana em contas a pagar (auto:'vendas') distribuídas nos domingos.
function flxVendasParaPagamentos(vendas, incluir) {
  incluir = incluir || { tecido: true, corte: true, costura: true, frete: true };
  const pc = flxPrecoCfg();
  const out = [];
  const naoMap = new Set();
  for (const [domingo, sem] of Object.entries(vendas.semanas || {})) {
    const dia = parseInt(domingo.split('-')[2], 10);
    const ddmm = String(dia).padStart(2, '0') + '/' + domingo.split('-')[1];
    let tecido = 0, faccao = 0;
    for (const [slug, qtd] of Object.entries(sem.porModelo || {})) {
      const cst = flxCustoModelo(pc, slug);
      if ((cst.tecido + cst.corte + cst.costura) === 0) naoMap.add(slug);
      if (incluir.tecido) tecido += (cst.tecido || 0) * qtd;
      if (incluir.corte) faccao += (cst.corte || 0) * qtd;
      if (incluir.costura) faccao += (cst.costura || 0) * qtd;
    }
    const frete = incluir.frete ? (sem.frete || 0) : 0;
    if (tecido > 0) out.push({ id: 'vnd-' + domingo + '-tec', desc: 'Tecido das vendidas (sem. ' + ddmm + ')', valor: Math.round(tecido * 100) / 100, dia, cat: 'tecido', rec: true, auto: 'vendas', pago: false });
    if (faccao > 0) out.push({ id: 'vnd-' + domingo + '-fac', desc: 'Corte+costura das vendidas (sem. ' + ddmm + ')', valor: Math.round(faccao * 100) / 100, dia, cat: 'faccao', rec: true, auto: 'vendas', pago: false });
    if (frete > 0) out.push({ id: 'vnd-' + domingo + '-fre', desc: 'Frete das vendidas (sem. ' + ddmm + ')', valor: Math.round(frete * 100) / 100, dia, cat: 'logistica', rec: true, auto: 'vendas', pago: false });
  }
  return { pagamentos: out, naoMapeados: [...naoMap] };
}

// Puxa vendas e injeta o custo das vendidas no mês (substitui as auto:'vendas' antigas).
async function flxSincronizarVendas(silencioso) {
  const cfg = flxGetConfig();
  const mes = document.getElementById('flx-mes').value;
  const st = document.getElementById('flx-vendas-status');
  if (st && !silencioso) st.textContent = 'lendo vendas Shopify…';
  const vendas = await flxCarregarVendas(mes);
  if (!vendas) {
    window._flxVendas = null;
    if (st) st.textContent = silencioso ? '' : 'sem dados de vendas (endpoint /api/shopify-vendas-modelo indisponível) — usando placeholders manuais';
    return;
  }
  window._flxVendas = vendas;
  const { pagamentos, naoMapeados } = flxVendasParaPagamentos(vendas, cfg.vendasIncluir);
  cfg.pag = cfg.pag || {};
  const manuais = (cfg.pag[mes] || []).filter(p => p.auto !== 'vendas');
  const ignV = flxIgnorados(cfg, mes);
  cfg.pag[mes] = manuais.concat(pagamentos.filter(p => !ignV.has(p.id)));
  saveLocal('vc:fluxo_caixa', cfg);
  // não escreve na nuvem aqui (é derivado das vendas; recalcula sempre) — evita conflito de sync
  if (modeloAtual === '__fluxo__') { flxRenderPagamentos(cfg, mes); flxRecompute(); }
  const totReceita = Object.values(vendas.semanas || {}).reduce((s, w) => s + (w.receita_liquida || 0), 0);
  const totUn = Object.values(vendas.semanas || {}).reduce((s, w) => s + (w.unidades || 0), 0);
  if (st) st.textContent = `${totUn} un vendidas · receita líq. ${finBRL(totReceita)}` + (naoMapeados.length ? ` · ⚠ ${naoMapeados.length} modelo(s) sem custo (ficha zerada): ${naoMapeados.slice(0, 4).join(', ')}` : '');
}

function flxRecompute() {
  const cfg = flxGetConfig();
  const mes = document.getElementById('flx-mes').value;
  const lista = (cfg.pag && cfg.pag[mes]) || [];
  const saldoHoje = flxSaldoTotal(cfg);

  const [Y, M] = mes.split('-').map(Number);
  const hoje = new Date();
  const ehMesAtual = (Y === hoje.getFullYear() && M === hoje.getMonth() + 1);
  const ehPassado = (Y < hoje.getFullYear()) || (Y === hoje.getFullYear() && M < hoje.getMonth() + 1);
  const ultimoDia = new Date(Y, M, 0).getDate();
  const diaInicio = ehMesAtual ? hoje.getDate() : 1;

  // Pagamentos que ainda vão sair = TUDO que não foi pago. Conta VENCIDA (dia < hoje) e não
  // paga continua devida — entra como se vencesse HOJE, marcada "vencida" (ex.: custo de
  // produção das vendidas de semanas passadas). Sem isso ela sumia da projeção e subestimava
  // o que o caixa ainda deve.
  const pend = lista.filter(p => !p.pago && (p.valor || 0) > 0)
    .map(p => (p.dia < diaInicio) ? Object.assign({}, p, { diaEfetivo: diaInicio, vencida: true })
                                  : Object.assign({}, p, { diaEfetivo: p.dia }));
  const aPagar = pend.reduce((s, p) => s + (p.valor || 0), 0);
  const jaPago = lista.filter(p => p.pago).reduce((s, p) => s + (p.valor || 0), 0);
  const totalMes = lista.reduce((s, p) => s + (p.valor || 0), 0);

  // Projeção dia-a-dia (conservadora: nenhuma entrada nova)
  const dias = [];
  let saldo = saldoHoje, menor = saldoHoje, diaMenor = diaInicio;
  for (let d = diaInicio; d <= ultimoDia; d++) {
    const saidas = pend.filter(p => p.diaEfetivo === d).reduce((s, p) => s + (p.valor || 0), 0);
    saldo -= saidas;
    if (saldo < menor) { menor = saldo; diaMenor = d; }
    if (saidas > 0) dias.push({ d, saidas, saldo });
  }
  const saldoFim = saldo;
  const cobertura = aPagar > 0 ? saldoHoje / aPagar : Infinity;
  const dd = d => String(d).padStart(2, '0') + '/' + String(M).padStart(2, '0');
  const corR = v => v >= 0 ? '#16a34a' : '#dc2626';

  // ── Métricas
  document.getElementById('flx-metrics').innerHTML = `
    <div class="metric"><div class="label">SALDO HOJE</div><div class="val val-areia" style="font-size:17px">${finBRL(saldoHoje)}</div></div>
    <div class="metric"><div class="label">A PAGAR (RESTANTE)</div><div class="val val-escuro" style="font-size:17px">${finBRL(aPagar)}</div></div>
    <div class="metric"><div class="label">SALDO FIM DO MÊS</div><div class="val" style="font-size:17px;color:${corR(saldoFim)}">${finBRL(saldoFim)}</div></div>
    <div class="metric"><div class="label">MENOR SALDO ${ehPassado ? '' : 'PROJETADO'}</div><div class="val" style="font-size:17px;color:${corR(menor)}">${finBRL(menor)}</div></div>`;

  // ── Banner de saúde
  const banner = document.getElementById('flx-banner');
  if (ehPassado) {
    banner.style.display = 'none';
  } else {
    banner.style.display = '';
    let cor, bg, icon, txt;
    if (menor < 0) {
      cor = '#dc2626'; bg = 'rgba(220,38,38,0.10)'; icon = 'ti-alert-triangle-filled';
      txt = `<b>Caixa fica negativo em ${dd(diaMenor)}</b> — faltam ${finBRL(Math.abs(menor))} para cobrir as contas do mês. Antecipe recebíveis, renegocie prazos ou reduza saídas.`;
    } else if (cobertura < 1.2) {
      cor = '#d97706'; bg = 'rgba(217,119,6,0.10)'; icon = 'ti-alert-circle';
      txt = `<b>Folga apertada.</b> O saldo cobre as contas, mas sobra só ${finBRL(saldoFim)} (${Math.round((cobertura - 1) * 100)}% de folga). Ponto mais baixo: ${finBRL(menor)} em ${dd(diaMenor)}.`;
    } else {
      cor = '#16a34a'; bg = 'rgba(22,163,74,0.10)'; icon = 'ti-circle-check-filled';
      txt = `<b>Caixa saudável.</b> Cobre todas as contas do mês com o dinheiro em conta. Sobra projetada ao fim do mês: ${finBRL(saldoFim)}. Ponto mais baixo: ${finBRL(menor)} em ${dd(diaMenor)}.`;
    }
    banner.style.borderLeft = '3px solid ' + cor;
    banner.style.background = bg;
    banner.innerHTML = `<div style="display:flex;gap:10px;align-items:flex-start;padding:12px 14px">
      <i class="ti ${icon}" style="font-size:20px;color:${cor};margin-top:1px"></i>
      <div style="font-size:13px;color:var(--text-pri);line-height:1.5">${txt}</div></div>`;
  }

  // ── Tabela de projeção diária (só dias com movimento)
  const projHead = `<tr style="color:var(--text-ter);font-size:11px">
      <th style="text-align:left;padding:6px 8px">Dia</th>
      <th style="text-align:left;padding:6px 8px">Contas do dia</th>
      <th style="text-align:right;padding:6px 8px">Saídas</th>
      <th style="text-align:right;padding:6px 8px">Saldo ${ehPassado ? '' : 'projetado'}</th></tr>`;
  const projRows = dias.map(row => {
    // uma conta por linha, com o valor individual à direita; vencidas destacadas
    const contasDia = pend.filter(p => p.diaEfetivo === row.d)
      .sort((a, b) => (b.vencida ? 1 : 0) - (a.vencida ? 1 : 0) || (b.valor || 0) - (a.valor || 0))
      .map(p => `<div style="display:flex;justify-content:space-between;gap:8px;padding:1px 0;align-items:center">
        <span>${p.vencida ? '<span style="color:#dc2626;font-weight:600">⚠ vencida ' + dd(p.dia) + '</span> — ' : ''}${p.desc}</span>
        <span style="white-space:nowrap;color:var(--text-ter)">− ${finBRL(p.valor || 0)}
          <button onclick="event.stopPropagation();flxProjRemover('${p.id}')" title="remover este lançamento da projeção (não volta nos syncs)" style="background:none;border:none;cursor:pointer;color:var(--text-ter);font-size:13px;padding:0 0 0 4px;vertical-align:middle">×</button></span></div>`)
      .join('');
    const critico = row.d === diaMenor && menor < saldoHoje;
    return `<tr style="border-top:1px solid #f0ede8;${critico ? 'background:rgba(217,119,6,0.06)' : ''}">
      <td style="padding:6px 8px;font-weight:600;vertical-align:top">${dd(row.d)}</td>
      <td style="padding:6px 8px;font-size:12px;color:var(--text-sec)">${contasDia}</td>
      <td style="padding:6px 8px;text-align:right;color:#b45309;vertical-align:top;white-space:nowrap">− ${finBRL(row.saidas)}</td>
      <td style="padding:6px 8px;text-align:right;font-weight:600;vertical-align:top;white-space:nowrap;color:${corR(row.saldo)}">${finBRL(row.saldo)}${critico ? ' <span style="font-size:9px;color:#d97706">◄ mais baixo</span>' : ''}</td></tr>`;
  }).join('');
  const linhaInicial = `<tr><td style="padding:6px 8px;font-weight:600;color:var(--text-ter)">${ehMesAtual ? 'hoje' : (ehPassado ? 'início' : 'dia 1')}</td><td></td><td></td><td style="padding:6px 8px;text-align:right;font-weight:700">${finBRL(saldoHoje)}</td></tr>`;

  // ── Card REALIZADO (separado): contas já pagas do mês (incl. pagamentos MP auto).
  // Informativas: o dinheiro já saiu e o saldo atual já reflete — sem coluna de saldo
  // (evita dupla contagem). Uma linha por pagamento; dia na primeira do grupo.
  const pagos = lista.filter(p => p.pago && (p.valor || 0) > 0);
  // Entradas reais do MP por dia (do último sync) — dinheiro que ENTROU no caixa
  const mpDados = (window._flxMP && window._flxMP.mes === mes && window._flxMP.dados && window._flxMP.dados.entradas)
    ? window._flxMP.dados.entradas : null;
  const movPorDia = {};
  pagos.forEach(p => { movPorDia[p.dia] = movPorDia[p.dia] || { ent: 0, entItens: [], pagos: [] }; movPorDia[p.dia].pagos.push(p); });
  if (mpDados && Array.isArray(mpDados.itens) && mpDados.itens.length) {
    // uma linha por recebimento (hora + valor) — cada Pix/TED visível individualmente
    mpDados.itens.forEach(t => {
      if (!t.dia || !t.dia.startsWith(mes) || !(t.valor > 0)) return;
      const d = parseInt(t.dia.slice(8, 10), 10);
      movPorDia[d] = movPorDia[d] || { ent: 0, entItens: [], pagos: [] };
      movPorDia[d].ent += t.valor;
      movPorDia[d].entItens.push(t);
    });
  } else if (mpDados) {
    Object.entries(mpDados.por_dia || {}).forEach(([iso, v]) => {
      if (!iso.startsWith(mes) || !(v > 0)) return;
      const d = parseInt(iso.slice(8, 10), 10);
      movPorDia[d] = movPorDia[d] || { ent: 0, entItens: [], pagos: [] };
      movPorDia[d].ent += v;
    });
  }
  const totalEntradas = Object.values(movPorDia).reduce((s, m) => s + m.ent, 0);
  const diasMov = Object.keys(movPorDia).map(Number).sort((a, b) => a - b);
  const realizadoRows = diasMov.map(d => {
    const m = movPorDia[d];
    const linhas = [];
    if (m.entItens && m.entItens.length) {
      // agrupado: uma linha por dia com a soma; clique expande os recebimentos individuais
      const grp = 'entgrp-' + mes.replace(/-/g, '') + '-' + d;
      linhas.push(`<tr style="border-top:1px solid #f0ede8;cursor:pointer" onclick="flxToggleEntGrupo('${grp}')" title="clique para ver os recebimentos individuais">
      <td style="padding:4px 8px;font-weight:600;color:var(--text-ter)">${dd(d)}</td>
      <td style="padding:4px 8px;font-size:12px;color:var(--text-sec)"><span id="chev-${grp}" style="display:inline-block;font-size:9px;color:var(--text-ter);transition:transform 0.15s">▸</span> Recebimentos Pix/TED (conta MP) · ${m.entItens.length}x</td>
      <td style="padding:4px 8px;text-align:right;color:#16a34a;white-space:nowrap;font-weight:600">+ ${finBRL(m.ent)}</td>
      <td style="padding:4px 8px;text-align:right;font-size:10px;color:var(--text-ter)">recebido</td></tr>`);
      m.entItens.slice().sort((a, b) => String(a.hora || '').localeCompare(String(b.hora || ''))).forEach(t => {
        const rot = flxRotulo(t.source_id);
        const quem = rot || t.origem || '';
        linhas.push(`<tr data-grp="${grp}" style="display:none;background:rgba(22,163,74,0.04)">
      <td style="padding:3px 8px"></td>
      <td style="padding:3px 8px 3px 24px;font-size:11px;color:var(--text-ter)">↳ ${quem ? '<b style="color:var(--text-sec)">' + quem + '</b> · ' : ''}recebido${t.hora ? ' às ' + t.hora : ''}${t.source_id ? ` <button onclick="flxRotular('${t.source_id}','${mes}')" title="identificar" style="background:none;border:none;cursor:pointer;color:var(--text-ter);font-size:11px;padding:0">✎</button>` : ''}</td>
      <td style="padding:3px 8px;text-align:right;color:#16a34a;white-space:nowrap;font-size:11px">+ ${finBRL(t.valor)}</td>
      <td></td></tr>`);
      });
    } else if (m.ent > 0) linhas.push(`<tr style="border-top:1px solid #f0ede8">
      <td style="padding:4px 8px;font-weight:600;color:var(--text-ter)">${dd(d)}</td>
      <td style="padding:4px 8px;font-size:12px;color:var(--text-sec)">↓ Recebimentos Pix/TED (conta MP)</td>
      <td style="padding:4px 8px;text-align:right;color:#16a34a;white-space:nowrap;font-weight:600">+ ${finBRL(m.ent)}</td>
      <td style="padding:4px 8px;text-align:right;font-size:10px;color:var(--text-ter)">recebido</td></tr>`);
    m.pagos.slice().sort((a, b) => (b.valor || 0) - (a.valor || 0)).forEach((p, i) => {
      const primeiraLinha = linhas.length === 0;
      linhas.push(`<tr style="${primeiraLinha ? 'border-top:1px solid #f0ede8;' : ''}">
      <td style="padding:4px 8px;font-weight:600;color:var(--text-ter)">${primeiraLinha ? dd(d) : ''}</td>
      <td style="padding:4px 8px;font-size:12px;color:var(--text-sec)">✓ ${p.desc}</td>
      <td style="padding:4px 8px;text-align:right;color:#b45309;white-space:nowrap">− ${finBRL(p.valor || 0)}</td>
      <td style="padding:4px 8px;text-align:right;font-size:10px;color:var(--text-ter)">pago</td></tr>`);
    });
    return linhas.join('');
  }).join('');
  const realEl = document.getElementById('flx-realizado');
  if (realEl) {
    realEl.innerHTML = realizadoRows
      ? `<table style="width:100%;font-size:13px;border-collapse:collapse">
          <tr style="color:var(--text-ter);font-size:11px"><th style="text-align:left;padding:6px 8px">Dia</th><th style="text-align:left;padding:6px 8px">Movimento</th><th style="text-align:right;padding:6px 8px">Valor</th><th></th></tr>
          ${realizadoRows}
          ${totalEntradas > 0 ? `<tr style="border-top:2px solid var(--border);font-weight:700"><td style="padding:6px 8px"></td><td style="padding:6px 8px">Total recebido no mês (MP)</td><td style="padding:6px 8px;text-align:right;color:#16a34a">+ ${finBRL(totalEntradas)}</td><td></td></tr>` : ''}
          <tr style="${totalEntradas > 0 ? '' : 'border-top:2px solid var(--border);'}font-weight:700"><td style="padding:6px 8px"></td><td style="padding:6px 8px">Total já pago no mês</td><td style="padding:6px 8px;text-align:right;color:#b45309">− ${finBRL(jaPago)}</td><td></td></tr>
        </table>`
      : '<div style="font-size:12px;color:var(--text-ter);padding:6px 0">Nenhum movimento realizado neste mês ainda.</div>';
  }
  const realTotEl = document.getElementById('flx-realizado-total');
  if (realTotEl) realTotEl.textContent = (totalEntradas > 0 || jaPago > 0) ? ('+ ' + finBRL(totalEntradas) + '  ·  − ' + finBRL(jaPago)) : '';

  // ── Card PROJETADO (a vencer)
  document.getElementById('flx-proj').innerHTML = dias.length
    ? `<table style="width:100%;font-size:13px;border-collapse:collapse">${projHead}${linhaInicial}${projRows}</table>`
    : '<div style="font-size:12px;color:var(--text-ter);padding:8px">Nenhuma conta a vencer nesta janela.</div>';

  // ── Composição das saídas restantes por categoria
  const porCat = {};
  pend.forEach(p => { porCat[p.cat] = (porCat[p.cat] || 0) + (p.valor || 0); });
  const itens = Object.entries(porCat).map(([k, v]) => [flxCatNome(k), v, flxCatCor(k)]).sort((a, b) => b[1] - a[1]);
  const maxv = Math.max(...itens.map(i => i[1]), 1);
  document.getElementById('flx-chart').innerHTML = itens.map(i => `
    <div style="display:flex;align-items:center;gap:8px;margin:5px 0;font-size:12px">
      <span style="width:150px;color:var(--text-sec)">${i[0]}</span>
      <div style="flex:1;background:#f0ede8;border-radius:4px;height:16px;overflow:hidden"><div style="height:100%;width:${Math.round(i[1] / maxv * 100)}%;background:${i[2]}"></div></div>
      <span style="width:100px;text-align:right;font-weight:600">${finBRL(i[1])}</span>
      <span style="width:42px;text-align:right;color:var(--text-ter)">${aPagar ? Math.round(i[1] / aPagar * 100) : 0}%</span>
    </div>`).join('') || '<div style="font-size:12px;color:var(--text-ter);padding:8px 0">Nada a pagar nesta janela.</div>';

  // ── Rodapé do card de contas
  const rodape = document.getElementById('flx-pag-rodape');
  if (rodape) rodape.innerHTML = `Já pago no mês: <b>${finBRL(jaPago)}</b> · A pagar: <b>${finBRL(aPagar)}</b> · Total do mês: <b>${finBRL(totalMes)}</b>`;

  // ── Card Vendas × Custo de produção (por semana)
  const vEl = document.getElementById('flx-vendas');
  if (vEl) {
    const v = window._flxVendas;
    if (!v || !v.semanas || !Object.keys(v.semanas).length) {
      vEl.innerHTML = '<div style="font-size:12px;color:var(--text-ter);padding:6px 0">Sem dados de vendas Shopify para este mês (endpoint /api/shopify-vendas-modelo ainda não publicado). Enquanto isso, tecido/facção entram pelos placeholders manuais.</div>';
    } else {
      const pc = flxPrecoCfg();
      const inc = cfg.vendasIncluir || { tecido: true, corte: true, costura: true, frete: true };
      let sumU = 0, sumR = 0, sumC = 0;
      const rows = Object.entries(v.semanas).sort((a, b) => a[0] < b[0] ? -1 : 1).map(([dom, sem]) => {
        const ddmm = dom.split('-')[2] + '/' + dom.split('-')[1];
        let custo = 0;
        for (const [slug, qtd] of Object.entries(sem.porModelo || {})) {
          const c = flxCustoModelo(pc, slug);
          if (inc.tecido) custo += (c.tecido || 0) * qtd;
          if (inc.corte) custo += (c.corte || 0) * qtd;
          if (inc.costura) custo += (c.costura || 0) * qtd;
        }
        if (inc.frete) custo += (sem.frete || 0);
        const rec = sem.receita_liquida || 0;
        const marg = rec ? (rec - custo) / rec * 100 : 0;
        sumU += sem.unidades || 0; sumR += rec; sumC += custo;
        return `<tr style="border-top:1px solid #f0ede8">
          <td style="padding:6px 8px">sem. até ${ddmm}</td>
          <td style="padding:6px 8px;text-align:right">${sem.unidades || 0}</td>
          <td style="padding:6px 8px;text-align:right;color:#16a34a">${finBRL(rec)}</td>
          <td style="padding:6px 8px;text-align:right;color:#b45309">${finBRL(custo)}</td>
          <td style="padding:6px 8px;text-align:right;font-weight:600;color:${marg >= 0 ? '#16a34a' : '#dc2626'}">${Math.round(marg)}%</td></tr>`;
      }).join('');
      const margT = sumR ? (sumR - sumC) / sumR * 100 : 0;
      vEl.innerHTML = `<table style="width:100%;font-size:13px;border-collapse:collapse">
        <tr style="color:var(--text-ter);font-size:11px"><th style="text-align:left;padding:6px 8px">Semana</th><th style="text-align:right;padding:6px 8px">Un.</th><th style="text-align:right;padding:6px 8px">Receita líq.</th><th style="text-align:right;padding:6px 8px">Custo produção</th><th style="text-align:right;padding:6px 8px">Margem</th></tr>
        ${rows}
        <tr style="border-top:2px solid var(--border);font-weight:700"><td style="padding:6px 8px">Total do mês</td><td style="padding:6px 8px;text-align:right">${sumU}</td><td style="padding:6px 8px;text-align:right;color:#16a34a">${finBRL(sumR)}</td><td style="padding:6px 8px;text-align:right;color:#b45309">${finBRL(sumC)}</td><td style="padding:6px 8px;text-align:right;color:${margT >= 0 ? '#16a34a' : '#dc2626'}">${Math.round(margT)}%</td></tr>
      </table>`;
    }
  }
}

// ─── ABA PRECIFICAÇÃO ────────────────────────────────────────────────────────
function precoGetConfig() {
  return loadLocal('vc:precificacao') || { global: { custoMetro: 12, taxa: 2.6, plataforma: 1.05, imposto: 0, marketing: 26.73, fixos: 9.55, logistica: 2.09, margem: 25 }, modelos: {} };
}
function precoChaves() {
  const ks = [];
  SIDEBAR_ESTRUTURA.forEach(g => g.modelos.forEach(k => { if (MODELOS[k] && !ks.includes(k)) ks.push(k); }));
  return ks;
}
function precoEhConjunto(k) { return (typeof CONJUNTO_PECAS !== 'undefined') && !!CONJUNTO_PECAS[k]; }

function abrirPrecos(item) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (item) item.classList.add('active');
  if (modeloAtual !== '__dashboard__' && modeloAtual !== '__financeiro__' && modeloAtual !== '__precos__' && (estEditado || prodEditado || cfgEditado)) {
    clearTimeout(saveTimer); salvarModelo();
  }
  estEditado = false; prodEditado = false; cfgEditado = false; esconderBtnSalvar();
  modeloAtual = '__precos__';
  location.hash = 'precos';
  document.getElementById('model-title').innerHTML = '<span style="font-family:\'Bebas Neue\',\'Arial Narrow\',sans-serif;font-weight:400;font-size:26px;letter-spacing:0.1em">PRECIFICAÇÃO</span>';
  document.getElementById('model-sub').textContent = '';
  document.getElementById('topbar-actions').style.display = 'none';
  document.getElementById('tabs-modelo').style.display = 'none';
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-precos').classList.add('active');
  document.body.classList.add('precos-mode'); // esconde menu lateral p/ tabela larga
  const ok = sessionStorage.getItem('fin-ok') === '1';
  document.getElementById('prc-gate').style.display = ok ? 'none' : '';
  document.getElementById('prc-content').style.display = ok ? '' : 'none';
  if (ok) renderPrecos(); else setTimeout(() => document.getElementById('prc-senha')?.focus(), 60);
  closeSidebar();
}

async function precoUnlock() {
  const v = document.getElementById('prc-senha').value;
  if (await conferirSenha(v) === 'dona') {
    sessionStorage.setItem('fin-ok', '1');
    document.getElementById('prc-erro').textContent = '';
    document.getElementById('prc-senha').value = '';
    document.getElementById('prc-gate').style.display = 'none';
    document.getElementById('prc-content').style.display = '';
    renderPrecos();
  } else {
    document.getElementById('prc-erro').textContent = 'Senha incorreta';
  }
}
function precoLock() {
  sessionStorage.removeItem('fin-ok');
  document.getElementById('prc-gate').style.display = '';
  document.getElementById('prc-content').style.display = 'none';
}

async function renderPrecos() {
  const cfg = precoGetConfig();
  const g = cfg.global || { custoMetro: 12, taxa: 2.6, imposto: 0, margem: 25 };
  const ginp = (id, label, val, suf) => `<div style="display:flex;flex-direction:column;gap:2px">
    <label style="font-size:11px;color:var(--text-sec)">${label}</label>
    <div style="display:flex;align-items:center;gap:4px"><input id="${id}" type="number" step="0.01" value="${val}" oninput="precoSalvar()" style="width:90px;text-align:right;padding:6px 8px;border:1px solid var(--border);border-radius:6px"><span style="font-size:12px;color:var(--text-ter)">${suf}</span></div>
  </div>`;
  document.getElementById('prc-globais').innerHTML = `<div style="display:flex;gap:16px;flex-wrap:wrap">
    ${ginp('prc-g-taxa', 'Taxa pagamento', g.taxa, '%')}
    ${ginp('prc-g-plataforma', 'Shopify / plataforma', g.plataforma != null ? g.plataforma : 1.05, '%')}
    ${ginp('prc-g-imposto', 'Imposto', g.imposto, '%')}
    ${ginp('prc-g-marketing', 'Marketing / CAC', g.marketing != null ? g.marketing : 26.73, '%')}
    ${ginp('prc-g-fixos', 'Custos fixos', g.fixos != null ? g.fixos : 9.55, '%')}
    ${ginp('prc-g-logistica', 'Logística', g.logistica != null ? g.logistica : 2.09, '%')}
    ${ginp('prc-g-margem', 'Margem alvo', g.margem, '%')}
  </div>
  <div id="prc-divisor-aviso" style="font-size:11px;color:var(--text-ter);margin-top:8px"></div>`;

  const cell = (id, val, w) => `<td style="padding:3px 4px"><input id="${id}" type="number" step="0.01" value="${val}" oninput="precoSalvar()" style="width:${w || 56}px;text-align:right;padding:5px 6px;border:1px solid var(--border);border-radius:6px;font-size:12px"></td>`;
  const disp = (id) => `<td id="${id}" style="text-align:right;padding:5px 6px;color:var(--text-ter)">—</td>`;
  let rows = '';
  precoChaves().forEach(k => {
    const m = (cfg.modelos && cfg.modelos[k]) || {};
    const comps = (typeof CONJUNTO_PECAS !== 'undefined') ? CONJUNTO_PECAS[k] : null;
    const fim = `<td id="pr-${k}-custo" style="text-align:right;padding:5px 6px;font-weight:600">—</td>
      <td id="pr-${k}-oper" style="text-align:right;padding:5px 6px;color:var(--text-sec)">—</td>
      <td id="pr-${k}-sug" style="text-align:right;padding:5px 6px;font-weight:700;color:#16a34a">—</td>
      <td id="pr-${k}-venda" style="text-align:right;padding:5px 6px;color:var(--text-ter)">—</td>
      <td id="pr-${k}-mreal" style="text-align:right;padding:5px 6px;font-weight:600">—</td>
      <td id="pr-${k}-lucro" style="text-align:right;padding:5px 6px;font-weight:700">—</td>`;
    if (comps) {
      const nomes = comps.map(c => { const ck = c.key || c; return (MODELOS[ck] && MODELOS[ck].nome) || ck; }).join(' + ');
      rows += `<tr data-key="${k}" style="background:rgba(196,168,130,0.07)">
        <td style="padding:5px 6px;font-weight:500;white-space:nowrap">${MODELOS[k].nome}<div style="font-size:10px;color:var(--text-ter);font-weight:400">= ${nomes}</div></td>
        <td style="text-align:right;padding:5px 6px;color:var(--text-ter)">—</td>
        <td style="text-align:right;padding:5px 6px;color:var(--text-ter)">—</td>
        <td id="pr-${k}-tecido" style="text-align:right;padding:5px 6px;color:var(--text-sec)">—</td>
        ${disp('pr-' + k + '-corte')}
        ${disp('pr-' + k + '-costura')}
        ${fim}
      </tr>`;
      return;
    }
    const md = loadLocal('vc:' + k) || {};
    const consumo = md.consumo != null ? md.consumo : (MODELOS[k].consumo || 0);
    const preco = md.preco || (MODELOS[k] || {}).preco || g.custoMetro;
    const tdN = v => `<td style="text-align:right;padding:5px 8px;color:var(--text-sec)">${v}</td>`;
    rows += `<tr data-key="${k}">
      <td style="padding:5px 6px;font-weight:500;white-space:nowrap">${MODELOS[k].nome}</td>
      ${tdN(consumo ? consumo + ' m' : '—')}
      ${tdN(preco ? 'R$ ' + (+preco).toFixed(2).replace('.', ',') : '—')}
      <td id="pr-${k}-tecido" style="text-align:right;padding:5px 8px;color:var(--text-sec)">—</td>
      ${tdN(finBRL(m.corte || 0))}
      ${tdN(finBRL(m.costura || 0))}
      ${fim}
    </tr>`;
  });
  document.getElementById('prc-tbody').innerHTML = rows;
  precoRecompute();
  try {
    const res = await fetch('/api/shopify-precos?t=' + Date.now());
    window._prcPrecos = (await res.json()).precos || {};
  } catch (e) { window._prcPrecos = window._prcPrecos || {}; }
  precoRecompute();
}

function precoSalvar() {
  const cfg = precoGetConfig();
  cfg.global = {
    custoMetro: (cfg.global && cfg.global.custoMetro) || 0,
    taxa: parseFloat(document.getElementById('prc-g-taxa').value) || 0,
    plataforma: parseFloat(document.getElementById('prc-g-plataforma').value) || 0,
    imposto: parseFloat(document.getElementById('prc-g-imposto').value) || 0,
    marketing: parseFloat(document.getElementById('prc-g-marketing').value) || 0,
    fixos: parseFloat(document.getElementById('prc-g-fixos').value) || 0,
    logistica: parseFloat(document.getElementById('prc-g-logistica').value) || 0,
    margem: parseFloat(document.getElementById('prc-g-margem').value) || 0,
  };
  cfg.modelos = cfg.modelos || {};
  const numEl = id => { const el = document.getElementById(id); return el ? (parseFloat(el.value) || 0) : 0; };
  precoChaves().forEach(k => {
    cfg.modelos[k] = Object.assign({}, cfg.modelos[k]);
  });
  cfg.updated_at = new Date().toISOString();
  saveLocal('vc:precificacao', cfg);
  clearTimeout(window._prcSaveTimer);
  window._prcSaveTimer = setTimeout(() => salvarNuvem('precificacao', cfg), 900);
  precoRecompute();
}

function precoRecompute() {
  const custoMetro = 0; // fallback removido — cada modelo usa o R$/m do próprio cadastro
  const taxa = parseFloat(document.getElementById('prc-g-taxa').value) || 0;
  const platEl = document.getElementById('prc-g-plataforma');
  const plataforma = platEl ? parseFloat(platEl.value) || 0 : 0;
  const imposto = parseFloat(document.getElementById('prc-g-imposto').value) || 0;
  const marketing = parseFloat(document.getElementById('prc-g-marketing').value) || 0;
  const fixos = parseFloat(document.getElementById('prc-g-fixos').value) || 0;
  const logEl = document.getElementById('prc-g-logistica');
  const logistica = logEl ? parseFloat(logEl.value) || 0 : 0;
  const margem = parseFloat(document.getElementById('prc-g-margem').value) || 0;
  const pctVar = (taxa + plataforma + imposto + marketing + fixos + logistica) / 100; // custos que incidem % sobre o preço
  const divisor = 1 - pctVar - margem / 100;
  const aviso = document.getElementById('prc-divisor-aviso');
  if (divisor <= 0) { aviso.textContent = '⚠ Taxa + plataforma + imposto + marketing + fixos + logística + margem somam ≥ 100% — impossível precificar. Reduza algum %.'; aviso.style.color = '#dc2626'; }
  else { aviso.textContent = `Preço = Custo de produção ÷ ${divisor.toFixed(3)}  (1 − ${taxa}% taxa − ${plataforma}% plataforma − ${imposto}% imposto − ${marketing}% marketing − ${fixos}% fixos − ${logistica}% logística − ${margem}% margem)`; aviso.style.color = 'var(--text-ter)'; }

  const alertas = [];
  const keys = precoChaves();
  const numEl = id => { const el = document.getElementById(id); return el ? (parseFloat(el.value) || 0) : 0; };
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = finBRL(v); };

  // Passo 1: custo de produção (sem embalagem) de cada PEÇA base.
  // Consumo, R$/m, corte e costura são FIXOS do modelo (cadastro) — não editáveis aqui.
  const cfgMods = (precoGetConfig().modelos) || {};
  const pecaCusto = {};
  keys.forEach(k => {
    if (precoEhConjunto(k)) return;
    const md = loadLocal('vc:' + k) || {};
    const cfgM = cfgMods[k] || {};
    const consumo = md.consumo != null ? md.consumo : (MODELOS[k] ? MODELOS[k].consumo || 0 : 0);
    const preco = md.preco || (MODELOS[k] || {}).preco || custoMetro;
    pecaCusto[k] = {
      tecido: consumo * preco,
      corte: cfgM.corte || 0,
      costura: cfgM.costura || 0,
      aviam: 0,
    };
  });

  // Passo 2: monta cada linha (conjunto = soma das peças)
  keys.forEach(k => {
    let tecido = 0, corte = 0, costura = 0, maxPecaCusto = 0;
    const comps = (typeof CONJUNTO_PECAS !== 'undefined') ? CONJUNTO_PECAS[k] : null;
    if (comps) {
      comps.forEach(c => {
        const p = pecaCusto[c.key || c] || {};
        tecido += p.tecido || 0; corte += p.corte || 0; costura += p.costura || 0;
        const pc = (p.tecido || 0) + (p.corte || 0) + (p.costura || 0);
        if (pc > maxPecaCusto) maxPecaCusto = pc;
      });
      setTxt('pr-' + k + '-corte', corte); setTxt('pr-' + k + '-costura', costura);
    } else {
      const p = pecaCusto[k] || {}; tecido = p.tecido || 0; corte = p.corte || 0; costura = p.costura || 0;
    }
    const custo = tecido + corte + costura; // custo de produção (marketing/taxa entram via %)
    // Conjunto = 1 venda só: os custos "por pedido" (marketing/CAC + fixos + logística) contam 1x
    // (sobre a peça âncora = a mais cara), não 1x por peça — senão duplica CAC/frete numa venda única.
    // Peça avulsa segue o cálculo normal (tudo via %).
    const vpPct = (taxa + plataforma + imposto) / 100;   // custos proporcionais ao valor de venda
    const opPct = (marketing + fixos + logistica) / 100; // custos fixos por pedido
    const divBundle = 1 - vpPct - margem / 100;
    const perOrderFixo = comps ? opPct * (divisor > 0 ? maxPecaCusto / divisor : 0) : 0;
    const sug = comps
      ? (divBundle > 0 ? (custo + perOrderFixo) / divBundle : 0)
      : (divisor > 0 ? custo / divisor : 0);
    document.getElementById('pr-' + k + '-tecido').textContent = finBRL(tecido);
    document.getElementById('pr-' + k + '-custo').textContent = finBRL(custo);
    document.getElementById('pr-' + k + '-sug').textContent = (custo > 0 && divisor > 0) ? finBRL(sug) : '—';

    const venda = (window._prcPrecos && window._prcPrecos[k]) || 0;
    const vcell = document.getElementById('pr-' + k + '-venda');
    if (vcell) vcell.textContent = venda ? finBRL(venda) : '—';

    // Custo de operacao em R$: os percentuais globais aplicados ao preco.
    // Usa a venda quando ela existe; sem venda, estima sobre o preco sugerido.
    const ocell = document.getElementById('pr-' + k + '-oper');
    if (ocell) {
      const baseOper = venda > 0 ? venda : sug;
      const oper = comps ? (baseOper * vpPct + perOrderFixo) : (baseOper * pctVar);
      ocell.textContent = (custo > 0 && baseOper > 0) ? finBRL(oper) : '—';
      ocell.style.color = venda > 0 ? 'var(--text-sec)' : 'var(--text-ter)';
      ocell.title = venda > 0
        ? 'Imposto, taxa, plataforma, marketing, fixos e logistica sobre o preco de venda'
        : 'Estimativa sobre o preco sugerido (este modelo nao tem preco de venda cadastrado)';
    }

    const mcell = document.getElementById('pr-' + k + '-mreal');
    const lcell = document.getElementById('pr-' + k + '-lucro');
    if (venda > 0 && custo > 0) {
      const lucro = comps
        ? venda - custo - venda * vpPct - perOrderFixo  // conjunto: custos por pedido contam 1x
        : venda - custo - venda * pctVar;               // peça única: tudo via %
      const mreal = lucro / venda * 100;
      const cor = mreal < (margem - 1) ? '#dc2626' : '#16a34a'; // tolerância de 1 ponto: só alerta abaixo de (meta - 1)%
      if (mcell) { mcell.textContent = mreal.toFixed(1) + '%'; mcell.style.color = cor; }
      if (lcell) { lcell.textContent = finBRL(lucro); lcell.style.color = lucro < 0 ? '#dc2626' : cor; }
      if (vcell) { vcell.style.color = cor; vcell.style.fontWeight = '600'; }
      if (mreal < (margem - 1)) alertas.push({ nome: MODELOS[k].nome, mreal, venda, sug, gap: Math.max(0, sug - venda) });
    } else {
      if (mcell) { mcell.textContent = '—'; mcell.style.color = 'var(--text-ter)'; }
      if (lcell) { lcell.textContent = '—'; lcell.style.color = 'var(--text-ter)'; }
      if (vcell) { vcell.style.color = 'var(--text-ter)'; vcell.style.fontWeight = '400'; }
    }
  });

  const alEl = document.getElementById('prc-alertas');
  if (alEl) {
    alertas.sort((a, b) => a.mreal - b.mreal);
    if (alertas.length === 0) {
      alEl.innerHTML = '<div style="font-size:13px;color:#16a34a"><i class="ti ti-circle-check"></i> Nenhum produto abaixo de ' + (margem - 1) + '% (tolerância de 1 ponto da meta de ' + margem + '%).</div>';
    } else {
      alEl.innerHTML = `<div style="font-size:13px;color:#b45309;margin-bottom:8px"><i class="ti ti-alert-triangle"></i> <strong>${alertas.length}</strong> produto(s) vendendo ABAIXO de ${margem - 1}% (meta ${margem}%) — reajustar preço ou reduzir custo/CAC:</div>` +
        '<div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse">' +
        '<colgroup><col><col style="width:150px"><col style="width:150px"><col style="width:150px"><col style="width:150px"></colgroup>' +
        '<thead><tr style="color:var(--text-ter);font-size:11px;border-bottom:1px solid var(--border)"><th style="text-align:left;padding:5px 10px">Produto</th><th style="text-align:right;padding:5px 10px">Margem real</th><th style="text-align:right;padding:5px 10px">Venda atual</th><th style="text-align:right;padding:5px 10px">Preço ideal</th><th style="text-align:right;padding:5px 10px">Reajuste</th></tr></thead><tbody>' +
        alertas.map(a => `<tr style="border-top:1px solid var(--border)"><td style="padding:5px 10px;font-weight:500">${a.nome}</td><td style="text-align:right;padding:5px 10px;color:#dc2626;font-weight:600">${a.mreal.toFixed(1)}%</td><td style="text-align:right;padding:5px 10px">${finBRL(a.venda)}</td><td style="text-align:right;padding:5px 10px;color:#16a34a">${finBRL(a.sug)}</td><td style="text-align:right;padding:5px 10px;color:#b45309">${a.gap > 0 ? '+' + finBRL(a.gap) : '—'}</td></tr>`).join('') +
        '</tbody></table></div>';
    }
  }
}

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sidebar-overlay');
  sb.classList.toggle('open');
  ov.classList.toggle('show');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('show');
}

function selectModel(el, key) {
  // Salva o modelo atual ANTES de trocar — evita que o timer dispare com DOM do modelo errado
  if (modeloAtual !== '__dashboard__' && modeloAtual !== key) {
    clearTimeout(saveTimer);
    if (estEditado || prodEditado || prod2Editado || cfgEditado) salvarModelo(); // salva enquanto o DOM ainda é do modelo correto
    estEditado  = false;
    prodEditado = false;
    prod2Editado = false;
    esconderBtnSalvar();
  }

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  // modelo aberto = área Confecção ativa na lateral (os modelos não têm mais item próprio)
  (el || document.getElementById('nav-confeccao'))?.classList.add('active');
  document.body.classList.remove('precos-mode');
  modeloAtual = key;
  location.hash = key; // persiste na URL para sobreviver ao refresh
  document.getElementById('tabs-modelo').style.display = '';
  document.getElementById('topbar-actions').style.display = '';
  renderModelo(key); // localStorage já foi sincronizado no startup — renderiza direto
  showTab('producao');
  closeSidebar();
}

function confirmarStatus(key, novoStatus, leva) {
  const saved = loadLocal('vc:' + key) || {};
  if (leva === 2) {
    saved.status2    = novoStatus;
    saved.status2_at = ['Em corte', 'Em costura'].includes(novoStatus) ? new Date().toISOString() : null;
  } else {
    saved.status     = novoStatus;
    saved.status_at  = ['Em corte', 'Em costura'].includes(novoStatus) ? new Date().toISOString() : null;
  }
  saved.updated_at = new Date().toISOString();
  saveLocal('vc:' + key, saved);
  salvarNuvem(key, saved);
  buildSidebar();
  verificarAvisosStatus();
  // Tirar a leva de "Em costura" É a entrega: fecha o valor da rodada na hora, sem esperar
  // o ciclo de 1 minuto (que só roda enquanto o app está aberto).
  cstFatSincronizar().catch(() => {});
  if (modeloAtual === key) {
    const sel = document.getElementById(leva === 2 ? 'prod2-status' : 'prod-status');
    if (sel) sel.value = novoStatus;
  }
}

// Compat
function confirmarEmCorte(key) { confirmarStatus(key, 'Em corte'); }

function verIgnoradosShopify() {
  const ignorados = window._shopifyIgnorados || [];
  const total     = window._shopifyTotalPedidos || 0;
  const win = window.open('', '_blank', 'width=720,height=540');
  const rows = ignorados.length === 0
    ? '<tr><td colspan="3" style="text-align:center;color:#16a34a;padding:20px">✅ Nenhum produto ignorado — todos reconhecidos!</td></tr>'
    : ignorados.map(r => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:12px">${r}</td></tr>`).join('');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Diagnóstico Shopify</title>
    <style>body{font-family:sans-serif;padding:20px;background:#fafafa}h2{margin:0 0 4px}p{color:#666;font-size:13px;margin:0 0 16px}
    table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}
    th{background:#f3f4f6;padding:8px 10px;text-align:left;font-size:11px;letter-spacing:.05em;color:#6b7280}</style>
    </head><body>
    <h2>Diagnóstico Shopify</h2>
    <p>${total} pedidos lidos · <strong style="color:${ignorados.length>0?'#dc2626':'#16a34a'}">${ignorados.length} produto(s) não reconhecido(s)</strong></p>
    <table><thead><tr><th>Pedido | Produto | Motivo</th></tr></thead><tbody>${rows}</tbody></table>
    </body></html>`);
  win.document.close();
}

function verificarAvisosStatus() {
  const alertEl = document.getElementById('status-alerts');
  if (!alertEl) return;

  // Regras: { status, horasMin, urgente (bool = lembrete 12h extra), proxStatus, label, emoji, cor }
  const REGRAS = [
    { status: 'Comprando tecido', horasMin: 24,  urgente: false, proxStatus: 'Em corte',   label: 'Confirmar → Em corte',   emoji: '✂️', cor: '#f59e0b', bg: '#fff8e6', borda: '#f59e0b', txtTitulo: '#b45309', txtInfo: '#92400e' },
    { status: 'Em corte',         horasMin: 48,  urgente: false, proxStatus: 'Em costura', label: 'Confirmar → Em costura', emoji: '🧵', cor: '#7C3AED', bg: '#f5f0ff', borda: '#7C3AED', txtTitulo: '#5b21b6', txtInfo: '#6d28d9' },
    { status: 'Em corte',         horasMin: 60,  urgente: true,  proxStatus: 'Em costura', label: 'Confirmar → Em costura', emoji: '🧵', cor: '#dc2626', bg: '#fff1f2', borda: '#dc2626', txtTitulo: '#991b1b', txtInfo: '#b91c1c' },
  ];

  const avisos = []; // { regra, nome, horas, key, leva }

  for (const [key, def] of Object.entries(MODELOS)) {
    const saved = loadLocal('vc:' + key) || {};
    // Cada leva tem status/relógio próprios e gera aviso independente
    const levas = [
      { status: saved.status,  at: saved.status_at,  leva: 1 },
      { status: saved.status2, at: saved.status2_at, leva: 2 },
    ];
    for (const lv of levas) {
      const statusAt = lv.at ? new Date(lv.at).getTime() : null;
      if (!statusAt) continue;
      const horas = Math.floor((Date.now() - statusAt) / 3600000);

      // Pega a regra mais severa que se aplica (urgente tem prioridade)
      const regrasAplicaveis = REGRAS.filter(r => r.status === lv.status && horas >= r.horasMin);
      if (regrasAplicaveis.length === 0) continue;
      const regra = regrasAplicaveis[regrasAplicaveis.length - 1]; // última = mais severa
      avisos.push({ regra, nome: (saved.nome || def.nome) + (lv.leva === 2 ? ' (2ª leva)' : ''), horas, key, leva: lv.leva });
    }
  }

  if (avisos.length === 0) {
    alertEl.style.display = 'none';
    alertEl.innerHTML = '';
    return;
  }

  // Agrupa por regra para exibir blocos separados
  const blocos = {};
  avisos.forEach(a => {
    const k = a.regra.status + '_' + a.regra.horasMin;
    if (!blocos[k]) blocos[k] = { regra: a.regra, itens: [] };
    blocos[k].itens.push(a);
  });

  // Formata horas em dias: inteiro vira "2 dias", fracionário "2,5 dias"; singular "1 dia"
  const fmtDias = (h, arredondar) => {
    const d = arredondar ? Math.round((h / 24) * 10) / 10 : Math.floor(h / 24);
    const txt = Number.isInteger(d) ? String(d) : d.toFixed(1).replace('.', ',');
    return `${txt} ${d === 1 ? 'dia' : 'dias'}`;
  };

  alertEl.style.display = '';
  alertEl.innerHTML = Object.values(blocos).map(b => {
    const r = b.regra;
    const titulo = r.status === 'Em corte'
      ? `${r.urgente ? '🔴' : '⚠️'} Altera peças em corte há mais de ${fmtDias(r.horasMin, true)}`
      : r.urgente
        ? `🔴 Lembrete — confirmar ${r.proxStatus.toLowerCase()} (aguardando há +12h)`
        : '⚠️ Tecido comprado — confirmar início do corte';
    return `
      <div style="background:${r.bg};border:1px solid ${r.borda};border-left:4px solid ${r.borda};border-radius:6px;padding:12px 16px;margin-bottom:8px">
        <div style="font-size:11px;font-weight:800;color:${r.txtTitulo};letter-spacing:0.06em;text-transform:uppercase;margin-bottom:8px">${titulo}</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${b.itens.map(v => `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
              <div>
                <span style="font-size:13px;font-weight:700;color:#111">${v.nome}</span>
                <span style="font-size:11px;color:${r.txtInfo};margin-left:8px">em "${r.status}" há <strong>${fmtDias(v.horas)}</strong></span>
              </div>
              <button onclick="confirmarStatus('${v.key}', '${r.proxStatus}', ${v.leva || 1})"
                style="background:${r.cor};color:${r.cor === '#f59e0b' ? '#111' : '#fff'};border:none;border-radius:4px;padding:5px 14px;font-size:11px;font-weight:800;cursor:pointer;letter-spacing:0.04em;white-space:nowrap">
                ${r.emoji} ${r.label}
              </button>
            </div>`).join('')}
        </div>
      </div>`;
  }).join('');
}

// Aviso do que a baixa automática tirou do estoque. A baixa é automática de propósito
// (a peça já saiu fisicamente), mas nunca silenciosa: o estoque é editável à mão, então
// se algo aqui estiver errado dá para corrigir na tabela do modelo.
function renderAvisoBaixaAuto() {
  const el = document.getElementById('aviso-baixa-auto');
  if (!el) return;
  const b = _ultimaBaixaAuto;
  if (!b || !b.pecas.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const sizeLabel = (key, i) => (MODELOS[key] && MODELOS[key].tamanhoUnico) ? 'Único'
    : (((MODELOS[key] && MODELOS[key].tamanhos) || ['PP','P','M','G','GG'])[i] || '—');
  const hora = new Date(b.quando).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  el.style.display = '';
  el.innerHTML = `
    <div style="background:rgba(22,163,74,.08);border-left:3px solid #16a34a;border-radius:8px;padding:8px 12px;font-size:11px;line-height:1.7">
      <b style="color:#16a34a"><i class="ti ti-package-export"></i> BAIXA DE ESTOQUE APLICADA ${esc(hora)}</b>
      — pedido(s) ${esc(b.pedidos.join(', '))} foram processados e as peças saíram do estoque:
      ${b.pecas.map(p => `<b>${esc(p.nome)}</b> ${esc(p.cor)} ${esc(sizeLabel(p.key, p.tam))}${p.qtd > 1 ? ' ×' + p.qtd : ''}`).join(' · ')}
    </div>`;
}

function renderDashboard() {
  document.getElementById('model-title').innerHTML = '';
  document.getElementById('model-sub').textContent = '';
  document.getElementById('topbar-actions').style.display = 'none';
  document.getElementById('tabs-modelo').style.display = 'none';
  renderAvisoBaixaAuto();

  const modelData = [];
  for (const [key, def] of Object.entries(MODELOS)) {
    if (CONJUNTO_PECAS[key]) continue; // Conjuntos excluídos — peças já contadas individualmente
    const saved = loadLocal('vc:' + key) || {};
    const cores = coresDoModelo(def, saved);
    const tuMD = !!def.tamanhoUnico;
    let pedidos = 0, estoque = 0, produzir = 0;
    cores.forEach(cor => {
      const ab = def.aberto && def.aberto[cor] || [0,0,0,0,0];
      const ev = saved.est && saved.est[cor] || [0,0,0,0,0];
      const pv = prodTotalCor(saved, cor); // leva 1 + leva 2
      pedidos  += ab.reduce((a,b) => a+b, 0);
      estoque  += tuMD ? (ev[0]||0) : ev.reduce((a,b) => a+b, 0);
      produzir += calcFaltaLiquido(ab, ev, pv, tuMD);
    });
    modelData.push({ key, nome: def.nome, pedidos, estoque, produzir });
  }

  // ── Card urgentes ──────────────────────────────────────────────────────────
  const urgentesEl    = document.getElementById('dash-urgentes');
  const urgentesTotEl = document.getElementById('dash-urgentes-total');
  if (urgentesEl) {
    const STATUS_VALIDOS = ['Comprando tecido', 'Em corte', 'Em costura'];
    const urgList = [];

    for (const [key, def] of Object.entries(MODELOS)) {
      if (CONJUNTO_PECAS[key]) continue;
      const saved      = loadLocal('vc:' + key) || {};
      const cores      = coresDoModelo(def, saved);
      const tu         = !!def.tamanhoUnico || ehNumeracao(def); // calçado (numeração) → exibe só total; G1 tem coluna própria
      const statusNorm = STATUS_VALIDOS.includes(saved.status) ? saved.status : '';
      // Cálculo: Pedidos − Estoque − Em Produção (líquido que realmente falta produzir).
      // O que já está coberto pela produção zera e some; o que sobrou aparece,
      // mesmo que o modelo já tenha algo em produção (status na coluna ao lado).
      const sizes = new Array(GRADE_ROUPA.length).fill(0); // PP..GG + G1
      let total   = 0;
      cores.forEach(cor => {
        const szLen = def.tamanhos?.length || 5;
        const ab = (def.aberto[cor] || []).concat(new Array(szLen).fill(0)).slice(0, szLen);
        const ev = ((saved.est && saved.est[cor]) || []).concat(new Array(szLen).fill(0)).slice(0, szLen);
        const pv = (prodTotalCor(saved, cor) || []).concat(new Array(szLen).fill(0)).slice(0, szLen); // leva 1 + leva 2
        if (tu) {
          // tamanhoUnico ou tamanhos customizados: exibe só total
          const abTot = ab.reduce((a,b) => (a||0)+(b||0), 0);
          const evTot = def.tamanhoUnico ? (ev[0]||0) : ev.reduce((a,b) => (a||0)+(b||0), 0);
          const pvTot = pv.reduce((a,b) => (a||0)+(b||0), 0);
          const falta = Math.max(0, abTot - evTot - pvTot);
          sizes[0] += falta;
          total    += falta;
        } else {
          ab.forEach((a,i) => {
            const falta = Math.max(0, (a||0) - (ev[i]||0) - (pv[i]||0));
            sizes[i] += falta;
            total    += falta;
          });
        }
      });
      if (total > 0) urgList.push({ key, nome: def.nome, total, sizes, tu, status: '—' });
    }

    urgList.sort((a,b) => b.total - a.total);

    if (urgentesTotEl) urgentesTotEl.textContent = urgList.length > 0 ? urgList.reduce((s,u) => s + u.total, 0) + ' peças no total' : '';

    if (urgList.length === 0) {
      urgentesEl.innerHTML = '<div style="font-size:12px;color:var(--text-ter);padding:8px 0">Nenhuma peça urgente — produção em dia! 🎉</div>';
    } else {
      urgentesEl.innerHTML = `
        <table>
          <thead><tr>
            <th style="text-align:left">Modelo</th>
            <th style="text-align:left">Status</th>
            ${GRADE_ROUPA.map(s => `<th>${s}</th>`).join('')}
            <th>Total</th>
          </tr></thead>
          <tbody>
            ${urgList.map(u => `
              <tr style="cursor:pointer" onclick="abrirModeloPorNome('${u.nome.replace(/'/g,"\\'")}')">
                <td style="font-weight:600">${u.nome}</td>
                <td style="font-size:11px;color:var(--text-sec)">${u.status || '—'}</td>
                ${u.tu
                  ? `<td colspan="${GRADE_ROUPA.length}" style="text-align:center;color:var(--text-ter)">${MODELOS[u.key]?.tamanhos ? 'Numeração' : 'Tam. único'}</td>`
                  : u.sizes.map(v => `<td class="${v>0?'saldo-falta':''}">${v||'—'}</td>`).join('')
                }
                <td style="font-weight:700;color:#dc2626">${u.total}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    }
  }
  // ───────────────────────────────────────────────────────────────────────────

  // ── Card Produção acima do necessário ────────────────────────────────────────
  // Alerta anti-duplicação: leva 1 + leva 2 produzindo MAIS do que Pedidos − Estoque.
  // Normalmente é leva antiga que ficou congelada depois que entrou estoque ou que a
  // outra leva assumiu o pedido — o tecido dessas peças seria comprado à toa.
  const dupEl    = document.getElementById('dash-duplicado');
  const dupTotEl = document.getElementById('dash-duplicado-total');
  const dupCard  = document.getElementById('card-duplicado');
  if (dupEl) {
    const dupList = [];
    for (const [key, def] of Object.entries(MODELOS)) {
      if (CONJUNTO_PECAS[key]) continue;
      const saved = loadLocal('vc:' + key) || {};
      const cores = coresDoModelo(def, saved);
      const tuD   = !!def.tamanhoUnico;
      const szLen = def.tamanhos?.length || 5;
      const det   = [];
      let sobra = 0;
      cores.forEach(cor => {
        const nrm = o => ((o || []).map(v => v || 0)).concat(new Array(szLen).fill(0)).slice(0, szLen);
        const ab = nrm(def.aberto[cor]), ev = nrm(saved.est && saved.est[cor]);
        const p1 = nrm(saved.prod && saved.prod[cor]), p2 = nrm(saved.prod2 && saved.prod2[cor]);
        const som = a => a.reduce((x,y) => x+y, 0);
        let s = 0;
        if (tuD) {
          s = Math.max(0, som(p1) + som(p2) - Math.max(0, som(ab) - (ev[0]||0)));
        } else {
          s = ab.reduce((acc,_,i) => acc + Math.max(0, (p1[i]+p2[i]) - Math.max(0, ab[i] - ev[i])), 0);
        }
        if (s > 0) { sobra += s; det.push(`${cor} ${s}`); }
      });
      if (sobra > 0) dupList.push({ key, nome: def.nome, sobra, det: det.join(' · ') });
    }
    dupList.sort((a,b) => b.sobra - a.sobra);
    const totalSobra = dupList.reduce((s,x) => s + x.sobra, 0);
    if (dupCard) dupCard.style.display = dupList.length ? '' : 'none';
    if (dupTotEl) dupTotEl.textContent = totalSobra > 0 ? totalSobra + ' peças a mais' : '';
    dupEl.innerHTML = dupList.length === 0 ? '' : `
      <div style="font-size:11px;color:var(--text-sec);margin-bottom:6px">
        Estas levas estão com mais peças do que os pedidos em aberto pedem (já descontado o estoque).
        Confira antes de comprar tecido — pode ser produção repetida.
      </div>
      <table>
        <thead><tr>
          <th style="text-align:left">Modelo</th>
          <th style="text-align:left">Cores</th>
          <th>A mais</th>
        </tr></thead>
        <tbody>
          ${dupList.map(x => `
            <tr style="cursor:pointer" onclick="abrirModeloPorNome('${x.nome.replace(/'/g,"\\'")}')">
              <td style="font-weight:600">${x.nome}</td>
              <td style="font-size:11px;color:var(--text-sec)">${x.det}</td>
              <td style="text-align:center;font-weight:700;color:#d97706">${x.sobra}</td>
            </tr>`).join('')}
        </tbody>
        <tfoot><tr class="total-row"><td>Total</td><td></td><td style="text-align:center">${totalSobra}</td></tr></tfoot>
      </table>`;
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Card Em Produção ─────────────────────────────────────────────────────────
  const producaoEl    = document.getElementById('dash-producao');
  const producaoTotEl = document.getElementById('dash-producao-total');
  if (producaoEl) {
    const prodList = [];
    for (const [key, def] of Object.entries(MODELOS)) {
      if (CONJUNTO_PECAS[key]) continue;
      const saved = loadLocal('vc:' + key) || {};
      const cores = coresDoModelo(def, saved);
      // Cada leva entra como linha própria, com o próprio status
      [{ prod: saved.prod, status: saved.status, leva2: false },
       { prod: saved.prod2, status: saved.status2, leva2: true }].forEach(l => {
        if (!['Comprando tecido', 'Em corte', 'Em costura'].includes(l.status)) return;
        let totalProd = 0;
        cores.forEach(cor => {
          const pv = l.prod && l.prod[cor];
          if (pv) totalProd += pv.reduce((a,b) => (a||0)+(b||0), 0);
        });
        if (totalProd > 0) prodList.push({ key, nome: def.nome, status: l.status, total: totalProd, leva2: l.leva2 });
      });
    }

    prodList.sort((a,b) => b.total - a.total);
    const totalGeral = prodList.reduce((s,p) => s + p.total, 0);
    if (producaoTotEl) producaoTotEl.textContent = totalGeral > 0 ? totalGeral + ' peças' : '';

    if (prodList.length === 0) {
      producaoEl.innerHTML = '<div style="font-size:12px;color:var(--text-ter);padding:8px 0">Nenhum modelo em produção no momento.</div>';
    } else {
      producaoEl.innerHTML = `
        <table>
          <thead><tr>
            <th style="text-align:left">Modelo</th>
            <th style="text-align:center">Status</th>
            <th style="text-align:center">Peças</th>
          </tr></thead>
          <tbody>
            ${prodList.map(p => `
              <tr style="cursor:pointer" onclick="abrirModeloPorNome('${p.nome.replace(/'/g,"\\'")}')">
                <td style="font-weight:600">${p.nome}${p.leva2 ? ' <span style="font-size:9px;background:rgba(124,58,237,0.12);color:#7C3AED;border-radius:3px;padding:1px 5px;vertical-align:middle">2ª LEVA</span>' : ''}</td>
                <td style="text-align:center;font-size:11px;color:#0891b2;font-weight:600">${p.status}</td>
                <td style="text-align:center;font-weight:700;color:#0891b2">${p.total}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr class="total-row">
              <td>Total</td>
              <td></td>
              <td style="text-align:center">${totalGeral}</td>
            </tr>
          </tfoot>
        </table>`;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Card Comprando Tecido ────────────────────────────────────────────────────
  const compraEl    = document.getElementById('dash-compra');
  const compraTotEl = document.getElementById('dash-compra-total');
  if (compraEl) {
    const compraList = [];
    for (const [key, def] of Object.entries(MODELOS)) {
      if (CONJUNTO_PECAS[key]) continue;
      const saved = loadLocal('vc:' + key) || {};
      const consumo  = saved.consumo || def.consumo;
      const preco    = saved.preco   || def.preco || 0;
      const tecido   = saved.tecido  || def.tecido;
      const cores    = coresDoModelo(def, saved);
      const tuC = !!def.tamanhoUnico;
      // Cada leva com status "Comprando tecido" vira uma linha própria.
      // Leva 1 mantém o fallback Pedidos − Estoque; a 2ª leva só conta o que foi digitado.
      const levas = [];
      if (saved.status  === 'Comprando tecido') levas.push({ prod: saved.prod,  fallback: true,  leva2: false });
      if (saved.status2 === 'Comprando tecido') levas.push({ prod: saved.prod2, fallback: false, leva2: true });
      levas.forEach(l => {
        let totalPecas = 0;
        cores.forEach(cor => {
          const pv = l.prod && l.prod[cor];
          if (pv) {
            totalPecas += pv.reduce((a,b) => a+b, 0);
          } else if (l.fallback) {
            // Fallback da leva 1: Pedidos − Estoque − 2ª leva (não recompra o que a leva 2 já produz)
            const ab = def.aberto[cor] || [0,0,0,0,0];
            const ev = saved.est && saved.est[cor] || [0,0,0,0,0];
            const p2 = saved.prod2 && saved.prod2[cor] || [];
            totalPecas += calcFaltaLeva(ab, ev, p2, tuC);
          }
        });
        const metros = totalPecas * consumo;
        const custo  = metros * preco;
        if (metros > 0) compraList.push({ key, nome: def.nome, tecido, metros, custo, preco, leva2: l.leva2 });
      });
    }

    const totalCusto = compraList.reduce((s,c) => s + c.custo, 0);
    if (compraTotEl) compraTotEl.textContent = compraList.length > 0 ? 'R$ ' + fmt(totalCusto) : '';

    if (compraList.length === 0) {
      compraEl.innerHTML = '<div style="font-size:12px;color:var(--text-ter);padding:8px 0">Nenhum modelo comprando tecido no momento.</div>';
    } else {
      compraEl.innerHTML = `
        <table>
          <thead><tr>
            <th style="text-align:left">Modelo</th>
            <th style="text-align:left">Tecido</th>
            <th>Metros</th>
            <th>Valor/m</th>
            <th>Total</th>
          </tr></thead>
          <tbody>
            ${compraList.map(c => `
              <tr style="cursor:pointer" onclick="abrirModeloPorNome('${c.nome.replace(/'/g,"\\'")}')">
                <td style="font-weight:600">${c.nome}${c.leva2 ? ' <span style="font-size:9px;background:rgba(124,58,237,0.12);color:#7C3AED;border-radius:3px;padding:1px 5px;vertical-align:middle">2ª LEVA</span>' : ''}</td>
                <td style="color:var(--text-sec)">${c.tecido}</td>
                <td style="text-align:center;font-weight:600">${c.metros.toFixed(2)}m</td>
                <td style="text-align:center;color:var(--text-ter);font-size:11px">R$ ${fmt(c.preco)}</td>
                <td style="text-align:right;font-weight:700;color:var(--gold-dark)">R$ ${fmt(c.custo)}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr class="total-row">
              <td colspan="2">Total</td>
              <td style="text-align:center">${compraList.reduce((s,c)=>s+c.metros,0).toFixed(2)}m</td>
              <td style="color:#aaa;font-style:italic">Valor variável</td>
              <td style="text-align:right;color:var(--gold-dark)">R$ ${fmt(totalCusto)}</td>
            </tr>
          </tfoot>
        </table>`;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Card Resumo de Confecção ─────────────────────────────────────────────────
  const costuraEl = document.getElementById('dash-costura');
  if (costuraEl) {
    let totalModelos = 0, totalPecas = 0;
    for (const [key, def] of Object.entries(MODELOS)) {
      if (CONJUNTO_PECAS[key]) continue;
      const saved = loadLocal('vc:' + key) || {};
      const cores = coresDoModelo(def, saved);
      const tuCst = !!def.tamanhoUnico;
      let tot = 0;
      // Leva 1 (com fallback Pedidos − Estoque) + 2ª leva (só o digitado), cada uma no próprio status
      if (saved.status === 'Comprando tecido') {
        cores.forEach(cor => {
          const pv = saved.prod && saved.prod[cor];
          if (pv) { tot += pv.reduce((a,b) => a+b, 0); }
          else {
            const ab = def.aberto[cor] || [0,0,0,0,0];
            const ev = saved.est && saved.est[cor] || [0,0,0,0,0];
            tot += calcFalta(ab, ev, tuCst);
          }
        });
      }
      if (saved.status2 === 'Comprando tecido') {
        cores.forEach(cor => {
          const pv = saved.prod2 && saved.prod2[cor];
          if (pv) tot += pv.reduce((a,b) => a+b, 0);
        });
      }
      if (tot > 0) { totalModelos++; totalPecas += tot; }
    }
    if (totalModelos === 0) {
      costuraEl.innerHTML = '<div style="font-size:12px;color:var(--text-ter);padding:4px 0">Nenhum modelo comprando tecido no momento.</div>';
    } else {
      costuraEl.innerHTML = `<div style="font-size:12px;color:var(--text-sec);padding:4px 0">${totalModelos} modelo${totalModelos>1?'s':''} · <strong>${totalPecas} peças</strong> a produzir</div>`;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // Total de PEÇAS em aberto — a fita de métricas que mostrava este número saiu do
  // painel, mas ele continua sendo a linha de baixo do mini card PEDIDOS EM ABERTO.
  // Exclui conjuntos (suas peças já são contadas individualmente após a distribuição).
  const totalPedidos = modelData.filter(m => !CONJUNTO_PECAS[m.key]).reduce((s,m) => s + m.pedidos, 0);

  verificarAvisosStatus();

  // Mais vendidos (top 5)
  const top5 = [...modelData].sort((a,b) => b.pedidos - a.pedidos).filter(m => m.pedidos > 0).slice(0, 5);
  const mvEl = document.getElementById('dash-mais-vendidos');
  if (top5.length === 0) {
    mvEl.innerHTML = '<div style="font-size:12px;color:var(--text-ter);padding:8px">Nenhum pedido em aberto.</div>';
  } else {
    const max = top5[0].pedidos;
    mvEl.innerHTML = top5.map((m, i) => `
      <div class="dash-mv-card" onclick="selectModel(null,'${m.key}')">
        <div class="dash-mv-rank">#${i+1}</div>
        <div class="dash-mv-nome">${m.nome}</div>
        <div class="dash-mv-bar-wrap"><div class="dash-mv-bar" style="width:${Math.round(m.pedidos/max*100)}%"></div></div>
        <div class="dash-mv-val">${m.pedidos} <span>pedidos</span></div>
      </div>`).join('');
  }

  // Saldo de estoque (estoque disponível além dos pedidos)
  const saldoRows = [];
  for (const [key, def] of Object.entries(MODELOS)) {
    const saved = loadLocal('vc:' + key) || {};
    const cores = coresDoModelo(def, saved);
    const tu = !!def.tamanhoUnico;
    cores.forEach(cor => {
      const ab = def.aberto && def.aberto[cor] || [0,0,0,0,0];
      const ev = saved.est && saved.est[cor] || [0,0,0,0,0];
      if (tu) {
        const saldo = (ev[0] || 0) - ab.reduce((a,b) => a+b, 0);
        if (saldo > 0) saldoRows.push({ nome: def.nome, key, cor, sizes: null, total: saldo, tu: true });
      } else {
        const sizes = ab.map((a,i) => Math.max(0, (ev[i]||0) - a));
        const total = sizes.reduce((a,b) => a+b, 0);
        if (total > 0) saldoRows.push({ nome: def.nome, key, cor, sizes, total, tu: false });
      }
    });
  }
  saldoRows.sort((a,b) => b.total - a.total);
  const saldoEl = document.getElementById('dash-saldo');
  if (saldoRows.length === 0) {
    saldoEl.innerHTML = '<tr><td colspan="8" style="text-align:center;font-size:12px;color:var(--text-ter);padding:12px">Sem saldo disponível no estoque.</td></tr>';
  } else {
    const SALDO_LIMIT = 10;
    const renderSaldoRows = (rows) => rows.map(r => {
      const sizeCells = r.tu
        ? `<td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>`
        : r.sizes.map(v => `<td style="text-align:center" class="${v > 0 ? 'saldo-ok' : ''}">${v || '—'}</td>`).join('');
      return `<tr class="dash-row" style="cursor:pointer" onclick="abrirModeloPorNome('${r.nome.replace(/'/g,"\\'")}')">
        <td style="font-weight:500">${r.nome}</td>
        <td>${r.cor}</td>
        ${sizeCells}
        <td style="text-align:center;font-weight:700;color:#16a34a">+${r.total}</td>
      </tr>`;
    }).join('');

    saldoEl.innerHTML = renderSaldoRows(saldoRows.slice(0, SALDO_LIMIT));

    if (saldoRows.length > SALDO_LIMIT) {
      const verMaisRow = document.createElement('tr');
      verMaisRow.id = 'saldo-ver-mais-row';
      verMaisRow.innerHTML = `<td colspan="8" style="text-align:center;padding:10px">
        <button onclick="expandirSaldo()" style="background:none;border:1px solid var(--border);border-radius:6px;padding:5px 16px;font-size:12px;cursor:pointer;color:var(--text-sec)">
          Ver mais ${saldoRows.length - SALDO_LIMIT} itens <i class="ti ti-chevron-down"></i>
        </button>
      </td>`;
      saldoEl.appendChild(verMaisRow);
    }
  }
  // guarda para expandir depois
  window._saldoRowsAll = saldoRows;

  // Tabela geral
  const sorted = [...modelData].sort((a,b) => b.pedidos - a.pedidos);
  const TABELA_LIMIT = 10;
  const renderTabelaRows = (rows) => rows.map(m => `
    <tr class="dash-row" style="cursor:pointer" onclick="abrirModeloPorNome('${m.nome.replace(/'/g,"\\'")}')">
      <td style="font-weight:500">${m.nome}</td>
      <td style="text-align:center" class="${m.pedidos > 0 ? 'val-areia' : ''}">${m.pedidos || '—'}</td>
      <td style="text-align:center">${m.estoque || '—'}</td>
      <td style="text-align:center" class="${m.produzir > 0 ? 'val-escuro' : ''}">${m.produzir || '—'}</td>
    </tr>`).join('');

  const tabelaEl = document.getElementById('dash-tabela');
  if (tabelaEl) {
    tabelaEl.innerHTML = renderTabelaRows(sorted.slice(0, TABELA_LIMIT));

    if (sorted.length > TABELA_LIMIT) {
      const verMaisRow = document.createElement('tr');
      verMaisRow.id = 'tabela-ver-mais-row';
      verMaisRow.innerHTML = `<td colspan="4" style="text-align:center;padding:10px">
        <button onclick="expandirTabela()" style="background:none;border:1px solid var(--border);border-radius:6px;padding:5px 16px;font-size:12px;cursor:pointer;color:var(--text-sec)">
          Ver mais ${sorted.length - TABELA_LIMIT} modelos <i class="ti ti-chevron-down"></i>
        </button>
      </td>`;
      tabelaEl.appendChild(verMaisRow);
    }
  }
  window._tabelaRowsAll = sorted;

  renderMiniCards(totalPedidos);
  renderProntosParaEnvio();
  renderCorteCostura();
}

// ─── CARD: CORTE & COSTURA (totais por etapa) ────────────────────────────────
// Soma a quantidade Em Produção dos modelos com status "Em corte" e "Em costura".
function renderCorteCostura() {
  const corteEl     = document.getElementById('dash-corte-total');
  const costuraEl   = document.getElementById('dash-costura-total');
  const corteModEl  = document.getElementById('dash-corte-modelos');
  const costuraModEl = document.getElementById('dash-costura-modelos');
  const corteListaEl   = document.getElementById('dash-corte-lista');
  const costuraListaEl = document.getElementById('dash-costura-lista');
  if (!corteEl || !costuraEl) return;

  let corte = 0, costura = 0, corteMods = 0, costuraMods = 0;
  const corteList = [], costuraList = [];
  for (const [key, def] of Object.entries(MODELOS)) {
    if (CONJUNTO_PECAS[key]) continue; // conjuntos já contados nas peças
    const saved = loadLocal('vc:' + key) || {};
    const cores = coresDoModelo(def, saved);
    // Cada leva conta na etapa do próprio status
    [{ prod: saved.prod, status: saved.status, leva2: false },
     { prod: saved.prod2, status: saved.status2, leva2: true }].forEach(l => {
      if (l.status !== 'Em corte' && l.status !== 'Em costura') return;
      let totalProd = 0;
      cores.forEach(cor => {
        const pv = l.prod && l.prod[cor];
        if (pv) totalProd += pv.reduce((a, b) => (a || 0) + (b || 0), 0);
      });
      if (totalProd <= 0) return;
      if (l.status === 'Em corte') { corte += totalProd; corteMods++; corteList.push({ key, nome: def.nome, total: totalProd, leva2: l.leva2 }); }
      else                         { costura += totalProd; costuraMods++; costuraList.push({ key, nome: def.nome, total: totalProd, leva2: l.leva2 }); }
    });
  }
  corteList.sort((a, b) => b.total - a.total);
  costuraList.sort((a, b) => b.total - a.total);

  corteEl.textContent   = corte;
  costuraEl.textContent = costura;
  if (corteModEl)   corteModEl.textContent   = corteMods   ? `${corteMods} ${corteMods === 1 ? 'modelo' : 'modelos'}`     : 'nenhum modelo';
  if (costuraModEl) costuraModEl.textContent = costuraMods ? `${costuraMods} ${costuraMods === 1 ? 'modelo' : 'modelos'}` : 'nenhum modelo';

  const listaHTML = (lista, cor) => lista.length === 0
    ? `<div style="font-size:12px;color:var(--text-ter);padding:4px 0">Nenhum modelo.</div>`
    : `<table style="width:100%;border-collapse:collapse">
        <tbody>
          ${lista.map(p => `
            <tr style="cursor:pointer;border-top:1px solid rgba(0,0,0,0.06)" onclick="abrirModeloPorNome('${p.nome.replace(/'/g,"\\'")}')">
              <td style="padding:5px 2px;font-size:13px;font-weight:600">${p.nome}${p.leva2 ? ' <span style="font-size:9px;background:rgba(124,58,237,0.12);color:#7C3AED;border-radius:3px;padding:1px 5px;vertical-align:middle">2ª LEVA</span>' : ''}</td>
              <td style="padding:5px 2px;text-align:right;font-size:13px;font-weight:700;color:${cor}">${p.total}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  if (corteListaEl)   corteListaEl.innerHTML   = listaHTML(corteList, '#7C3AED');
  if (costuraListaEl) costuraListaEl.innerHTML = listaHTML(costuraList, '#0891b2');
}

// ─── CARD: PEDIDOS PARADOS ───────────────────────────────────────────────────
// Pedido pago que não sai porque falta peça some da vista: ele não entra em
// "Prontos para envio" e nada mais o cobra. Havia pedidos de MAIO ainda abertos em
// 28/07/2026 (a dona pegou na mão, olhando a Shopify). Este card lista os pagos
// travados, do mais antigo para o mais novo, dizendo exatamente que peça segura cada um.
const PARADO_ATENCAO = 15;  // dias
const PARADO_CRITICO = 30;  // dias

function diasDesde(data) {
  if (!data) return 0;
  return Math.floor((Date.now() - new Date(data).getTime()) / 86400000);
}

// A peça que falta já está sendo produzida? Procura nas duas levas do modelo (cor+tamanho)
// e devolve a etapa em que ela está. Sem isso a dona não sabe se a peça está a caminho
// ou se foi esquecida — que é a diferença entre esperar e mandar produzir agora.
function producaoDaPeca(key, cor, tam) {
  const d = loadLocal('vc:' + key) || {};
  const i = MODELOS[key] && MODELOS[key].tamanhoUnico ? 0 : tam;
  const levas = [
    { prod: d.prod,  status: d.status,  nome: '1ª leva' },
    { prod: d.prod2, status: d.status2, nome: '2ª leva' },
  ];
  let qtd = 0, etapas = [];
  levas.forEach(l => {
    const v = ((l.prod && l.prod[cor]) || [])[i] || 0;
    if (v > 0) { qtd += v; if (l.status) etapas.push(l.status); }
  });
  if (qtd === 0) return { qtd: 0, etapa: null };
  // mostra a etapa mais adiantada quando as duas levas têm a peça
  const ORDEM = ['Comprando tecido', 'Em corte', 'Em costura'];
  const etapa = etapas.sort((a, b) => ORDEM.indexOf(b) - ORDEM.indexOf(a))[0] || 'sem status';
  return { qtd, etapa };
}

function renderPedidosParados() {
  const el    = document.getElementById('dash-parados');
  const totEl = document.getElementById('dash-parados-total');
  const card  = document.getElementById('card-parados');
  if (!el) return;

  const lista = (window._pedidosPendentes || [])
    .map(p => ({ ...p, dias: diasDesde(p.data) }))
    .filter(p => p.dias >= PARADO_ATENCAO)
    .sort((a, b) => b.dias - a.dias);

  if (card) card.style.display = lista.length ? '' : 'none';
  const criticos = lista.filter(p => p.dias >= PARADO_CRITICO).length;
  if (totEl) totEl.textContent = lista.length
    ? `${lista.length} pedido${lista.length > 1 ? 's' : ''}${criticos ? ` · ${criticos} com +${PARADO_CRITICO} dias` : ''}` : '';
  if (lista.length === 0) { el.innerHTML = ''; return; }

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const sizeLabel = (key, tam) => {
    const def = MODELOS[key];
    if (def && def.tamanhoUnico) return 'Único';
    return ((def && def.tamanhos) || ['PP','P','M','G','GG'])[tam] || '—';
  };
  const fmtData = d => d ? new Date(d).toLocaleDateString('pt-BR', { day:'2-digit', month:'short' }) : '—';
  // Em modelo de tamanho único o rótulo "Único" só ocupa espaço — o modelo já diz isso
  const nomePeca = f => {
    const tam = MODELOS[f.key] && MODELOS[f.key].tamanhoUnico ? '' : ' ' + sizeLabel(f.key, f.tam);
    return `${MODELOS[f.key] ? MODELOS[f.key].nome : f.key} ${f.cor}${tam}`;
  };
  const faltamPecas = p => (p.faltas || []).reduce((s, f) => s + f.falta, 0);

  // Selo do estado de produção da peça que falta
  const seloProducao = f => {
    const pr = producaoDaPeca(f.key, f.cor, f.tam);
    if (!pr.qtd) return `<span style="font-size:9px;background:rgba(220,38,38,.12);color:#dc2626;border-radius:3px;padding:1px 5px;font-weight:700;white-space:nowrap">NÃO ESTÁ NA PRODUÇÃO</span>`;
    return `<span style="font-size:9px;background:rgba(8,145,178,.12);color:#0891b2;border-radius:3px;padding:1px 5px;font-weight:700;text-transform:uppercase;white-space:nowrap">${esc(pr.etapa)}${pr.qtd > 1 ? ' ×' + pr.qtd : ''}</span>`;
  };

  // Ranking das peças que mais travam pedidos: uma peça pode ser o único impedimento de
  // vários pedidos ao mesmo tempo — produzir ela primeiro libera mais gente de uma vez.
  const bloqueio = {};
  lista.forEach(p => (p.faltas || []).forEach(f => {
    const n = nomePeca(f);
    if (!bloqueio[n]) {
      const pr = producaoDaPeca(f.key, f.cor, f.tam);
      bloqueio[n] = { pecas: 0, pedidos: [], maisAntigo: 0, emProducao: pr.qtd > 0, etapa: pr.etapa };
    }
    bloqueio[n].pecas += f.falta;
    bloqueio[n].pedidos.push(p.numero);
    bloqueio[n].maisAntigo = Math.max(bloqueio[n].maisAntigo, p.dias);
  }));
  const todosBloqueios = Object.entries(bloqueio).map(([nome, b]) => ({ nome, ...b }));
  const porRelevancia = (a, b) => (b.pedidos.length - a.pedidos.length) || (b.maisAntigo - a.maisAntigo);
  // TODAS as peças fora de produção — ninguém está fazendo, então só saem se entrarem na fila.
  // Sem limite: é a lista de trabalho que precisa ser mandada produzir.
  const foraDeProducao = todosBloqueios.filter(b => !b.emProducao).sort(porRelevancia);
  // Já em produção: só as que destravam mais de um pedido (as demais saem sozinhas)
  const jaEmProducao = todosBloqueios.filter(b => b.emProducao && b.pedidos.length > 1)
    .sort(porRelevancia).slice(0, 5);
  const paradasSemProducao = foraDeProducao.reduce((s, b) => s + b.pecas, 0);
  const umaPecaSo = lista.filter(p => faltamPecas(p) === 1).length;

  el.innerHTML = `
    <style>
      #dash-parados .vc-falta { white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
      @media (max-width: 980px) { #dash-parados .vc-falta { white-space:normal; overflow:visible } }
    </style>
    <div style="font-size:11px;color:var(--text-sec);margin-bottom:6px">
      Pedidos pagos há ${PARADO_ATENCAO} dias ou mais que ainda não podem ser enviados. A coluna
      <b>Falta</b> mostra a peça que está segurando cada um — é o que precisa entrar na produção para liberar.
      ${umaPecaSo > 0 ? `<b style="color:#d97706">${umaPecaSo} ${umaPecaSo > 1 ? 'estão' : 'está'} a UMA peça de sair.</b>` : ''}
    </div>
    ${(foraDeProducao.length || jaEmProducao.length) ? `
      <div style="background:rgba(217,119,6,.10);border-radius:8px;padding:8px 10px;margin-bottom:10px">
        ${foraDeProducao.length ? `
          <div style="font-size:11px;font-weight:700;color:#dc2626;margin-bottom:4px">
            <i class="ti ti-alert-octagon"></i> MANDAR PRODUZIR — ${paradasSemProducao} peça(s) em ${foraDeProducao.length} item(ns), nenhuma está em leva de produção
          </div>
          <div style="font-size:11px;line-height:1.9;margin-bottom:${jaEmProducao.length ? '10' : '0'}px">
            ${foraDeProducao.map(b => `• <b>${esc(b.nome)}</b>${b.pecas > 1 ? ` ×${b.pecas}` : ''} — ${b.pedidos.length > 1 ? `destrava ${b.pedidos.length} pedidos` : 'destrava 1 pedido'} (${esc(b.pedidos.slice(0,4).join(', '))}${b.pedidos.length > 4 ? '…' : ''}), parado há ${b.maisAntigo} dias`).join('<br>')}
          </div>` : ''}
        ${jaEmProducao.length ? `
          <div style="font-size:11px;font-weight:700;color:#0891b2;margin-bottom:4px">
            <i class="ti ti-needle-thread"></i> JÁ EM PRODUÇÃO — destravam vários pedidos quando chegarem
          </div>
          <div style="font-size:11px;line-height:1.9">
            ${jaEmProducao.map(b => `• <b>${esc(b.nome)}</b>${b.pecas > 1 ? ` ×${b.pecas}` : ''} — destrava ${b.pedidos.length} pedidos (${esc(b.pedidos.slice(0,4).join(', '))}${b.pedidos.length > 4 ? '…' : ''}), parado há ${b.maisAntigo} dias <span style="font-size:9px;background:rgba(8,145,178,.12);color:#0891b2;border-radius:3px;padding:1px 5px;font-weight:700;text-transform:uppercase">já ${esc(b.etapa)}</span>`).join('<br>')}
          </div>` : ''}
      </div>` : ''}
    <table style="table-layout:fixed;width:100%">
      <colgroup>
        <col style="width:15%"><col style="width:15%"><col style="width:7%">
        <col style="width:8%"><col style="width:55%">
      </colgroup>
      <thead><tr>
        <th style="text-align:left">Pedido</th>
        <th style="text-align:left">Cliente</th>
        <th style="text-align:center">Data</th>
        <th style="text-align:center">Parado</th>
        <th style="text-align:left">Falta</th>
      </tr></thead>
      <tbody>
        ${lista.slice(0, 20).map(p => {
          const critico = p.dias >= PARADO_CRITICO;
          // cada falta numa linha só: nome + selo lado a lado, sem quebrar no meio
          const faltas = (p.faltas || []).map(f => {
            const txt = nomePeca(f) + (f.falta > 1 ? ' ×' + f.falta : '');
            // .vc-falta: uma linha só no desktop (ver <style> abaixo); em tela estreita
            // volta a quebrar, que é melhor do que cortar o nome da peça
            return `<div class="vc-falta" title="${esc(txt)}">${esc(txt)} ${seloProducao(f)}</div>`;
          });
          const soUma = faltamPecas(p) === 1;
          return `<tr>
            <td style="font-weight:600"><a href="${p.url}" target="_blank" style="color:var(--gold-dark);text-decoration:none">${esc(p.numero)}</a>${p.parcial ? ' <span style="font-size:9px;background:rgba(124,58,237,.12);color:#7C3AED;border-radius:3px;padding:1px 5px">PARCIAL</span>' : ''}${soUma ? ' <span style="font-size:9px;background:rgba(217,119,6,.15);color:#b45309;border-radius:3px;padding:1px 5px;font-weight:700">FALTA 1</span>' : ''}</td>
            <td style="font-size:11px">${esc(p.cliente || 'Cliente')}</td>
            <td style="text-align:center;font-size:11px;color:var(--text-sec)">${fmtData(p.data)}</td>
            <td style="text-align:center;font-weight:700;white-space:nowrap;color:${critico ? '#dc2626' : '#d97706'}">${p.dias} ${p.dias === 1 ? 'dia' : 'dias'}</td>
            <td style="font-size:11px;color:var(--text-sec);line-height:1.9;text-align:left">${faltas.join('') || '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    ${lista.length > 20 ? `<div style="font-size:11px;color:var(--text-ter);padding:6px 0 0">
      Mostrando os 20 mais antigos — há mais ${lista.length - 20} pedido(s) parado(s) há ${PARADO_ATENCAO} dias ou mais.</div>` : ''}`;
}

// ─── CARD: LIBERAR TROCANDO A ETIQUETA ───────────────────────────────────────
// Pedido parado esperando produção quando o tamanho VIZINHO já está na arara:
// a diferença de um tamanho pro outro dá pra resolver trocando a etiqueta, e o
// pedido sai hoje em vez de esperar a leva ficar pronta.
//
// Só entra o pedido em que a troca resolve TODAS as faltas. Meia solução não tira
// o pedido da fila — só consumiria uma peça da arara sem liberar ninguém.
//
// Modelos em que a etiqueta NÃO pode ser trocada.
const SEM_TROCA_ETIQUETA = new Set([
  'macaquinho-amplo', // etiqueta não sai — a dona não consegue remarcar
]);

// Regra ÚNICA de quem aceita troca de etiqueta. Usada pelo card do dashboard (pedidos
// parados) e pela sugestão de economia de produção na página do modelo — se as duas
// divergissem, um lugar ofereceria o que o outro proíbe.
function modeloAceitaTrocaEtiqueta(def, key, semTroca) {
  if (!def) return false;
  if (semTroca && semTroca.has(key)) return false;
  if (def.tamanhoUnico) return false; // não existe tamanho vizinho
  if (def.revenda)      return false; // calçado: 36 não vira 37 trocando etiqueta
  return true;
}

// Casa faltas com peças livres no tamanho VIZINHO. Puro, para poder ser testado sem DOM.
// Serve tanto para "falta produzir" quanto para qualquer outra falta por tamanho.
function casarVizinhos(falta, livre, nSz) {
  const usado = new Array(nSz).fill(0);
  const out = [];
  for (let i = 0; i < nSz; i++) {
    let resta = falta[i] || 0;
    if (resta <= 0) continue;
    for (const j of [i - 1, i + 1]) {
      if (resta <= 0) break;
      if (j < 0 || j >= nSz) continue;
      const disp = (livre[j] || 0) - usado[j];
      if (disp <= 0) continue;
      const q = Math.min(resta, disp);
      usado[j] += q;
      out.push({ de: j, para: i, qtd: q });
      resta -= q;
    }
  }
  return out;
}

// Motor da troca, separado do render para poder ser testado sem DOM.
function planejarTrocaEtiqueta(pendentes, livre, modelos, semTroca, diasDe, bruto) {
  const SZ_PADRAO = ['PP', 'P', 'M', 'G', 'GG'];
  const tamsDe = key => (modelos[key] && modelos[key].tamanhos) || SZ_PADRAO;

  const podeTrocar = key => modeloAceitaTrocaEtiqueta(modelos[key], key, semTroca);

  // Ledger de trabalho = o que sobrou na arara depois de separar os pedidos prontos
  // para envio. Peça que já foi reservada para um pedido que sai hoje não aparece aqui.
  const ledger = {};
  for (const key of Object.keys(livre || {})) {
    ledger[key] = {};
    for (const cor of Object.keys(livre[key] || {})) ledger[key][cor] = (livre[key][cor] || []).map(v => v || 0);
  }
  const disp = (key, cor, i) => (ledger[key] && ledger[key][cor] && ledger[key][cor][i]) || 0;
  const baixa = (key, cor, i, q) => {
    if (!ledger[key]) ledger[key] = {};
    if (!ledger[key][cor]) ledger[key][cor] = [];
    ledger[key][cor][i] = (ledger[key][cor][i] || 0) - q;
  };
  // Em modelo de tamanho único o estoque inteiro mora na posição 0 (mesma regra do
  // card de prontos) — reservar na posição errada deixaria a peça solta na conta.
  const idxEst = (key, tam) => (modelos[key] && modelos[key].tamanhoUnico) ? 0 : tam;

  // Mais parado primeiro: se dois pedidos disputam a mesma peça da arara,
  // quem está esperando há mais tempo leva.
  const fila = (pendentes || [])
    .map(p => ({ ...p, dias: diasDe(p.data) }))
    .sort((a, b) => b.dias - a.dias);

  // PASSO 1 — reserva. Pedido travado que já tem parte das peças separadas continua
  // dono delas: só espera o resto chegar. Oferecer essa peça para outro pedido faria
  // o antigo precisar da peça de novo depois — ele atrasaria ainda mais.
  // Depois desta volta o ledger é o SALDO DISPONÍVEL de verdade: o que não está
  // prometido nem para pedido que sai hoje, nem para pedido travado.
  for (const p of fila) {
    for (const r of (p.reqs || [])) {
      const i = idxEst(r.key, r.tam);
      const tem = Math.min(r.qtd, disp(r.key, r.cor, i));
      if (tem > 0) baixa(r.key, r.cor, i, tem);
    }
  }

  // PASSO 1b — teto do saldo. O passo 1 só enxerga pedido PAGO (é o filtro do card de
  // prontos). Pedido aguardando pagamento aparece na tabela PEDIDOS EM ABERTO e ficaria
  // de fora da reserva. Então, por cor/tamanho, o que pode ser oferecido nunca passa de
  // ESTOQUE − PEDIDOS EM ABERTO — independente do status do pagamento.
  const estBruto = bruto || livre || {};
  for (const key of Object.keys(ledger)) {
    if (!podeTrocar(key)) continue;
    const aberto = (modelos[key] && modelos[key].aberto) || {};
    for (const cor of Object.keys(ledger[key])) {
      const ab = aberto[cor] || [];
      ledger[key][cor] = ledger[key][cor].map((v, i) => {
        const teto = ((estBruto[key] && estBruto[key][cor] && estBruto[key][cor][i]) || 0) - (ab[i] || 0);
        return Math.min(v, teto);
      });
    }
  }

  const liberaveis = [];
  let parciais = 0;         // a troca resolve parte das faltas, mas o pedido continua travado
  let travadosSemTroca = 0; // sairiam na troca, só que uma das peças não aceita remarcar

  // Mede um pedido contra um saldo, SEM gravar nada. Quem grava é o chamador.
  const avaliar = (p, ler) => {
    const faltas = p.faltas || [];
    if (!faltas.length) return null;

    const planos = [];
    const hold   = []; // reserva provisória do próprio pedido
    const usado  = (key, cor, i) => hold.reduce((s, h) => s + (h.key === key && h.cor === cor && h.i === i ? h.qtd : 0), 0);
    let cobriuTudo = true, cobriuAlguma = false, barradoPorModelo = false;

    for (const f of faltas) {
      if (!podeTrocar(f.key)) { cobriuTudo = false; barradoPorModelo = true; continue; }
      const nSz = tamsDe(f.key).length;
      const trocas = [];
      let resta = f.falta;
      for (const viz of [f.tam - 1, f.tam + 1]) {
        if (resta <= 0) break;
        if (viz < 0 || viz >= nSz) continue;
        const sobra = ler(f.key, f.cor, viz) - usado(f.key, f.cor, viz);
        if (sobra <= 0) continue;
        const q = Math.min(resta, sobra);
        hold.push({ key: f.key, cor: f.cor, i: viz, qtd: q });
        trocas.push({ de: viz, para: f.tam, qtd: q });
        resta -= q;
      }
      if (trocas.length) cobriuAlguma = true;
      if (resta > 0) cobriuTudo = false;
      else planos.push({ ...f, trocas });
    }
    return { planos, hold, cobriuTudo, cobriuAlguma, barradoPorModelo };
  };

  // PASSO 2 — o saldo é oferecido a TODOS os pedidos. Cada um é medido contra o saldo
  // INTEIRO, sem reservar nada: assim um pedido não some da lista só porque outro
  // também serviria para a mesma peça. Quem escolhe qual atender é a dona.
  for (const p of fila) {
    const r = avaliar(p, disp);
    if (!r) continue;
    if (!r.cobriuTudo) {
      if (r.barradoPorModelo && r.cobriuAlguma) travadosSemTroca++;
      else if (r.cobriuAlguma) parciais++;
      continue;
    }
    liberaveis.push({ ...p, planos: r.planos });
  }

  // PASSO 3 — quais dão para fazer AO MESMO TEMPO. Do mais parado para o mais novo,
  // agora dando baixa de verdade. Quem não couber CONTINUA na lista, marcado como
  // disputa: a peça é a mesma, então sai um OU outro — a lista mostra a escolha.
  const chave   = (k, c, i) => k + '|' + c + '|' + i;
  const tomador = {}; // peça → pedidos que já a levaram nesta simulação
  for (const p of liberaveis) {
    const r = avaliar(p, disp);
    if (r && r.cobriuTudo) {
      r.hold.forEach(h => {
        ledger[h.key][h.cor][h.i] -= h.qtd;
        const c = chave(h.key, h.cor, h.i);
        (tomador[c] = tomador[c] || []).push(p.numero);
      });
      p.simultaneo = true;
      p.planos = r.planos; // o que realmente sobrou para ele
    } else {
      p.simultaneo = false;
      const donos = new Set();
      p.planos.forEach(pl => pl.trocas.forEach(t =>
        (tomador[chave(pl.key, pl.cor, t.de)] || []).forEach(n => donos.add(n))));
      p.disputaCom = Array.from(donos);
    }
  }

  const simultaneos = liberaveis.filter(p => p.simultaneo).length;
  return { liberaveis, parciais, travadosSemTroca, simultaneos };
}

// Aplica no estoque a troca de etiqueta que já foi feita na peça física: a peça sai do
// tamanho antigo e entra no novo. É só isso que falta para o pedido virar enviável —
// depois disso ele aparece sozinho em PRONTOS PARA ENVIO, porque o tamanho que faltava
// passa a existir na arara.
let _ultimaTroca = null; // { numero, pecas, quando } — feedback na própria tela

// Move peças de um tamanho para o outro no estoque de um modelo/cor. É TRANSFERÊNCIA:
// o total de peças do modelo não muda, só muda de gaveta. Devolve quantas moveu — pode ser
// menos do que o pedido se a peça saiu da arara nesse meio-tempo, e NUNCA cria peça.
// Fonte única dos dois botões de troca (pedido parado no dashboard e economia de produção).
async function transferirTamanhoEstoque(key, cor, de, para, qtd) {
  const def = MODELOS[key];
  if (!def) return 0;
  const nSz   = (def.tamanhos || ['PP','P','M','G','GG']).length;
  const saved = loadLocal('vc:' + key) || {};
  if (!saved.est) saved.est = {};
  const arr = (saved.est[cor] || []).map(v => v || 0);
  while (arr.length < nSz) arr.push(0);
  if (de < 0 || de >= nSz || para < 0 || para >= nSz) return 0;

  const tem = arr[de] || 0;
  const mover = Math.min(tem, qtd);
  if (mover <= 0) return 0;

  arr[de]   = tem - mover;
  arr[para] = (arr[para] || 0) + mover;
  saved.est[cor] = arr;
  saved.est_at = saved.updated_at = new Date().toISOString();
  saveLocal('vc:' + key, saved);
  await salvarNuvem(key, saved);
  return mover;
}

async function aplicarTrocaEtiqueta(i, btn) {
  const p = (window._trocasEtiqueta || [])[i];
  if (!p) return;

  const rotulo = (key, idx) => (MODELOS[key] && MODELOS[key].tamanhoUnico) ? 'Único'
    : (((MODELOS[key] && MODELOS[key].tamanhos) || ['PP','P','M','G','GG'])[idx] || '?');
  const resumo = p.planos.flatMap(pl => pl.trocas.map(tr =>
    `• ${(MODELOS[pl.key] && MODELOS[pl.key].nome) || pl.key} ${pl.cor}: ${rotulo(pl.key, tr.de)} → ${rotulo(pl.key, tr.para)}${tr.qtd > 1 ? ' ×' + tr.qtd : ''}`)).join('\n');

  if (!confirm(`Confirma que a etiqueta JÁ foi trocada nestas peças?\n\n${resumo}\n\n`
    + `O estoque passa do tamanho antigo para o novo e o pedido ${p.numero} entra na fila de prontos para envio.`)) return;

  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.innerHTML = '<i class="ti ti-loader-2"></i>'; }

  const feitas = [], faltaram = [];
  for (const pl of p.planos) {
    const def = MODELOS[pl.key];
    if (!def) continue;
    for (const tr of pl.trocas) {
      // A peça pode ter sido usada entre a tela e o clique (outro pedido, uma baixa).
      const mover = await transferirTamanhoEstoque(pl.key, pl.cor, tr.de, tr.para, tr.qtd);
      if (mover > 0) feitas.push(`${def.nome} ${pl.cor} ${rotulo(pl.key, tr.de)}→${rotulo(pl.key, tr.para)}${mover > 1 ? ' ×' + mover : ''}`);
      if (mover < tr.qtd) faltaram.push(`${def.nome} ${pl.cor} ${rotulo(pl.key, tr.de)}${mover > 0 ? ` (faltou ${tr.qtd - mover})` : ''}`);
    }
  }

  if (feitas.length) _ultimaTroca = { numero: p.numero, pecas: feitas, quando: new Date().toISOString() };
  if (faltaram.length) {
    alert('Estas peças não estavam mais no estoque do tamanho antigo e NÃO foram trocadas:\n\n'
      + faltaram.map(f => '• ' + f).join('\n')
      + '\n\nConfira a arara e o estoque do modelo.');
  }

  if (modeloAtual === '__dashboard__') renderDashboard();
  else if (MODELOS[modeloAtual]) renderModelo(modeloAtual);
}

function renderTrocaEtiqueta() {
  const el    = document.getElementById('dash-troca');
  const totEl = document.getElementById('dash-troca-total');
  const card  = document.getElementById('card-troca-etiqueta');
  if (!el) return;

  const sizeLabel = (key, i) => ((MODELOS[key] && MODELOS[key].tamanhos) || ['PP','P','M','G','GG'])[i] || '—';

  const { liberaveis, parciais, travadosSemTroca, simultaneos } = planejarTrocaEtiqueta(
    window._pedidosPendentes || [], window._estoqueLivre || {}, MODELOS, SEM_TROCA_ETIQUETA,
    diasDesde, window._estoqueBruto || {});

  // Guarda a lista para o botão "já troquei" saber o que aplicar
  window._trocasEtiqueta = liberaveis;

  const escT = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const avisoTroca = _ultimaTroca ? `
    <div style="background:rgba(22,163,74,.10);border-left:3px solid #16a34a;border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:11px;line-height:1.6">
      <b style="color:#16a34a"><i class="ti ti-check"></i> TROCA APLICADA NO ESTOQUE</b> — pedido
      ${escT(_ultimaTroca.numero)}: ${_ultimaTroca.pecas.map(escT).join(' · ')}.
      Ele já deve aparecer em <b>PRONTOS PARA ENVIO</b>.
    </div>` : '';

  if (card) card.style.display = (liberaveis.length || _ultimaTroca) ? '' : 'none';
  if (liberaveis.length === 0) {
    el.innerHTML = avisoTroca;
    if (totEl) totEl.textContent = '';
    return;
  }

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const totPecas = liberaveis.filter(p => p.simultaneo)
    .reduce((s, p) => s + p.planos.reduce((t, pl) => t + pl.trocas.reduce((u, tr) => u + tr.qtd, 0), 0), 0);
  const atrasados = liberaveis.filter(p => p.dias >= PARADO_ATENCAO).length;
  const emDisputa = liberaveis.length - simultaneos;

  if (totEl) totEl.textContent = `${liberaveis.length} pedido${liberaveis.length > 1 ? 's' : ''} · ${totPecas} etiqueta${totPecas === 1 ? '' : 's'}`
    + (emDisputa ? ` · ${emDisputa} em disputa` : '');

  el.innerHTML = `
    ${avisoTroca}
    <div style="font-size:11px;color:var(--text-sec);margin-bottom:8px">
      Pedidos parados que <b>saem hoje</b> — a peça que falta tem o tamanho vizinho na arara e a
      diferença de um tamanho pro outro se resolve trocando a etiqueta. Só aparece quando a troca
      resolve o pedido inteiro, e só usa <b>saldo disponível</b> — nunca passa de
      <b>estoque − pedidos em aberto</b> daquela cor e tamanho, então não tira peça de
      pedido nenhum, pago ou aguardando pagamento.
      ${atrasados ? `<b style="color:#0d9488">${atrasados} ${atrasados > 1 ? 'estão parados' : 'está parado'} há ${PARADO_ATENCAO} dias ou mais.</b>` : ''}
      <span style="color:var(--text-ter)">Macaquinho Amplo fica de fora (etiqueta não pode ser trocada).</span>
    </div>
    ${emDisputa ? `
      <div style="background:rgba(217,119,6,.10);border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:11px;line-height:1.6">
        <b style="color:#b45309"><i class="ti ti-arrows-split"></i> ${emDisputa} pedido(s) marcados como DISPUTA</b> —
        a lista mostra <b>todos</b> os pedidos que essa peça atenderia, não só o mais antigo. Quando dois
        aparecem disputando a mesma peça, só <b>um</b> pode levar: escolha qual e o outro volta a esperar produção.
        ${simultaneos ? `Os ${simultaneos} sem marca de disputa podem sair <b>todos juntos</b>.` : ''}
      </div>` : ''}
    ${(parciais || travadosSemTroca) ? `
      <div style="font-size:11px;color:var(--text-ter);margin-bottom:8px">
        ${parciais ? `${parciais} pedido(s) a troca resolveria só em parte — continuam esperando produção.` : ''}
        ${travadosSemTroca ? `${travadosSemTroca} pedido(s) sairiam na troca, mas travam numa peça que não aceita remarcar.` : ''}
      </div>` : ''}
    <table style="table-layout:fixed;width:100%">
      <colgroup><col style="width:14%"><col style="width:15%"><col style="width:9%"><col style="width:47%"><col style="width:15%"></colgroup>
      <thead><tr>
        <th style="text-align:left">Pedido</th>
        <th style="text-align:left">Cliente</th>
        <th style="text-align:center">Parado</th>
        <th style="text-align:left">Troca a fazer</th>
        <th style="text-align:center">Já troquei</th>
      </tr></thead>
      <tbody>
        ${liberaveis.map((p, idx) => {
          const critico = p.dias >= PARADO_CRITICO;
          const linhas = p.planos.map(pl => {
            const nome = (MODELOS[pl.key] && MODELOS[pl.key].nome) || pl.key;
            const trs = pl.trocas.map(tr =>
              `<span style="white-space:nowrap"><b>${esc(sizeLabel(pl.key, tr.de))}</b> <i class="ti ti-arrow-right" style="font-size:11px;vertical-align:-1px;color:#0d9488"></i> <b style="color:#0d9488">${esc(sizeLabel(pl.key, tr.para))}</b>${tr.qtd > 1 ? ` ×${tr.qtd}` : ''}</span>`
            ).join(' · ');
            return `<div style="padding:2px 0">${esc(nome)} <span style="color:var(--text-sec)">${esc(pl.cor)}</span> — ${trs}</div>`;
          }).join('');
          // Disputa: a peça que atende este pedido também atende outro. Sai um OU outro.
          const badgeDisputa = p.simultaneo ? '' :
            ` <span style="font-size:9px;background:rgba(217,119,6,.15);color:#b45309;border-radius:3px;padding:1px 5px;font-weight:700;white-space:nowrap" title="${esc((p.disputaCom || []).join(', '))}">DISPUTA${(p.disputaCom || []).length ? ' C/ ' + esc(p.disputaCom.slice(0, 2).join(', ')) : ''}</span>`;
          return `<tr${p.simultaneo ? '' : ' style="background:rgba(217,119,6,.04)"'}>
            <td style="font-weight:600">${p.url
              ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" style="color:#0d9488;text-decoration:none">${esc(p.numero)} <i class="ti ti-external-link" style="font-size:11px;vertical-align:-1px"></i></a>`
              : esc(p.numero)}${p.parcial ? ' <span style="font-size:9px;background:rgba(124,58,237,.12);color:#7C3AED;border-radius:3px;padding:1px 5px">PARCIAL</span>' : ''}${badgeDisputa}</td>
            <td style="font-size:11px">${esc(p.cliente || 'Cliente')}</td>
            <td style="text-align:center;font-weight:700;white-space:nowrap;color:${critico ? '#dc2626' : p.dias >= PARADO_ATENCAO ? '#d97706' : 'var(--text-sec)'}">${p.dias} ${p.dias === 1 ? 'dia' : 'dias'}</td>
            <td style="font-size:11px;line-height:1.7;text-align:left">${linhas}</td>
            <td style="text-align:center">
              <button class="btn-primary" style="font-size:10px;padding:5px 9px;background:#0d9488;border-color:#0d9488;white-space:nowrap"
                onclick="aplicarTrocaEtiqueta(${idx}, this)"
                title="Só depois de trocar a etiqueta na peça: move a peça do tamanho antigo para o novo no estoque e libera o pedido">
                <i class="ti ti-tag"></i> troquei
              </button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

// ─── CARD: PEDIDOS PRONTOS PARA ENVIO ────────────────────────────────────────
// Lista os pedidos da Shopify cujos itens TODOS têm estoque disponível.
// Aloca o estoque do pedido mais antigo para o mais recente, então a lista
// reflete o que pode realmente ser enviado em sequência (sem disputar a mesma peça).
// Expande um item do pedido em requisitos de estoque (conjuntos → peças individuais).
// FONTE ÚNICA: usada pelo card de prontos para envio E pela baixa automática de estoque.
// Se as duas contas divergirem, um pedido pode dar baixa numa cor e procurar estoque em
// outra — e ficar travado para sempre.
// Branca → Branco (cor própria, NÃO off white). As demais diferenças de caixa/acento são
// resolvidas por corCanonica — senão "CINZA" do pedido não acha o estoque de "Cinza".
const COR_ALIASES_DIST = { 'Branca': 'Branco' };

function requisitosDoItem(item) {
  const { modelKey, cor, tam, qtd } = item;
  if (CONJUNTO_PECAS[modelKey]) {
    return pecasDoConjunto(modelKey, cor).map(p => ({ key: p.key, cor: p.cor, tam, qtd }));
  }
  if (MODELOS[modelKey]) {
    return [{ key: modelKey, cor: corCanonica(MODELOS[modelKey], COR_ALIASES_DIST[cor] || cor), tam, qtd }];
  }
  return [];
}

// ─── ABA CORTE ───────────────────────────────────────────────────────────────
// A tela do cortador: as levas que estão com tecido sendo comprado ou já em corte,
// cada uma com a ficha para ele mesmo abrir e salvar. Antes disso a ficha só saía com
// o modelo aberto na tela da dona, e ela mandava uma a uma no WhatsApp.

// Enquanto o tecido está sendo comprado não há ficha por modelo para o cortador: ele vê
// UM total consolidado, agrupado por tecido e cor, como a Ficha de Compra do painel.
// Sem valores — a do painel tem preço do metro, subtotal e total gasto, que é conversa
// com fornecedor, não com quem corta.
//
// A regra de quantidade é a mesma da Ficha de Compra: leva com quantidade digitada usa o
// que está lá; leva 1 sem nada digitado cai no fallback Pedidos − Estoque − 2ª leva.
function comprandoTecidoConsolidado() {
  const grupos = {};   // chaveTecido → { label, cores: { cor: { pecas, metros, modelos:Set } } }
  for (const [key, def] of Object.entries(MODELOS)) {
    if (CONJUNTO_PECAS[key]) continue;
    const saved = loadLocal('vc:' + key) || {};
    const l1 = saved.status  === 'Comprando tecido';
    const l2 = saved.status2 === 'Comprando tecido';
    if (!l1 && !l2) continue;
    const consumo = saved.consumo || def.consumo || 0;
    const tecido  = (saved.tecido || def.tecido || 'Não especificado').trim();
    const chave   = normalizarTecido(tecido);
    const tu      = !!def.tamanhoUnico;
    if (!grupos[chave]) grupos[chave] = { label: labelTecido(tecido), cores: {} };
    coresDoModelo(def, saved).forEach(cor => {
      let pecas = 0;
      if (l1) {
        const pv = saved.prod && saved.prod[cor];
        if (pv) pecas += pv.reduce((a, b) => a + (b || 0), 0);
        else {
          const ab = def.aberto[cor] || [0,0,0,0,0];
          const ev = (saved.est && saved.est[cor]) || [0,0,0,0,0];
          const p2 = (saved.prod2 && saved.prod2[cor]) || [];
          pecas += calcFaltaLeva(ab, ev, p2, tu);
        }
      }
      if (l2) {
        const pv2 = saved.prod2 && saved.prod2[cor];
        if (pv2) pecas += pv2.reduce((a, b) => a + (b || 0), 0);
      }
      if (pecas === 0) return;
      const c = grupos[chave].cores[cor] || (grupos[chave].cores[cor] = { pecas: 0, metros: 0, modelos: new Set() });
      c.pecas  += pecas;
      c.metros += pecas * consumo;
      c.modelos.add(saved.nome || def.nome);
    });
  }
  const lista = Object.values(grupos)
    .map(g => ({
      tecido: g.label,
      cores: Object.entries(g.cores).map(([cor, c]) => ({ cor, ...c, modelos: [...c.modelos] }))
                                     .sort((a, b) => b.pecas - a.pecas),
    }))
    .filter(g => g.cores.length);
  lista.forEach(g => {
    g.pecas  = g.cores.reduce((s, c) => s + c.pecas, 0);
    g.metros = g.cores.reduce((s, c) => s + c.metros, 0);
  });
  lista.sort((a, b) => b.metros - a.metros);
  return lista;
}

function gerarFichaCorteTotal() {
  const grupos = comprandoTecidoConsolidado();
  if (!grupos.length) { alert('Nenhum modelo com tecido sendo comprado no momento.'); return; }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const hoje = new Date().toLocaleDateString('pt-BR');
  const nMetros = v => v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const totalPecas  = grupos.reduce((s, g) => s + g.pecas, 0);
  const totalMetros = grupos.reduce((s, g) => s + g.metros, 0);

  const secoes = grupos.map(g => `
    <div class="sec">
      <div class="sec-hd">
        <span>${esc(g.tecido)}</span>
        <span class="sec-tot">${g.pecas} peças · ${nMetros(g.metros)}m</span>
      </div>
      <table>
        <thead><tr><th style="text-align:left">Cor</th><th style="text-align:left">Modelos</th><th>Peças</th><th>Metros</th></tr></thead>
        <tbody>
          ${g.cores.map((c, i) => `
            <tr style="background:${i % 2 ? '#faf8f5' : '#fff'}">
              <td style="font-weight:700">${esc(c.cor)}</td>
              <td style="font-size:11px;color:#666">${esc(c.modelos.join(' · '))}</td>
              <td style="text-align:center;font-weight:700">${c.pecas}</td>
              <td style="text-align:right;font-weight:700">${nMetros(c.metros)}m</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`).join('');

  const html = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><title>Corte — Total (${esc(hoje)})</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,sans-serif;color:#111;background:#fff;font-size:13px}
  .header{background:#111;color:#fff;padding:20px 32px 16px;display:flex;justify-content:space-between;align-items:flex-end}
  .brand{font-size:8px;font-weight:700;letter-spacing:.18em;color:#C4A882;margin-bottom:6px;text-transform:uppercase}
  .titulo{font-size:26px;font-weight:900;letter-spacing:.06em;line-height:1}
  .header-meta{text-align:right;font-size:11px;color:#aaa;line-height:1.9}
  .header-meta strong{color:#C4A882}
  .resumo{background:#F5F0E8;border-bottom:2px solid #C4A882;padding:14px 32px;display:flex;gap:40px;flex-wrap:wrap}
  .rl{font-size:8px;font-weight:800;letter-spacing:.1em;color:#9a8870;text-transform:uppercase;margin-bottom:2px}
  .rv{font-size:15px;font-weight:900;color:#111}
  .body{padding:20px 32px}
  .sec{margin-bottom:22px;break-inside:avoid}
  .sec-hd{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #111;padding-bottom:5px;margin-bottom:8px}
  .sec-hd span:first-child{font-size:15px;font-weight:900;letter-spacing:.04em;text-transform:uppercase}
  .sec-tot{font-size:12px;font-weight:700;color:#9A7A56}
  table{width:100%;border-collapse:collapse}
  th{font-size:8px;font-weight:800;letter-spacing:.1em;color:#9a8870;text-transform:uppercase;padding:6px 10px;border-bottom:1px solid #e5ded2;text-align:center}
  td{padding:8px 10px;border-bottom:1px solid #f0ece6}
  .footer{background:#111;color:#666;font-size:8px;padding:8px 32px;display:flex;justify-content:space-between;letter-spacing:.06em}
  @media print{.no-print{display:none}}
</style></head><body>
  <div class="header">
    <div><div class="brand">Vista Conecte</div><div class="titulo">CORTE — TOTAL</div></div>
    <div class="header-meta">Data <strong>${esc(hoje)}</strong><br>Tecido sendo comprado</div>
  </div>
  <div class="resumo">
    <div><div class="rl">Total de peças</div><div class="rv">${totalPecas}</div></div>
    <div><div class="rl">Total de metros</div><div class="rv">${nMetros(totalMetros)}m</div></div>
    <div><div class="rl">Tecidos</div><div class="rv">${grupos.length}</div></div>
  </div>
  <div class="body">${secoes}</div>
  <div class="footer"><span>VISTA CONECTE · CORTE</span><span>${esc(hoje)}</span></div>
  <script>window.onload = () => window.print();<\/script>
</body></html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
}

function abrirCorte(item) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (item) item.classList.add('active');
  if (modeloAtual !== '__dashboard__' && MODELOS[modeloAtual] && (estEditado || prodEditado || prod2Editado || cfgEditado)) {
    clearTimeout(saveTimer); salvarModelo();
  }
  estEditado = false; prodEditado = false; prod2Editado = false; cfgEditado = false; esconderBtnSalvar();
  modeloAtual = '__corte__';
  location.hash = 'corte';
  document.getElementById('model-title').innerHTML = '<span style="font-family:\'Bebas Neue\',\'Arial Narrow\',sans-serif;font-weight:400;font-size:26px;letter-spacing:0.1em">CORTE</span>';
  document.getElementById('model-sub').textContent = '';
  document.getElementById('topbar-actions').style.display = 'none';
  document.getElementById('tabs-modelo').style.display = 'none';
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-corte').classList.add('active');
  document.body.classList.remove('precos-mode');
  renderCorte();
  crtArquivarConcluidas().catch(() => {}); // leva que saiu do corte vira histórico
  closeSidebar();
}

// ─── CARD DE AVISO (etapa que ainda não é minha) ─────────────────────────────
// Usado pelas DUAS abas de oficina: no corte, o tecido que está sendo comprado; na costura,
// o que está na mesa de corte e o tecido em compra. Fechado mostra título, total e a frase
// que explica o card — a frase fica dentro do <summary> de propósito: fechado, sem ela, o
// card é um número sem contexto. "Ver mais" ao lado da seta porque nem todo mundo entende
// que a setinha sozinha abre alguma coisa.
//
// Abrindo, sai UMA LINHA por item (nome + total), sem grade de tamanho: grade é ficha de
// trabalho, e isto aqui é aviso do que vem por aí.
function avisoLinhaHTML(nome, selo, total) {
  return `
    <div class="aviso-lin">
      <span class="aviso-nome">${nome}${selo}</span>
      <span class="aviso-item-tot">${total} ${total === 1 ? 'peça' : 'peças'}</span>
    </div>`;
}

function avisoCardHTML(icone, titulo, total, frase, linhas, extra) {
  return `
    <details class="card aviso-card">
      <summary class="aviso-sum">
        <div class="aviso-sum-hd">
          <span class="aviso-tit"><i class="ti ${icone}"></i> ${titulo}</span>
          <span class="aviso-tot">${total} ${total === 1 ? 'peça' : 'peças'}</span>
          <span class="aviso-ver"><span class="aviso-ver-mais">ver mais</span><span class="aviso-ver-menos">ver menos</span></span>
          <i class="ti ti-chevron-down aviso-seta"></i>
        </div>
        <div class="aviso-txt">${frase}</div>
      </summary>
      <div class="aviso-lista">${linhas}</div>
      ${extra || ''}
    </details>`;
}

function renderCorte() {
  const el    = document.getElementById('corte-lista');
  const totEl = document.getElementById('corte-total');
  if (!el) return;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

  // Ficha por modelo é só de quem já está EM CORTE — é o que ele corta agora.
  let levas = [];
  for (const [key, def] of Object.entries(MODELOS)) {
    if (CONJUNTO_PECAS[key]) continue; // conjunto não é peça de corte
    const saved = loadLocal('vc:' + key) || {};
    const SZ = tamanhosDe(def);
    [{ prod: saved.prod,  status: saved.status,  at: saved.status_at,  prazo: saved.prazo,  n: 1 },
     { prod: saved.prod2, status: saved.status2, at: saved.status2_at, prazo: saved.prazo2, n: 2 }].forEach(l => {
      if (l.status !== 'Em corte' || !l.prod) return;
      const linhas = [];
      let total = 0;
      Object.entries(l.prod).forEach(([cor, vals]) => {
        const arr = Array.from({ length: SZ.length }, (_, i) => (vals || [])[i] || 0);
        const tot = arr.reduce((a, b) => a + b, 0);
        if (tot > 0) { linhas.push({ cor, arr, tot }); total += tot; }
      });
      if (total === 0) return;
      levas.push({
        key, nome: saved.nome || def.nome, leva: l.n, status: l.status, prazo: l.prazo || '',
        tecido: saved.tecido || def.tecido, SZ, linhas, total,
        at: l.at || '', // carimbo de entrada no corte = identidade desta rodada (ver crtRef)
        dias: l.at ? Math.floor((Date.now() - new Date(l.at).getTime()) / 86400000) : null,
      });
    });
  }

  // DUAS fichas ganham a tarja de prioridade, no máximo: lista em que tudo é prioridade
  // não prioriza nada. São as duas de maior score ENTRE as que têm pedido esperando (ver
  // "EM QUE ORDEM CORTAR"); da terceira em diante volta a ser a fila normal, do mais
  // parado para o menos parado, sem número e sem tarja.
  const prio = crtPrioridade();
  levas.forEach(l => { l.p = crtPrioridadeDe(l.key, prio); });
  const prioritarias = levas.filter(l => l.p.pedidos > 0)
                            .sort((a, b) => b.p.score - a.p.score)
                            .slice(0, 2);
  const marcadas = new Set(prioritarias);
  prioritarias.forEach(l => { l.prioritaria = true; });
  levas = prioritarias.concat(
    levas.filter(l => !marcadas.has(l)).sort((a, b) => (b.dias ?? -1) - (a.dias ?? -1))
  );

  // Tecido em compra: um bloco só, consolidado, sem ficha por modelo
  const compra = comprandoTecidoConsolidado();
  const compraPecas  = compra.reduce((s, g) => s + g.pecas, 0);
  const compraMetros = compra.reduce((s, g) => s + g.metros, 0);
  const nMetros = v => v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  const totalPecas = levas.reduce((s, l) => s + l.total, 0);
  if (totEl) {
    totEl.textContent = levas.length
      ? `${levas.length} ficha${levas.length > 1 ? 's' : ''} para cortar · ${totalPecas} peças`
      : (compra.length ? 'nada para cortar ainda' : '');
  }

  // Mesmo card de aviso da aba COSTURA (15/08): fechado, mostrando total e frase, abrindo em
  // uma linha por tecido. A Ficha total continua aqui dentro — é o papel que ele leva para a
  // compra —, mas fora do <summary>, senão o clique no botão abriria e fecharia o card.
  const blocoCompra = compra.length === 0 ? '' : avisoCardHTML(
    'ti-shopping-cart', 'TECIDO SENDO COMPRADO', compraPecas,
    `Ainda não é para cortar — é o que vem por aí. ${nMetros(compraMetros)}m no total.`,
    compra.map(g => avisoLinhaHTML(esc(g.tecido), '', g.pecas)).join(''),
    `<div style="margin-top:10px">
       <button class="btn-outline" style="font-size:11px;padding:5px 10px" onclick="gerarFichaCorteTotal()">
         <i class="ti ti-file-text"></i> Ficha total
       </button>
     </div>`);

  if (levas.length === 0) {
    el.innerHTML = blocoCompra + '<div style="font-size:14px;color:var(--text-ter);padding:10px 0">'
      + (compra.length ? 'Nenhuma ficha em corte no momento — assim que o tecido chegar, as fichas aparecem aqui.'
                       : 'Nenhuma ficha para cortar no momento. 👍') + '</div>' + crtHistoricoHTML();
    return;
  }

  // Uma ficha por linha, ocupando a largura toda (ver .crt-grid no style.css).
  el.innerHTML = blocoCompra + '<div class="crt-grid">' + levas.map((l, pos) => {
    const cor = '#7C3AED'; // roxo do "Em corte", igual ao resto do app
    const prazoTxt = l.prazo ? new Date(l.prazo + 'T12:00:00').toLocaleDateString('pt-BR') : '—';
    const reg = crtRegistro(l.key, l.leva, l.at); // o que ele já anotou nesta rodada
    return `
      <div class="crt-card">
        <div class="crt-card-hd">
          <div>
            <div class="crt-nome">${l.prioritaria ? `<span class="crt-pos${pos === 0 ? ' crt-pos-1' : ''}">${pos + 1}º</span>` : ''}${esc(l.nome)}${l.leva === 2 ? ' <span class="crt-selo">2ª LEVA</span>' : ''}</div>
            ${l.prioritaria ? crtMotivoHTML(l.p, 'CORTAR PRIMEIRO') : ''}
            <div class="crt-meta">
              <span style="color:${cor};font-weight:700">${esc(l.status)}</span>
              ${l.dias !== null ? ` · há ${l.dias} ${l.dias === 1 ? 'dia' : 'dias'}` : ''}
              · ${esc(l.tecido || '—')} · entrega ${esc(prazoTxt)}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="text-align:right">
              <div class="crt-big">${l.total}<span> ${l.total === 1 ? 'peça' : 'peças'} pedidas</span></div>
              <div class="crt-res" id="crt-res-${l.key}-${l.leva}"></div>
            </div>
            <button class="btn-primary" style="font-size:12px;padding:7px 13px" onclick="gerarFicha('${l.key}')">
              <i class="ti ti-file-text"></i> Abrir ficha
            </button>
          </div>
        </div>
        <label class="crt-databar">
          <span class="crt-databar-lb">DATA DO CORTE</span>
          <input type="date" class="crt-dt" value="${esc((reg && reg.data) || '')}"
            data-key="${esc(l.key)}" data-leva="${l.leva}" data-ref="${esc(l.at)}"
            onchange="crtInput(this)">
        </label>
        <div class="crt-aviso">
          <span>Preencher o que cortou</span>
          <span id="crt-st-${l.key}-${l.leva}" class="crt-st"></span>
        </div>
        <div style="overflow-x:auto">
          <table class="crt-tab">
            <thead><tr>
              <th style="text-align:left">Cor</th>
              <th></th>
              ${l.SZ.map(s => `<th>${esc(s)}</th>`).join('')}
              <th>Tot</th>
            </tr></thead>
            ${l.linhas.map((r, ci) => {
              const cut = crtCortadoCor(reg, r.cor, l.SZ.length);
              return `
              <tbody class="crt-grp">
                <tr class="crt-lin-ped">
                  <td rowspan="2" class="crt-cor">${esc(r.cor)}</td>
                  <td class="crt-rot">PEDIDO</td>
                  ${r.arr.map(v => `<td class="crt-c${v ? '' : ' crt-zero'}">${v || '—'}</td>`).join('')}
                  <td class="crt-c crt-tot">${r.tot}</td>
                </tr>
                <tr class="crt-lin-cut">
                  <td class="crt-rot crt-rot-cut">CORTOU</td>
                  ${r.arr.map((v, i) => `<td class="crt-c crt-cel">
                    <input type="number" class="crt-in" inputmode="numeric" min="0" step="1" placeholder="—"
                      value="${cut[i] || ''}" data-key="${esc(l.key)}" data-leva="${l.leva}"
                      data-ref="${esc(l.at)}" data-cor="${esc(r.cor)}" data-i="${i}" data-ped="${v}" data-ci="${ci}"
                      oninput="crtInput(this)"></td>`).join('')}
                  <td class="crt-c crt-tot" id="crt-tot-${l.key}-${l.leva}-${ci}"></td>
                </tr>
              </tbody>`;
            }).join('')}
          </table>
        </div>
      </div>`;
  }).join('') + '</div>' + crtHistoricoHTML();

  levas.forEach(l => crtAtualizarTotais(l.key, l.leva));
}

// ─── ABA COSTURA ─────────────────────────────────────────────────────────────
// A costureira precisa de três coisas na mesma tela, nesta ordem:
//   1. o que está NA MÃO dela agora  → status "Em costura", ficha por modelo;
//   2. o que VEM POR AÍ do corte     → status "Em corte", só o total (não é dela ainda);
//   3. o que ainda é tecido comprado → status "Comprando tecido", consolidado.
// Sem 2 e 3 ela só enxerga o dia de hoje e não dá para se organizar para a semana.
//
// A aba é SÓ LEITURA de propósito (a de corte tem campo do que foi cortado): quem fecha a
// leva é a dona, quando muda o status. Perfil 'costura' não tem acesso a /api nenhuma —
// tudo aqui sai do que já veio do Supabase, igual à aba CORTE.

// Levas de um status, no formato que as duas listas da aba usam. Sozinha para poder ser
// testada fora do navegador (tests/costura.test.mjs injeta MODELOS/loadLocal/tamanhosDe).
function cstLevasDe(statusAlvo) {
  const out = [];
  for (const [key, def] of Object.entries(MODELOS)) {
    if (CONJUNTO_PECAS[key]) continue; // conjunto não é peça de oficina
    const saved = loadLocal('vc:' + key) || {};
    const SZ = tamanhosDe(def);
    [{ prod: saved.prod,  status: saved.status,  at: saved.status_at,  prazo: saved.prazo,  n: 1 },
     { prod: saved.prod2, status: saved.status2, at: saved.status2_at, prazo: saved.prazo2, n: 2 }].forEach(l => {
      if (l.status !== statusAlvo || !l.prod) return;
      const linhas = [];
      let total = 0;
      Object.entries(l.prod).forEach(([cor, vals]) => {
        const arr = Array.from({ length: SZ.length }, (_, i) => (vals || [])[i] || 0);
        const tot = arr.reduce((a, b) => a + b, 0);
        if (tot > 0) { linhas.push({ cor, arr, tot }); total += tot; }
      });
      if (total === 0) return;
      out.push({
        key, nome: saved.nome || def.nome, leva: l.n, status: l.status, prazo: l.prazo || '',
        tecido: saved.tecido || def.tecido, SZ, linhas, total,
        at: l.at || '',
        dias: l.at ? Math.floor((Date.now() - new Date(l.at).getTime()) / 86400000) : null,
      });
    });
  }
  return out;
}

function abrirCostura(item) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (item) item.classList.add('active');
  if (modeloAtual !== '__dashboard__' && MODELOS[modeloAtual] && (estEditado || prodEditado || prod2Editado || cfgEditado)) {
    clearTimeout(saveTimer); salvarModelo();
  }
  estEditado = false; prodEditado = false; prod2Editado = false; cfgEditado = false; esconderBtnSalvar();
  modeloAtual = '__costura__';
  location.hash = 'costura';
  document.getElementById('model-title').innerHTML = '<span style="font-family:\'Bebas Neue\',\'Arial Narrow\',sans-serif;font-weight:400;font-size:26px;letter-spacing:0.1em">COSTURA</span>';
  document.getElementById('model-sub').textContent = '';
  document.getElementById('topbar-actions').style.display = 'none';
  document.getElementById('tabs-modelo').style.display = 'none';
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-costura').classList.add('active');
  document.body.classList.remove('precos-mode');
  renderCostura();
  closeSidebar();
}

function renderCostura() {
  const el    = document.getElementById('costura-lista');
  const totEl = document.getElementById('costura-total');
  if (!el) return;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const nMetros = v => v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  // 1. NA MÃO DELA — mesma ordem de urgência da aba CORTE (pedido pago parado esperando a
  // peça pesa mais que "está aqui há mais tempo"). No máximo duas ganham tarja: lista em
  // que tudo é prioridade não prioriza nada.
  let levas = cstLevasDe('Em costura');
  const prio = crtPrioridade();
  levas.forEach(l => { l.p = crtPrioridadeDe(l.key, prio); });
  const prioritarias = levas.filter(l => l.p.pedidos > 0)
                            .sort((a, b) => b.p.score - a.p.score)
                            .slice(0, 2);
  const marcadas = new Set(prioritarias);
  prioritarias.forEach(l => { l.prioritaria = true; });
  levas = prioritarias.concat(
    levas.filter(l => !marcadas.has(l)).sort((a, b) => (b.dias ?? -1) - (a.dias ?? -1))
  );

  // 2. VEM DO CORTE — só o nome e quantas peças. O que o cortador já anotou ter cortado saiu
  // daqui em 15/08: é número de conferência do corte, e nesta tela vira ruído sobre um card
  // que ela abre só para saber o que está por vir.
  const emCorte = cstLevasDe('Em corte').sort((a, b) => (b.dias ?? -1) - (a.dias ?? -1));

  // 3. TECIDO EM COMPRA — um total só, agrupado por tecido, igual à aba CORTE.
  const compra = comprandoTecidoConsolidado();
  const compraPecas  = compra.reduce((s, g) => s + g.pecas, 0);
  const compraMetros = compra.reduce((s, g) => s + g.metros, 0);

  const totalPecas = levas.reduce((s, l) => s + l.total, 0);
  if (totEl) {
    totEl.textContent = levas.length
      ? `${levas.length} ficha${levas.length > 1 ? 's' : ''} · ${totalPecas} peças`
      : ((emCorte.length || compra.length) ? 'nada para costurar ainda' : '');
  }

  // A linha embaixo do nome só tem o que ela usa: há quantos dias a leva está com ela e a
  // data de entrega. Status ("Em costura"), tecido e a palavra "entrega" saíram a pedido da
  // Bárbara (15/08) — na aba de costura toda ficha está em costura, e o tecido é assunto de
  // quem compra e de quem corta, não de quem monta a peça.
  const fichas = levas.map((l, pos) => {
    const prazoTxt = l.prazo ? new Date(l.prazo + 'T12:00:00').toLocaleDateString('pt-BR') : '';
    const meta = [
      l.dias !== null ? `há ${l.dias} ${l.dias === 1 ? 'dia' : 'dias'}` : '',
      prazoTxt ? esc(prazoTxt) : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="crt-card cst-card">
        <div class="cst-ficha-hd">
          <div class="crt-nome">${l.prioritaria ? `<span class="crt-pos${pos === 0 ? ' crt-pos-1' : ''}">${pos + 1}º</span>` : ''}${esc(l.nome)}${l.leva === 2 ? ' <span class="crt-selo">2ª LEVA</span>' : ''}</div>
          ${l.prioritaria ? crtMotivoHTML(l.p, 'COSTURAR PRIMEIRO') : ''}
          <div class="crt-meta">${meta}</div>
          <div class="cst-ficha-acoes">
            <div class="crt-big">${l.total}<span> ${l.total === 1 ? 'peça' : 'peças'}</span></div>
            <button class="btn-outline" style="font-size:11px;padding:5px 10px" onclick="gerarFicha('${l.key}')">
              <i class="ti ti-file-text"></i> Abrir ficha
            </button>
          </div>
        </div>
        <div style="overflow-x:auto">
          <table class="crt-tab">
            <thead><tr>
              <th style="text-align:left">Cor</th>
              ${l.SZ.map(s => `<th>${esc(s)}</th>`).join('')}
              <th>Tot</th>
            </tr></thead>
            <tbody class="crt-grp">
              ${l.linhas.map(r => `
                <tr>
                  <td class="crt-cor">${esc(r.cor)}</td>
                  ${r.arr.map(v => `<td class="crt-c${v ? '' : ' crt-zero'}">${v || '—'}</td>`).join('')}
                  <td class="crt-c crt-tot">${r.tot}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }).join('');

  const vazio = `<div style="font-size:14px;color:var(--text-ter);padding:10px 0">`
    + ((emCorte.length || compra.length)
        ? 'Nenhuma ficha em costura no momento — o que está no corte aparece aqui assim que sair da mesa.'
        : 'Nenhuma ficha para costurar no momento. 👍')
    + '</div>';

  const cortePecas = emCorte.reduce((s, l) => s + l.total, 0);
  const blocoCorte = emCorte.length === 0 ? '' : avisoCardHTML(
    'ti-scissors', 'VEM POR AÍ — NO CORTE', cortePecas,
    'É o que está na mesa do corte, já com o tecido comprado.',
    emCorte.map(l => avisoLinhaHTML(esc(l.nome), l.leva === 2 ? ' <span class="crt-selo">2ª LEVA</span>' : '', l.total)).join(''));

  // Mesmo formato do card do corte — é a etapa anterior a ele, e ler as duas do mesmo jeito
  // é o que deixa a fila óbvia: comprando tecido → no corte → na minha máquina.
  const blocoCompra = compra.length === 0 ? '' : avisoCardHTML(
    'ti-shopping-cart', 'COMPRANDO TECIDO', compraPecas,
    `Ainda nem foi cortado — vem depois do corte. ${nMetros(compraMetros)}m no total.`,
    compra.map(g => avisoLinhaHTML(esc(g.tecido), '', g.pecas)).join(''));

  // Os dois cards de aviso moram FORA do card das fichas (elemento próprio no index.html):
  // no mesmo innerHTML eles apareciam colados no texto das fichas.
  const corteEl = document.getElementById('costura-corte');
  if (corteEl) corteEl.innerHTML = blocoCorte + blocoCompra;

  el.innerHTML = levas.length ? '<div class="crt-grid">' + fichas + '</div>' : vazio;
}

// ─── FATURAMENTO DA COSTURA ──────────────────────────────────────────────────
// Quanto vale, em R$, o que a costureira tem na máquina, o que vem por aí e o que ela já
// entregou e ainda não recebeu. O valor por peça é o campo `costura` da Precificação
// (`flxCustoModelo`), que é exatamente o que se paga por peça costurada.
//
// COMO UMA LEVA VIRA "ENTREGUE" (decisão da Bárbara, 15/08): sozinha, quando a leva DEIXA de
// estar "Em costura" — que é o que ela já faz hoje ao mudar o status. Ninguém precisa apertar
// "entreguei", e não há passo novo para esquecer.
//
// Para saber que uma leva SAIU, é preciso ter visto que ela estava lá: por isso a linha
// guarda um retrato (`abertas`) das levas em costura. A conta roda no app da DONA
// (`ehPerfilOficina()` sai fora) — o aparelho da costureira só LÊ, como no resto da oficina.
//
// O valor é CONGELADO no momento da entrega (peças × R$ da época): mexer na Precificação
// depois não pode reescrever o que já foi combinado por uma leva entregue.
//
// NÃO lança nada no Fluxo de Caixa, de propósito: o Fluxo já injeta corte+costura das peças
// VENDIDAS toda semana (ver flxVendasParaPagamentos). Lançar aqui também contaria o mesmo
// custo duas vezes. Quem decidir trocar a fonte um dia precisa desligar lá antes.
const CST_FAT_KEY  = 'costura-faturamento';
const CST_PAGAS_MAX = 300;

function cstFatTudo() {
  const d = loadLocal('vc:' + CST_FAT_KEY);
  const o = (d && typeof d === 'object') ? d : {};
  return { abertas: o.abertas || {}, aPagar: o.aPagar || {}, pagas: Array.isArray(o.pagas) ? o.pagas : [] };
}

// R$ por peça costurada, da Precificação. 0 = modelo sem valor cadastrado — a tela avisa em
// vez de somar zero em silêncio.
function cstValorPeca(key) {
  const c = flxCustoModelo(flxPrecoCfg(), key);
  return Math.round((c.costura || 0) * 100) / 100;
}

// Retrato do que está em costura AGORA, no formato guardado em `abertas`.
function cstFatAbertasAgora() {
  const out = {};
  cstLevasDe('Em costura').forEach(l => {
    out[l.key + '|' + l.leva] = {
      ref: l.at || '', nome: l.nome, pecas: l.total, unit: cstValorPeca(l.key), desde: l.at || '',
    };
  });
  return out;
}

// Compara o retrato com a realidade e devolve o objeto novo, ou null se nada mudou.
// Separada do resto para poder ser testada fora do navegador.
function cstFatAplicar(dados, atuais, agora) {
  const d = { abertas: { ...dados.abertas }, aPagar: { ...dados.aPagar }, pagas: (dados.pagas || []).slice() };
  let mudou = false;
  for (const [id, a] of Object.entries(atuais)) {
    const ant = d.abertas[id];
    if (!ant || ant.ref !== a.ref || ant.pecas !== a.pecas || ant.unit !== a.unit) {
      // Rodada NOVA da mesma leva (voltou pra costura com carimbo novo): a anterior é entrega.
      if (ant && ant.ref !== a.ref) cstFatEntregar(d, id, ant, agora);
      d.abertas[id] = a;
      mudou = true;
    }
  }
  for (const [id, ant] of Object.entries(d.abertas)) {
    if (atuais[id]) continue;          // continua na máquina
    cstFatEntregar(d, id, ant, agora); // saiu de "Em costura" = entregou
    delete d.abertas[id];
    mudou = true;
  }
  return mudou ? d : null;
}

function cstFatEntregar(d, id, ant, agora) {
  const [key, levaTxt] = id.split('|');
  const idFat = id + '|' + (ant.ref || '');
  if (d.aPagar[idFat] || d.pagas.some(p => p.id === idFat)) return; // já contabilizada
  if (!ant.pecas) return;                                           // leva vazia não vira cobrança
  d.aPagar[idFat] = {
    id: idFat, key, leva: Number(levaTxt) || 1, nome: ant.nome,
    pecas: ant.pecas, unit: ant.unit,
    valor: Math.round(ant.pecas * ant.unit * 100) / 100,
    entregue_em: agora,
  };
}

async function cstFatSincronizar() {
  if (ehPerfilOficina()) return; // o aparelho da costureira só lê
  const atuais = cstFatAbertasAgora();
  if (!cstFatAplicar(cstFatTudo(), atuais, new Date().toISOString())) return; // nada mudou: não toca na nuvem

  const nuvem = await carregarNuvem(CST_FAT_KEY);
  if (nuvem === undefined) return; // não deu para ler: tenta no próximo ciclo (nunca grava por cima às cegas)
  const base = (nuvem && typeof nuvem === 'object') ? nuvem : {};
  const novo = cstFatAplicar(
    { abertas: base.abertas || {}, aPagar: base.aPagar || {}, pagas: Array.isArray(base.pagas) ? base.pagas : [] },
    atuais, new Date().toISOString());
  if (!novo) return;
  novo.pagas = novo.pagas.slice(0, CST_PAGAS_MAX);
  novo.updated_at = new Date().toISOString();
  saveLocal('vc:' + CST_FAT_KEY, novo);
  await salvarNuvem(CST_FAT_KEY, novo);
  if (modeloAtual === '__faturamento__') renderFaturamento();
}

// Marcar pago é da DONA. O botão nem existe no aparelho da costureira, e aqui vai a trava de
// novo: quem chamar isto por outro caminho não passa.
async function cstFatPagar(id, desfazer) {
  if (ehPerfilOficina()) return;
  const nuvem = await carregarNuvem(CST_FAT_KEY);
  if (nuvem === undefined) { alert('Sem conexão com a nuvem — tente de novo em instantes.'); return; }
  const d = {
    abertas: (nuvem && nuvem.abertas) || {},
    aPagar:  (nuvem && nuvem.aPagar)  || {},
    pagas:   (nuvem && Array.isArray(nuvem.pagas)) ? nuvem.pagas : [],
  };
  if (desfazer) {
    const i = d.pagas.findIndex(p => p.id === id);
    if (i < 0) return;
    const p = d.pagas.splice(i, 1)[0];
    delete p.pago_em;
    d.aPagar[p.id] = p;
  } else {
    const p = d.aPagar[id];
    if (!p) return;
    delete d.aPagar[id];
    p.pago_em = new Date().toISOString();
    d.pagas.unshift(p);
  }
  d.pagas = d.pagas.slice(0, CST_PAGAS_MAX);
  d.updated_at = new Date().toISOString();
  saveLocal('vc:' + CST_FAT_KEY, d);
  await salvarNuvem(CST_FAT_KEY, d);
  renderFaturamento();
}

function abrirFaturamento(item) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (item) item.classList.add('active');
  if (modeloAtual !== '__dashboard__' && MODELOS[modeloAtual] && (estEditado || prodEditado || prod2Editado || cfgEditado)) {
    clearTimeout(saveTimer); salvarModelo();
  }
  estEditado = false; prodEditado = false; prod2Editado = false; cfgEditado = false; esconderBtnSalvar();
  modeloAtual = '__faturamento__';
  location.hash = 'faturamento';
  document.getElementById('model-title').innerHTML = '<span style="font-family:\'Bebas Neue\',\'Arial Narrow\',sans-serif;font-weight:400;font-size:26px;letter-spacing:0.1em">FATURAMENTO DA COSTURA</span>';
  document.getElementById('model-sub').textContent = '';
  document.getElementById('topbar-actions').style.display = 'none';
  document.getElementById('tabs-modelo').style.display = 'none';
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-faturamento').classList.add('active');
  document.body.classList.remove('precos-mode');
  renderFaturamento();
  cstFatSincronizar().catch(() => {});
  closeSidebar();
}

function renderFaturamento() {
  const el = document.getElementById('faturamento-lista');
  if (!el) return;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const dia = iso => iso ? new Date(iso).toLocaleDateString('pt-BR') : '—';
  const podePagar = !ehPerfilOficina();

  // 1. NA MÁQUINA AGORA — o que ela recebe quando entregar
  const agora = cstLevasDe('Em costura').map(l => ({
    nome: l.nome, leva: l.leva, pecas: l.total, unit: cstValorPeca(l.key),
  }));
  agora.forEach(l => { l.valor = Math.round(l.pecas * l.unit * 100) / 100; });
  const totalAgora = agora.reduce((s, l) => s + l.valor, 0);

  // 2. VEM POR AÍ — corte e tecido em compra, na ordem em que chegam até ela
  const vindo = ['Em corte', 'Comprando tecido'].flatMap(st =>
    cstLevasDe(st).map(l => ({
      nome: l.nome, leva: l.leva, etapa: st, pecas: l.total, unit: cstValorPeca(l.key),
    })));
  vindo.forEach(l => { l.valor = Math.round(l.pecas * l.unit * 100) / 100; });
  const totalVindo = vindo.reduce((s, l) => s + l.valor, 0);

  // 3. ENTREGUE E AINDA NÃO PAGO / 4. JÁ PAGO
  const d = cstFatTudo();
  const aPagar = Object.values(d.aPagar).sort((a, b) => String(a.entregue_em).localeCompare(String(b.entregue_em)));
  const pagas  = d.pagas.slice(0, 40);
  const totalAPagar = aPagar.reduce((s, p) => s + (p.valor || 0), 0);

  const semValor = agora.concat(vindo).filter(l => !l.unit).length
                 + aPagar.filter(p => !p.unit).length;

  const linhas = (arr, extra) => arr.map(l => `
    <div class="fat-lin">
      <div>
        <div class="fat-nome">${esc(l.nome)}${l.leva === 2 ? ' <span class="crt-selo">2ª LEVA</span>' : ''}</div>
        <div class="fat-sub">${l.pecas} ${l.pecas === 1 ? 'peça' : 'peças'} × ${finBRL(l.unit)}${l.unit ? '' : ' <span class="fat-alerta">sem valor na Precificação</span>'}${extra ? extra(l) : ''}</div>
      </div>
      <div class="fat-val">${finBRL(l.valor)}</div>
    </div>`).join('');

  const bloco = (cor, icone, titulo, total, frase, corpo) => `
    <div class="card fat-card" style="border-color:${cor}">
      <div class="fat-hd">
        <span class="fat-tit" style="color:${cor}"><i class="ti ${icone}"></i> ${titulo}</span>
        <span class="fat-tot" style="color:${cor}">${finBRL(total)}</span>
      </div>
      <div class="aviso-txt">${frase}</div>
      ${corpo}
    </div>`;

  el.innerHTML =
    bloco('#0891b2', 'ti-needle-thread', 'NA MÁQUINA AGORA', totalAgora,
      'É o que está em costura hoje — vira a receber quando a leva for entregue.',
      agora.length ? linhas(agora) : '<div class="fat-vazio">Nada em costura no momento.</div>')
    + bloco('#dc2626', 'ti-cash', 'ENTREGUE — A RECEBER', totalAPagar,
      'Levas que saíram da costura e ainda não foram pagas.',
      aPagar.length ? aPagar.map(p => `
        <div class="fat-lin">
          <div>
            <div class="fat-nome">${esc(p.nome)}${p.leva === 2 ? ' <span class="crt-selo">2ª LEVA</span>' : ''}</div>
            <div class="fat-sub">${p.pecas} ${p.pecas === 1 ? 'peça' : 'peças'} × ${finBRL(p.unit)} · entregue em ${dia(p.entregue_em)}</div>
          </div>
          <div class="fat-acao">
            <span class="fat-val">${finBRL(p.valor)}</span>
            ${podePagar ? `<button class="btn-outline" style="font-size:11px;padding:4px 9px" onclick="cstFatPagar('${esc(p.id)}')"><i class="ti ti-check"></i> pago</button>` : ''}
          </div>
        </div>`).join('') : '<div class="fat-vazio">Nada entregue esperando pagamento. 👍</div>')
    + bloco('#7C3AED', 'ti-scissors', 'VEM POR AÍ', totalVindo,
      'O que está no corte e o tecido em compra, pelo mesmo valor por peça.',
      vindo.length ? linhas(vindo, l => ` · ${l.etapa === 'Em corte' ? 'no corte' : 'comprando tecido'}`)
                   : '<div class="fat-vazio">Nada a caminho no momento.</div>')
    + (pagas.length ? `
      <details class="card fat-card fat-pagas">
        <summary class="aviso-sum">
          <div class="aviso-sum-hd">
            <span class="fat-tit" style="color:#16a34a"><i class="ti ti-checkbox"></i> JÁ PAGO</span>
            <span class="fat-tot" style="color:#16a34a">${finBRL(d.pagas.reduce((s, p) => s + (p.valor || 0), 0))}</span>
            <span class="aviso-ver"><span class="aviso-ver-mais">ver mais</span><span class="aviso-ver-menos">ver menos</span></span>
            <i class="ti ti-chevron-down aviso-seta"></i>
          </div>
          <div class="aviso-txt">Últimas levas quitadas.</div>
        </summary>
        ${pagas.map(p => `
          <div class="fat-lin">
            <div>
              <div class="fat-nome">${esc(p.nome)}${p.leva === 2 ? ' <span class="crt-selo">2ª LEVA</span>' : ''}</div>
              <div class="fat-sub">${p.pecas} ${p.pecas === 1 ? 'peça' : 'peças'} · pago em ${dia(p.pago_em)}</div>
            </div>
            <div class="fat-acao">
              <span class="fat-val">${finBRL(p.valor)}</span>
              ${podePagar ? `<button class="btn-outline" style="font-size:11px;padding:4px 9px" onclick="cstFatPagar('${esc(p.id)}', true)" title="Marquei pago sem querer">desfazer</button>` : ''}
            </div>
          </div>`).join('')}
      </details>` : '')
    + (semValor ? `<div class="fat-aviso-cfg"><i class="ti ti-alert-triangle"></i>
        ${semValor} ${semValor === 1 ? 'leva está' : 'levas estão'} com R$ 0 por peça — falta o valor de
        <b>costura</b> desse modelo na Precificação. Enquanto isso, ${semValor === 1 ? 'ela não soma' : 'elas não somam'} nada aqui.</div>` : '');
}

// ─── O QUE FOI REALMENTE CORTADO ─────────────────────────────────────────────
// A ficha diz o que foi PEDIDO; o que sai da mesa quase nunca é exatamente isso (rolo
// que rendeu menos, defeito no tecido, encaixe que não fechou). Aqui o cortador digita o
// que realmente cortou, tamanho a tamanho, e a ficha passa a mostrar os dois números um
// embaixo do outro — pedido em cima, cortado embaixo, com a diferença ao lado do total.
//
// Fica numa linha PRÓPRIA da tabela ('corte-realizado'), NÃO dentro de `vc:<modelo>`:
// salvarModelo() remonta o JSON do modelo a partir dos campos da tela da dona e descarta
// tudo que não esteja lá — o que o cortador digitasse sumiria no primeiro salvamento
// dela, sem erro nenhum na tela.
//
// Cada rodada de corte é identificada pelo carimbo de entrada em "Em corte"
// (`status_at`/`status2_at`). Se a leva sai do corte e volta depois, o carimbo muda e o
// registro antigo deixa de valer sozinho — ninguém precisa lembrar de zerar nada.
const CORTE_KEY = 'corte-realizado';

function crtRef(at) { return at || ''; }

function crtTudo() {
  const d = loadLocal('vc:' + CORTE_KEY);
  return (d && typeof d === 'object' && d.levas) ? d : { levas: {} };
}

// Registro desta rodada, ou null (inclusive quando o que está guardado é de uma rodada
// anterior — aí a ficha abre em branco de propósito).
function crtRegistro(key, leva, at) {
  const r = crtTudo().levas[key + '|' + leva];
  return (r && crtRef(r.ref) === crtRef(at)) ? r : null;
}

function crtCortadoCor(reg, cor, n) {
  const v = (reg && reg.cores && reg.cores[cor]) || [];
  return Array.from({ length: n }, (_, i) => v[i] || 0);
}

// Todos os inputs de um bloco (uma leva de um modelo). Filtra em JS em vez de montar
// seletor com o nome da cor dentro — cor tem espaço e acento.
function crtInputsDe(key, leva) {
  return Array.from(document.querySelectorAll('#corte-lista input.crt-in'))
    .filter(i => i.dataset.key === key && i.dataset.leva === String(leva));
}

function crtNum(inp) { return Math.max(0, parseInt(inp.value, 10) || 0); }

function crtDifHTML(cut, ped) {
  if (!cut) return '<span style="color:var(--text-ter)">—</span>'; // nada anotado ainda
  const d = cut - ped;
  const c = d === 0 ? '#16a34a' : (d < 0 ? '#dc2626' : '#7C3AED');
  return `<span style="color:${c}">${cut}</span>`
    + (d ? `<div style="font-size:11px;font-weight:800;color:${c};line-height:1.2">${d > 0 ? '+' : ''}${d}</div>` : '');
}

function crtAtualizarTotais(key, leva) {
  const porCor = {};
  let cut = 0, ped = 0;
  crtInputsDe(key, leva).forEach(inp => {
    const o = porCor[inp.dataset.ci] || (porCor[inp.dataset.ci] = { cut: 0, ped: 0 });
    const v = crtNum(inp), p = parseInt(inp.dataset.ped, 10) || 0;
    o.cut += v; o.ped += p; cut += v; ped += p;
  });
  Object.entries(porCor).forEach(([ci, o]) => {
    const td = document.getElementById(`crt-tot-${key}-${leva}-${ci}`);
    if (td) td.innerHTML = crtDifHTML(o.cut, o.ped);
  });
  const res = document.getElementById(`crt-res-${key}-${leva}`);
  if (res) {
    const falta = ped - cut;
    res.innerHTML = !cut ? '<span style="color:var(--text-ter)">nada cortado ainda</span>'
      : falta > 0 ? `<span style="color:#dc2626">cortou ${cut} · faltam ${falta}</span>`
      : falta < 0 ? `<span style="color:#7C3AED">cortou ${cut} · ${-falta} a mais</span>`
      : `<span style="color:#16a34a">cortou ${cut} · completo ✓</span>`;
  }
}

function crtStatus(key, leva, txt, erro) {
  const el = document.getElementById(`crt-st-${key}-${leva}`);
  if (!el) return;
  el.textContent = txt;
  el.style.color = erro ? '#dc2626' : 'var(--text-ter)';
}

// Enquanto ele digita (e por alguns segundos depois), o ciclo de 1 minuto não pode
// redesenhar a aba: o innerHTML novo apagaria o que está na tela sem salvar.
let _crtTimer = null;
let _crtPend = {};
let _crtUltimoInput = 0;
function crtOcupado() {
  return !!_crtTimer || Object.keys(_crtPend).length > 0 || (Date.now() - _crtUltimoInput < 8000);
}

// Serve às duas coisas que ele preenche na ficha: o que cortou (célula por tamanho) e a
// data do corte. Mesmo caminho de gravação, mesma marca de "salvando/salvo".
function crtInput(inp) {
  _crtUltimoInput = Date.now();
  const ehData = inp.classList.contains('crt-dt');
  if (!ehData && inp.value && parseInt(inp.value, 10) < 0) inp.value = ''; // não existe cortar -3
  const key = inp.dataset.key, leva = inp.dataset.leva;
  if (!ehData) crtAtualizarTotais(key, leva);
  _crtPend[key + '|' + leva] = { key, leva, ref: inp.dataset.ref };
  crtStatus(key, leva, 'salvando…');
  clearTimeout(_crtTimer);
  _crtTimer = setTimeout(crtGravar, 1200);
}

// Grava lendo a nuvem antes e mesclando só as levas mexidas: a linha é uma só para o
// sistema inteiro, e gravar o objeto local por cima apagaria a anotação de outra ficha
// feita em outro aparelho.
async function crtGravar() {
  _crtTimer = null;
  const alvos = Object.values(_crtPend);
  _crtPend = {};
  if (!alvos.length) return;

  const nuvem = await carregarNuvem(CORTE_KEY);
  if (nuvem === undefined) {
    // Não deu para LER — não grava por cima (mesma regra do histórico de versões).
    alvos.forEach(a => {
      _crtPend[a.key + '|' + a.leva] = a;
      crtStatus(a.key, a.leva, 'sem conexão — tentando de novo…', true);
    });
    clearTimeout(_crtTimer);
    _crtTimer = setTimeout(crtGravar, 5000);
    return;
  }

  const dados = (nuvem && nuvem.levas) ? nuvem : { levas: {} };
  const agora = new Date().toISOString();
  alvos.forEach(a => {
    const cores = {};
    crtInputsDe(a.key, a.leva).forEach(inp => {
      const arr = cores[inp.dataset.cor] || (cores[inp.dataset.cor] = []);
      arr[parseInt(inp.dataset.i, 10) || 0] = crtNum(inp);
    });
    Object.keys(cores).forEach(c => { cores[c] = Array.from(cores[c], v => v || 0); });
    const dt = Array.from(document.querySelectorAll('#corte-lista input.crt-dt'))
      .find(i => i.dataset.key === a.key && i.dataset.leva === String(a.leva));
    dados.levas[a.key + '|' + a.leva] = { ref: crtRef(a.ref), cores, data: (dt && dt.value) || '', at: agora };
  });
  dados.updated_at = agora;

  saveLocal('vc:' + CORTE_KEY, dados);
  await salvarNuvem(CORTE_KEY, dados);
  alvos.forEach(a => crtStatus(a.key, a.leva, 'salvo ✓'));
}

// ─── REGISTRO DO QUE FOI CORTADO ─────────────────────────────────────────────
// Até 14/08/2026 a leva ia para "Em costura" e o que tinha sido cortado ia junto: a ficha
// sumia da aba e ninguém mais sabia quanto realmente havia saído daquela rodada. Aqui,
// quando a leva deixa de estar "Em corte", o que ele anotou vira uma linha de histórico
// em vez de desaparecer.
//
// Mora na MESMA linha do Supabase do que está sendo cortado (`corte-realizado.historico`)
// — sem tabela nova e sem endpoint, que é o que o perfil do cortador consegue alcançar.
const CORTE_HIST_MAX = 200;

function crtHistorico() {
  const h = crtTudo().historico;
  return Array.isArray(h) ? h : [];
}

function crtTotalDe(cores) {
  return Object.values(cores || {})
    .reduce((s, arr) => s + (arr || []).reduce((a, b) => a + (b || 0), 0), 0);
}

// Roda ao abrir a aba e no ciclo de 1 minuto. Grava só quando alguma leva REALMENTE saiu
// do corte — no resto do tempo não toca na nuvem.
async function crtArquivarConcluidas() {
  const dados = crtTudo();
  const sair = [];
  for (const [id, r] of Object.entries(dados.levas || {})) {
    const [key, levaTxt] = id.split('|');
    const saved  = loadLocal('vc:' + key) || {};
    const status = levaTxt === '2' ? saved.status2 : saved.status;
    if (status === 'Em corte') continue; // ainda está na mesa
    const total = crtTotalDe(r.cores);
    sair.push({
      id,
      // Sem nada anotado não vira linha de histórico: só sai da lista de trabalho.
      reg: total ? {
        id:    id + '|' + crtRef(r.ref),
        key,   leva: Number(levaTxt) || 1,
        nome:  saved.nome || (MODELOS[key] && MODELOS[key].nome) || key,
        tamanhos: MODELOS[key] ? tamanhosDe(MODELOS[key]) : [],
        data:  r.data || '',
        cores: r.cores, total,
        arquivado_em: new Date().toISOString(),
      } : null,
    });
  }
  if (!sair.length) return;

  const nuvem = await carregarNuvem(CORTE_KEY);
  if (nuvem === undefined) return; // não deu para ler: tenta de novo no próximo ciclo
  const novo = (nuvem && nuvem.levas) ? nuvem : { levas: {} };
  const hist = Array.isArray(novo.historico) ? novo.historico : [];
  for (const s of sair) {
    delete novo.levas[s.id];
    // Dedup por id: dois aparelhos podem arquivar a mesma leva no mesmo minuto.
    if (s.reg && !hist.some(h => h.id === s.reg.id)) hist.unshift(s.reg);
  }
  novo.historico   = hist.slice(0, CORTE_HIST_MAX);
  novo.updated_at  = new Date().toISOString();
  saveLocal('vc:' + CORTE_KEY, novo);
  await salvarNuvem(CORTE_KEY, novo);
  if (modeloAtual === '__corte__' && !crtOcupado()) renderCorte();
}

function crtHistoricoHTML() {
  const hist = crtHistorico();
  if (!hist.length) return '';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const dia = h => {
    const d = h.data ? new Date(h.data + 'T12:00:00') : new Date(h.arquivado_em);
    return d.toLocaleDateString('pt-BR');
  };
  return `
    <div class="crt-card crt-card-hist">
      <div class="crt-card-hd">
        <div>
          <div class="crt-nome"><i class="ti ti-checkbox"></i> JÁ CORTADO</div>
          <div class="crt-meta">O que saiu de cada leva que já passou pela mesa. Toque para ver por tamanho.</div>
        </div>
        <div class="crt-big">${hist.length}<span> ${hist.length === 1 ? 'leva' : 'levas'}</span></div>
      </div>
      ${hist.slice(0, 20).map(h => `
        <details class="crt-hist">
          <summary>
            <b>${esc(dia(h))}</b> · ${esc(h.nome)}${h.leva === 2 ? ' (2ª leva)' : ''}
            <span class="crt-hist-tot">${h.total} ${h.total === 1 ? 'peça' : 'peças'}</span>
          </summary>
          <div style="overflow-x:auto">
            <table class="crt-tab">
              <thead><tr><th style="text-align:left">Cor</th>
                ${(h.tamanhos || []).map(s => `<th>${esc(s)}</th>`).join('')}
                <th>Tot</th></tr></thead>
              <tbody class="crt-grp">
                ${Object.entries(h.cores || {}).map(([cor, arr]) => `
                  <tr>
                    <td class="crt-cor">${esc(cor)}</td>
                    ${(h.tamanhos || []).map((_, i) => `<td class="crt-c${(arr || [])[i] ? '' : ' crt-zero'}">${(arr || [])[i] || '—'}</td>`).join('')}
                    <td class="crt-c crt-tot">${(arr || []).reduce((a, b) => a + (b || 0), 0)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </details>`).join('')}
    </div>`;
}

// ─── EM QUE ORDEM CORTAR ─────────────────────────────────────────────────────
// A lista saía do mais parado para o menos parado. "Parado há mais tempo" não é o mesmo
// que "mais urgente": uma leva de um modelo que ninguém está esperando ficava na frente
// de outra que, cortada hoje, faz seis pedidos pagos saírem amanhã.
//
// Duas perguntas, nesta ordem de peso:
//   1. Quanto pedido PAGO está parado esperando esta peça — e quantos desses saem no
//      mesmo dia em que ela for cortada (ela é a ÚNICA coisa que falta neles).
//   2. Quanto o modelo vende (90 dias): o que sempre sai muito não pode ficar parado nem
//      quando por acaso não tem pedido travado na fila de hoje.
//
// ONDE A CONTA RODA: no app da DONA, gravada numa linha do Supabase. A aba do cortador só
// LÊ o resultado. O perfil 'corte' não tem acesso a /api nenhuma (a allowlist do
// functions/api/_middleware.js é vazia de propósito) — ele nunca viu pedido, cliente nem
// faturamento e continua sem ver; o que chega até ele é a ordem e o motivo em uma linha.
const CORTE_PRIO_KEY      = 'corte-prioridade';
const CORTE_VENDAS_DIAS   = 90;
const CORTE_VENDAS_TTL_MS = 12 * 3600 * 1000; // busca pesada: no máximo 2x por dia

// A tarja de prioridade da ficha: a palavra e o número de pedidos esperando aquele
// modelo, e nada mais.
//
// `sozinho`, `dias` e `estrelas` continuam existindo e continuam MANDANDO na ordem
// (ver crtScore) — só não são escritos na tela. Foram até 14/08/2026 e a linha ficou
// comprida demais para quem lê em pé na mesa: quatro informações onde uma decide.
// Não apagar esses campos achando que viraram código morto.
// `verbo` é a ORDEM da aba onde a tarja aparece ("CORTAR PRIMEIRO" / "COSTURAR PRIMEIRO") —
// em vermelho, junto de PRIORIDADE, porque é a única linha da tela que manda fazer uma coisa
// antes da outra. Quantos pedidos esperam vai em PRETO logo depois: é o motivo, não a ordem,
// e em vermelho também a frase inteira vira uma mancha só e nada salta.
function crtMotivoHTML(p, verbo) {
  if (!p || !p.pedidos) return ''; // sem ninguém na fila não há o que anunciar
  const n = p.pedidos === 1 ? '1 pedido esperando' : `${p.pedidos} pedidos esperando`;
  return `<div class="crt-motivo"><b>PRIORIDADE · ${verbo || 'CORTAR PRIMEIRO'}</b>`
       + `<span class="crt-motivo-n">${n} este modelo</span></div>`;
}

function crtPrioridade() {
  const d = loadLocal('vc:' + CORTE_PRIO_KEY);
  return (d && typeof d === 'object') ? d : {};
}

// Pedidos pagos que não podem sair, agrupados pela peça que falta.
// `sozinho` = pedidos em que ESTA peça é a única coisa faltando: cortou, o pedido sai.
function crtCalcularTravados() {
  const out = {};
  for (const p of window._pedidosPendentes || []) {
    const chaves = new Set((p.faltas || []).map(f => f.key));
    if (!chaves.size) continue;
    const idade = diasDesde(p.data);
    chaves.forEach(k => {
      const o = out[k] || (out[k] = { pedidos: 0, sozinho: 0, dias: 0 });
      o.pedidos++;
      if (chaves.size === 1) o.sozinho++;
      if (idade > o.dias) o.dias = idade;
    });
  }
  return out;
}

// A venda de um CONJUNTO é venda das peças dele: sem isto a Calça Boho apareceria como
// modelo fraco enquanto o Conjunto Boho (que é quem a Shopify vende) leva o volume todo.
function crtVendasPorPeca(porModelo) {
  const out = {};
  for (const [k, un] of Object.entries(porModelo || {})) {
    const pecas = CONJUNTO_PECAS[k];
    if (pecas && pecas.length) pecas.forEach(pk => { out[pk] = (out[pk] || 0) + un; });
    else out[k] = (out[k] || 0) + un;
  }
  return out;
}

// Estrelas comparando com o campeão da própria loja, não com uma tabela fixa de unidades:
// o que é "vender muito" muda com o tamanho da operação e com a estação.
function crtEstrelas(un, maxUn) {
  if (!un || !maxUn) return 0;
  const p = un / maxUn;
  return p >= 0.5 ? 3 : p >= 0.2 ? 2 : p >= 0.05 ? 1 : 0;
}

// Os pesos são a regra de negócio, escrita à mão de propósito para dar para explicar a
// ordem olhando a tela: um pedido que sai SÓ com esta peça vale mais que um que ainda
// depende de outra; atraso conta até 30 dias (dali para cima já é tudo igualmente grave);
// e o campeão de vendas sobe mesmo sem ninguém na fila.
function crtScore(t, estrelas) {
  return (t.sozinho || 0) * 10
       + (t.pedidos || 0) * 4
       + Math.min(t.dias || 0, 30) * 1.5
       + estrelas * 6;
}

// Junta os dois sinais para um modelo. Usada no render (leitura) e na gravação.
function crtPrioridadeDe(key, prio) {
  const t   = (prio.travados && prio.travados[key]) || { pedidos: 0, sozinho: 0, dias: 0 };
  const un  = (prio.vendas && prio.vendas[key]) || 0;
  const est = crtEstrelas(un, prio.vendas_max || 0);
  return { ...t, unidades: un, estrelas: est, score: crtScore(t, est) };
}

let _crtVendasBusca = null; // evita duas buscas simultâneas no mesmo carregamento

// Busca o volume de vendas, no máximo de 12 em 12 horas. Falha de rede não derruba nada:
// a prioridade continua valendo só com os pedidos travados.
async function crtBuscarVendas(prio) {
  const fresco = prio.vendas_em && (Date.now() - Date.parse(prio.vendas_em) < CORTE_VENDAS_TTL_MS);
  if (fresco || _crtVendasBusca) return null;
  _crtVendasBusca = (async () => {
    try {
      const r = await fetch('/api/shopify-orders?vendas=' + CORTE_VENDAS_DIAS);
      if (!r.ok) return null;
      const j = await r.json();
      if (!j || !j.por_modelo) return null;
      const vendas = crtVendasPorPeca(j.por_modelo);
      return { vendas, vendas_max: Math.max(0, ...Object.values(vendas)), vendas_em: new Date().toISOString() };
    } catch (e) { return null; }
    finally { _crtVendasBusca = null; }
  })();
  return _crtVendasBusca;
}

// Roda no ciclo de 1 minuto do app da dona. Só grava quando o número muda de verdade —
// senão seriam 1.440 gravações por dia numa linha que quase sempre está igual.
async function crtSincronizarPrioridade() {
  if (ehPerfilOficina()) return;
  if (!(window._shopifyDetalhados || []).length) return; // sem pedidos carregados não há o que ordenar

  // _pedidosPendentes é subproduto do card "Prontos para Envio". Fora do INÍCIO ele fica
  // velho, então a conta é refeita aqui (renderiza em painel escondido, sem efeito visível
  // e sem gravar nada).
  if (modeloAtual !== '__dashboard__') { try { renderProntosParaEnvio(); } catch (e) {} }

  const prio  = crtPrioridade();
  const novo  = { ...prio, travados: crtCalcularTravados() };
  const v     = await crtBuscarVendas(prio);
  if (v) Object.assign(novo, v);
  novo.atualizado_em = new Date().toISOString();

  const mesmo = k => JSON.stringify(prio[k]) === JSON.stringify(novo[k]);
  if (mesmo('travados') && mesmo('vendas')) return;

  saveLocal('vc:' + CORTE_PRIO_KEY, novo);
  // salvarNuvemREST e não salvarNuvem: esta linha é um retrato recalculado o tempo todo,
  // guardar 25 versões dela no histórico só empurraria para fora as versões que importam.
  await salvarNuvemREST(CORTE_PRIO_KEY, novo);
  if (modeloAtual === '__corte__' && !crtOcupado()) renderCorte();
}

// ─── MINI CARDS: LIBERADOS HOJE · LIBERADOS NA SEMANA · PEDIDOS EM ABERTO ────
// Três números de cabeceira, sem lista de peças: quanto saiu hoje, quanto saiu na
// semana e quanto ainda falta sair. Em cada um o número grande é PEDIDO e a linha
// de baixo é PEÇA.
//
// "Semana" começa na SEGUNDA, então o card mostra da segunda mais recente 00:00 até
// agora. Na própria segunda os dois cards de liberados mostram o mesmo número, e é
// isso mesmo — eles só se separam na terça. A janela do /api/shopify-orders é de 7
// dias, e "última segunda" nunca passa disso (no domingo dá 6 dias e pouco).
//
// Liberado = ENVIO (fulfillment) criado na Shopify, mesma fonte da baixa de estoque:
// remessa cancelada não entra e pedido enviado em duas remessas conta uma vez só no
// total de pedidos (por isso o Set de números), mas as peças das duas somam.
//
// Conjunto conta como as PEÇAS dele (requisitosDoItem, o mesmo distribuidor da baixa):
// um Conjunto Pantalona + Blusa que saiu são duas peças da arara, não uma.
function inicioDaSemana() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - 1 + 7) % 7)); // 1 = segunda (domingo volta 6 dias)
  return d;
}

function renderMiniCards(pecasEmAberto) {
  const set = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt; };
  const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
  const pecasDe = remessas => remessas.reduce((s, p) =>
    s + (p.itens || []).flatMap(requisitosDoItem).reduce((t, r) => t + (r.qtd || 0), 0), 0);
  const preencher = (idPed, idSub, remessas, sufixo) => {
    set(idPed, new Set(remessas.map(p => p.numero)).size);
    set(idSub, plural(pecasDe(remessas), 'peça', 'peças') + (sufixo || ''));
  };

  const enviados = (window._shopifyProcessados || []).filter(p => p.enviado_em);

  // ── Liberados hoje ──
  // Dia comparado por data LOCAL formatada (sv-SE dá AAAA-MM-DD), nunca por recorte de
  // texto do ISO: o carimbo da Shopify vem com fuso ("...-03:00") e cortar os 10
  // primeiros caracteres jogaria o envio da madrugada para o dia anterior.
  const diaLocal = d => new Date(d).toLocaleDateString('sv-SE');
  const hoje = diaLocal(Date.now());
  preencher('mini-hoje-ped', 'mini-hoje-sub', enviados.filter(p => diaLocal(p.enviado_em) === hoje));

  // ── Liberados da segunda até agora ──
  const desde = inicioDaSemana();
  preencher('mini-lib-ped', 'mini-lib-sub',
    enviados.filter(p => Date.parse(p.enviado_em) >= desde.getTime()),
    ` · desde seg ${desde.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`);

  // ── Pedidos ainda em aberto ──
  // A contagem sai de _shopifyDetalhados (um item por pedido não enviado com produto
  // reconhecido). As peças vêm do mesmo total da métrica PEÇAS EM ABERTO, para os dois
  // números do painel nunca discordarem.
  set('mini-ab-ped', (window._shopifyDetalhados || []).length);
  set('mini-ab-sub', `${plural(pecasEmAberto || 0, 'peça', 'peças')} a enviar`);
}

function renderProntosParaEnvio() {
  const el    = document.getElementById('dash-prontos');
  const totEl = document.getElementById('dash-prontos-total');
  if (!el) return;

  // Estoque de trabalho: cópia do estoque atual (será decrementado conforme aloca)
  const stock = {};
  for (const key of Object.keys(MODELOS)) {
    const saved = loadLocal('vc:' + key) || {};
    const cores = coresDoModelo(MODELOS[key], saved);
    stock[key] = {};
    cores.forEach(cor => {
      const ev = (saved.est && saved.est[cor]) || [];
      stock[key][cor] = ev.map(v => v || 0);
    });
  }

  // Foto do estoque ANTES de qualquer alocação. A troca de etiqueta usa isto para nunca
  // oferecer mais do que "ESTOQUE − PEDIDOS EM ABERTO" daquela cor/tamanho — a mesma conta
  // que as duas tabelas do modelo mostram lado a lado.
  const estoqueBruto = {};
  for (const k of Object.keys(stock)) {
    estoqueBruto[k] = {};
    for (const c of Object.keys(stock[k])) estoqueBruto[k][c] = stock[k][c].slice();
  }

  const estIdx = (key, tam) => (MODELOS[key] && MODELOS[key].tamanhoUnico) ? 0 : tam;
  const estGet = (key, cor, tam) => {
    const i = estIdx(key, tam);
    return (stock[key] && stock[key][cor] && stock[key][cor][i]) || 0;
  };
  const estDec = (key, cor, tam, q) => {
    const i = estIdx(key, tam);
    if (!stock[key]) stock[key] = {};
    if (!stock[key][cor]) stock[key][cor] = [];
    stock[key][cor][i] = ((stock[key][cor][i]) || 0) - q;
  };

  const reqsDoItem = requisitosDoItem;

  // Só pedidos PAGOS entram (exclui pendentes, autorizados, expirados, estornados, etc.)
  // 'paid' = pago integral | 'partially_refunded' = pago e com reembolso parcial (ainda enviável)
  const STATUS_PAGO = new Set(['paid', 'partially_refunded']);

  // Prioridade de liberação (alocação de estoque E exibição):
  //   1º ATRASADOS (pagos há 30+ dias, depois 15+) — quando a peça que faltava enfim chega,
  //      o pedido antigo tem que pegar essa peça antes de um pedido novo consumir. Sem isto
  //      o atrasado podia ficar esperando de novo (pedidos de MAIO abertos em 28/07/2026).
  //   2º PARCIAIS (já começaram a ser enviados)
  //   3º GRANDES (acima de 4 peças — senão ficam pra trás)
  //   → dentro de cada faixa, do mais antigo para o mais recente.
  const GRANDE_MIN = 5; // "acima de 4 itens"
  const totPecas = p => (p.itens || []).reduce((s, it) => s + (it.qtd || 0), 0);
  const atraso = p => {
    const d = diasDesde(p.data);
    return d >= PARADO_CRITICO ? 8 : d >= PARADO_ATENCAO ? 4 : 0;
  };
  const prioridade = p => atraso(p) + (p.parcial ? 2 : 0) + (totPecas(p) >= GRANDE_MIN ? 1 : 0);
  const detalhados = (window._shopifyDetalhados || [])
    .filter(p => STATUS_PAGO.has(p.financial_status))
    .sort((a, b) => (prioridade(b) - prioridade(a)) || (new Date(a.data || 0) - new Date(b.data || 0)));

  const prontos = [];
  const pendentes = []; // pagos que NÃO podem sair ainda — alimentam o card PEDIDOS PARADOS
  for (const ped of detalhados) {
    let reqs = [];
    for (const item of ped.itens) reqs = reqs.concat(reqsDoItem(item));
    if (reqs.length === 0) continue; // pedido sem itens mapeáveis

    const disponivel = reqs.every(r => estGet(r.key, r.cor, r.tam) >= r.qtd);
    if (!disponivel) {
      // Guarda o que impede o envio (peça a peça), pro card de pedidos parados
      const faltas = reqs
        .map(r => ({ ...r, falta: Math.max(0, r.qtd - estGet(r.key, r.cor, r.tam)) }))
        .filter(r => r.falta > 0);
      // reqs vai junto: a troca de etiqueta precisa saber o que este pedido travado JÁ tem
      // separado na arara, senão ofereceria essa peça para outro pedido.
      pendentes.push({ ...ped, faltas, reqs });
      continue;
    }

    reqs.forEach(r => estDec(r.key, r.cor, r.tam, r.qtd));
    prontos.push({
      id:      ped.id,
      numero:  ped.numero,
      cliente: ped.cliente || 'Cliente',
      data:    ped.data,
      pecas:   ped.itens.reduce((s, i) => s + i.qtd, 0),
      itens:   ped.itens,
      url:     ped.url,
      parcial: ped.parcial,
      grande:  ped.itens.reduce((s, i) => s + i.qtd, 0) >= GRANDE_MIN,
      dias:    diasDesde(ped.data),
    });
  }

  window._pedidosPendentes = pendentes;
  renderPedidosParados();

  // O que sobrou na arara depois de separar os pedidos prontos — é desse saldo que
  // sai a troca de etiqueta, senão ela roubaria peça de pedido que já ia ser enviado.
  window._estoqueLivre = stock;
  window._estoqueBruto = estoqueBruto;
  renderTrocaEtiqueta();

  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

  // Converte índice de tamanho → rótulo (PP/P/M... ou numeração de calçado ou "Único")
  const sizeLabel = (key, tam) => {
    const def = MODELOS[key];
    if (def && def.tamanhoUnico) return 'Único';
    const arr = (def && def.tamanhos) || ['PP', 'P', 'M', 'G', 'GG'];
    return arr[tam] || '—';
  };

  if (totEl) totEl.textContent = prontos.length > 0
    ? `${prontos.length} pedido${prontos.length > 1 ? 's' : ''}` : '';

  if (prontos.length === 0) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-ter);padding:8px 0">Nenhum pedido pronto para envio com o estoque atual.</div>';
    return;
  }

  el.innerHTML = `
    <table>
      <thead><tr>
        <th style="text-align:left;width:24px"></th>
        <th style="text-align:left">Pedido</th>
        <th style="text-align:left">Cliente</th>
        <th style="text-align:center">Data</th>
        <th style="text-align:center">Peças</th>
      </tr></thead>
      <tbody>
        ${prontos.map((p, i) => {
          const dt = p.data
            ? new Date(p.data).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'2-digit' })
            : '—';
          const itensHtml = p.itens.map(it => {
            const nome = (MODELOS[it.modelKey] && MODELOS[it.modelKey].nome) || it.modelKey;
            return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px">
              <span style="display:inline-block;min-width:26px;font-weight:700;color:#16a34a">${it.qtd}×</span>
              <span style="font-weight:600">${esc(nome)}</span>
              <span style="color:var(--text-sec)">— ${esc(it.cor)}</span>
              <span style="margin-left:auto;background:#eef2f0;border-radius:4px;padding:1px 8px;font-weight:600;color:var(--text-sec)">${esc(sizeLabel(it.modelKey, it.tam))}</span>
            </div>`;
          }).join('');
          const badgeParcial = p.parcial
            ? `&nbsp;<span style="font-size:9px;font-weight:700;background:rgba(245,158,11,0.16);color:#b45309;border-radius:3px;padding:1px 6px;letter-spacing:0.03em;vertical-align:middle">PARCIAL</span>`
            : '';
          const badgeGrande = p.grande
            ? `&nbsp;<span style="font-size:9px;font-weight:700;background:rgba(37,99,235,0.14);color:#1d4ed8;border-radius:3px;padding:1px 6px;letter-spacing:0.03em;vertical-align:middle">GRANDE ${p.pecas}</span>`
            : '';
          // Pedido que estava parado e agora pode sair: precisa saltar aos olhos da expedição,
          // senão volta a esperar atrás dos pedidos novos.
          const badgeAtrasado = p.dias >= PARADO_ATENCAO
            ? `&nbsp;<span style="font-size:9px;font-weight:700;background:${p.dias >= PARADO_CRITICO ? '#dc2626' : 'rgba(217,119,6,.85)'};color:#fff;border-radius:3px;padding:1px 6px;letter-spacing:0.03em;vertical-align:middle">ENVIAR PRIMEIRO · ${p.dias} dias</span>`
            : '';
          const pedidoCell = (p.url
            ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="font-weight:700;color:#16a34a;text-decoration:none" title="Abrir pedido na Shopify">${esc(p.numero)} <i class="ti ti-external-link" style="font-size:11px;vertical-align:-1px"></i></a>`
            : `<span style="font-weight:700;color:#16a34a">${esc(p.numero)}</span>`) + badgeAtrasado + badgeParcial + badgeGrande;
          return `<tr class="pronto-row" style="cursor:pointer" onclick="togglePronto(${i})">
              <td style="text-align:center"><i class="ti ti-chevron-right" id="pronto-cev-${i}" style="transition:transform .15s;color:var(--text-ter)"></i></td>
              <td>${pedidoCell}</td>
              <td>${esc(p.cliente)}</td>
              <td style="text-align:center;font-size:11px;color:var(--text-sec)">${dt}</td>
              <td style="text-align:center;font-weight:600">${p.pecas}</td>
            </tr>
            <tr id="pronto-det-${i}" style="display:none">
              <td></td>
              <td colspan="4" style="padding:4px 8px 10px">
                <div style="background:#f7faf8;border:1px solid #e0eae4;border-radius:8px;padding:8px 12px">${itensHtml}</div>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

// Abre/fecha o dropdown com as peças de um pedido pronto para envio
function togglePronto(i) {
  const det = document.getElementById('pronto-det-' + i);
  const cev = document.getElementById('pronto-cev-' + i);
  if (!det) return;
  const aberto = det.style.display !== 'none';
  det.style.display = aberto ? 'none' : '';
  if (cev) cev.style.transform = aberto ? '' : 'rotate(90deg)';
}

// Marca um pedido como processado (cumprido) na Shopify
async function marcarProcessado(orderId, numero, btn) {
  if (!confirm(`Marcar o pedido ${numero} como processado na Shopify?\n\nIsto cria o cumprimento do pedido (sem enviar e-mail ao cliente).`)) return;

  const original = btn.innerHTML;
  btn.disabled = true;
  btn.style.opacity = '0.7';
  btn.style.cursor = 'wait';
  btn.innerHTML = '<i class="ti ti-loader-2"></i> Processando…';

  try {
    const res = await fetch('/api/shopify-fulfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.erro) {
      const msg = data.erro || `Erro ${res.status}`;
      alert(`Não foi possível processar o pedido ${numero}.\n\n${msg}${data.detalhe ? '\n\n' + (typeof data.detalhe === 'string' ? data.detalhe.slice(0, 300) : '') : ''}`);
      btn.disabled = false;
      btn.style.opacity = '';
      btn.style.cursor = 'pointer';
      btn.innerHTML = original;
      return;
    }

    // Sucesso — feedback visual e atualização da lista
    btn.innerHTML = '<i class="ti ti-check"></i> Processado';
    btn.style.background = '#0f7a37';
    btn.style.borderColor = '#0f7a37';

    // Recarrega pedidos da Shopify (o pedido cumprido sai do filtro "unshipped") e re-renderiza.
    // A baixa do estoque sai JUNTO, aqui — este é o momento em que a peça deixou a arara.
    await carregarPedidosShopify();
    await baixaImediataDeProcessados().catch(() => {});
    if (modeloAtual === '__dashboard__') renderDashboard();
  } catch (err) {
    alert(`Falha de conexão ao processar o pedido ${numero}.\n\n${err.message}`);
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.cursor = 'pointer';
    btn.innerHTML = original;
  }
}

function expandirTabela() {
  const rows = window._tabelaRowsAll || [];
  const tabelaEl = document.getElementById('dash-tabela');
  if (!tabelaEl) return;
  const btn = document.getElementById('tabela-ver-mais-row');
  if (btn) btn.remove();
  const existentes = tabelaEl.querySelectorAll('tr').length;
  rows.slice(existentes).forEach(m => {
    const tr = document.createElement('tr');
    tr.className = 'dash-row';
    tr.style.cursor = 'pointer';
    tr.innerHTML = `
      <td style="font-weight:500">${m.nome}</td>
      <td style="text-align:center" class="${m.pedidos > 0 ? 'val-areia' : ''}">${m.pedidos || '—'}</td>
      <td style="text-align:center">${m.estoque || '—'}</td>
      <td style="text-align:center" class="${m.produzir > 0 ? 'val-escuro' : ''}">${m.produzir || '—'}</td>`;
    tr.onclick = () => abrirModeloPorNome(m.nome);
    tabelaEl.appendChild(tr);
  });
}

function expandirSaldo() {
  const rows = window._saldoRowsAll || [];
  const saldoEl = document.getElementById('dash-saldo');
  if (!saldoEl) return;
  // Remove botão "Ver mais"
  const btn = document.getElementById('saldo-ver-mais-row');
  if (btn) btn.remove();
  // Adiciona as linhas restantes
  const existentes = saldoEl.querySelectorAll('tr').length;
  const faltam = rows.slice(existentes);
  faltam.forEach(r => {
    const sizeCells = r.tu
      ? `<td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>`
      : r.sizes.map(v => `<td style="text-align:center" class="${v > 0 ? 'saldo-ok' : ''}">${v || '—'}</td>`).join('');
    const tr = document.createElement('tr');
    tr.className = 'dash-row';
    tr.style.cursor = 'pointer';
    tr.innerHTML = `
      <td style="font-weight:500">${r.nome}</td>
      <td>${r.cor}</td>
      ${sizeCells}
      <td style="text-align:center;font-weight:700;color:#16a34a">+${r.total}</td>`;
    tr.onclick = () => abrirModeloPorNome(r.nome);
    saldoEl.appendChild(tr);
  });
}

function renderModelo(key) {
  const def = MODELOS[key];
  if (!def) return; // telas que não são modelo (ex: __financeiro__) não renderizam aqui
  const saved = loadLocal('vc:' + key);
  const d = saved || {};
  const nome = d.nome || def.nome;
  const tecido = d.tecido || def.tecido;
  const consumo = d.consumo || def.consumo;
  const preco = d.preco || def.preco;
  // Cores do data.js são a referência; cores extras do localStorage só entram se não houver tamanhos customizados
  // (modelos com tamanhos customizados como sapatos ignoram cores obsoletas do localStorage).
  // Cor que TEM pedido entra sempre — coresDoModelo garante isso.
  const cores = coresDoModelo(def, def.tamanhos ? null : d);

  document.getElementById('model-title').textContent = nome;
  document.getElementById('model-sub').textContent = `TECIDO: ${tecido.toUpperCase()} • CONSUMO: ${consumo}M/PEÇA`;
  document.getElementById('preco-m').value = preco.toFixed(2);
  const statusSel = document.getElementById('prod-status');
  const opcoesStatus = def.revenda
    ? ['', 'Comprado']
    : ['', 'Comprando tecido', 'Em corte', 'Em costura'];
  statusSel.innerHTML = opcoesStatus
    .map(s => `<option value="${s}">${s === '' ? '— Sem status —' : s}</option>`)
    .join('');
  const statusSalvo = opcoesStatus.includes(d.status) ? d.status : '';
  statusSel.value = statusSalvo;
  document.getElementById('prod-prazo').value = d.prazo || '';
  // 2ª leva: status/prazo próprios (mesmas opções da leva 1)
  const statusSel2 = document.getElementById('prod2-status');
  if (statusSel2) {
    statusSel2.innerHTML = opcoesStatus
      .map(s => `<option value="${s}">${s === '' ? '— Sem status —' : s}</option>`)
      .join('');
    statusSel2.value = opcoesStatus.includes(d.status2) ? d.status2 : '';
    const prazo2El = document.getElementById('prod2-prazo');
    if (prazo2El) prazo2El.value = d.prazo2 || '';
  }
  document.getElementById('cfg-nome').value = nome;
  document.getElementById('cfg-tecido').value = tecido;
  document.getElementById('cfg-consumo').value = consumo;
  document.getElementById('cfg-componentes').value = d.componentes || def.componentes;
  document.getElementById('cfg-obs').value = d.obs || def.obs;

  // Fixas = as do catálogo do modelo + as que a dona já cadastrou. O resto veio de pedido
  // e fica provisório, para uma leitura errada não virar cor permanente do modelo.
  const coresFixas = new Set([...(def.cores || []), ...((d.cores) || [])].map(chaveCor));
  renderCoresTags(cores, coresFixas);

  // Mostra croquis embutidos na aba Arquivos se não houver upload manual
  ['frente', 'costas'].forEach(lado => {
    const temUpload = loadLocal('vc:croqui-' + lado + ':' + key);
    const temEmbutido = def['croqui' + lado.charAt(0).toUpperCase() + lado.slice(1)];
    if (!temUpload && temEmbutido) {
      document.getElementById('croqui-' + lado + '-vazio').style.display = 'none';
      document.getElementById('croqui-' + lado + '-arquivo').style.display = 'block';
      document.getElementById('croqui-' + lado + '-nome').textContent = 'Croqui ' + lado + ' (padrão)';
      document.getElementById('croqui-' + lado + '-meta').textContent = 'Imagem embutida no modelo';
    } else if (!temUpload) {
      document.getElementById('croqui-' + lado + '-vazio').style.display = 'block';
      document.getElementById('croqui-' + lado + '-arquivo').style.display = 'none';
    }
  });

  const abt = document.getElementById('aberto-tbody');
  const est = document.getElementById('est-tbody');
  const prod = document.getElementById('prod-tbody');
  abt.innerHTML = ''; est.innerHTML = ''; prod.innerHTML = '';

  const tu = !!def.tamanhoUnico;

  // Tamanhos: usa tamanhos customizados do modelo (ex: sapatos 35-39) ou padrão PP-GG
  const SZ = def.tamanhos || ['PP','P','M','G','GG'];

  // Cabeçalhos e rodapés dinâmicos
  if (tu) {
    document.getElementById('aberto-thead').innerHTML = '<tr><th>Cor</th><th>Total</th></tr>';
    document.getElementById('aberto-tfoot').innerHTML = '<tr class="total-row"><td>Total</td><td id="ab-tot">0</td></tr>';
    document.getElementById('est-thead').innerHTML    = '<tr><th>Cor</th><th>Total</th></tr>';
    document.getElementById('est-tfoot').innerHTML    = '<tr class="total-row"><td>Total</td><td id="e-tot">0</td></tr>';
    document.getElementById('prod-thead').innerHTML   = '<tr><th>Cor</th><th>Total</th></tr>';
    document.getElementById('prod-tfoot').innerHTML   = '<tr class="total-row"><td>Total</td><td id="p-tot">0</td></tr>';
  } else {
    const thSZ  = SZ.map(s => `<th>${s}</th>`).join('');
    const abFt  = SZ.map(s => `<td id="ab-${s}">0</td>`).join('');
    const eFt   = SZ.map(s => `<td id="e-${s}">0</td>`).join('');
    const pFt   = SZ.map(s => `<td id="p-${s}">0</td>`).join('');
    document.getElementById('aberto-thead').innerHTML = `<tr><th>Cor</th>${thSZ}<th>Tot</th></tr>`;
    document.getElementById('aberto-tfoot').innerHTML = `<tr class="total-row"><td>Total</td>${abFt}<td id="ab-tot">0</td></tr>`;
    document.getElementById('est-thead').innerHTML    = `<tr><th>Cor</th>${thSZ}<th>Tot</th></tr>`;
    document.getElementById('est-tfoot').innerHTML    = `<tr class="total-row"><td>Total</td>${eFt}<td id="e-tot">0</td></tr>`;
    document.getElementById('prod-thead').innerHTML   = `<tr><th>Cor</th>${thSZ}<th>Tot</th></tr>`;
    document.getElementById('prod-tfoot').innerHTML   = `<tr class="total-row"><td>Total</td>${pFt}<td id="p-tot">0</td></tr>`;
  }

  const abTots = new Array(SZ.length).fill(0);
  cores.forEach(cor => {
    const ab    = (def.aberto[cor] || []).map((v, i) => v || 0).concat(new Array(SZ.length).fill(0)).slice(0, SZ.length);
    const ev    = ((d.est && d.est[cor]) || []).map((v, i) => v || 0).concat(new Array(SZ.length).fill(0)).slice(0, SZ.length);
    const abTot = ab.reduce((a, b) => a + b, 0);
    ab.forEach((v, i) => abTots[i] += v);

    // 2ª leva já em produção — desconta do "mínimo" sugerido para a leva 1 (senão duplica)
    const p2Cor = ((d.prod2 && d.prod2[cor]) || []).map(v => v || 0);

    if (tu) {
      // Pedidos: soma total
      abt.innerHTML += `<tr><td>${cor}</td><td class="${abTot > 0 ? 'val-areia' : ''}">${abTot || '—'}</td></tr>`;
      // Estoque: 1 input — total armazenado em ev[0]
      const etot = ev[0] || 0;
      const minTU = necessidadeLeva(ab, ev, p2Cor, true, SZ.length)[0];
      const pvTU  = d.prod && d.prod[cor] ? (d.prod[cor][0] || 0) : minTU;
      est.innerHTML  += `<tr data-cor="${cor}"><td>${cor}</td><td><input class="ci${etot > 0 ? ' ci-val' : ''}" type="number" min="0" value="${etot || ''}" placeholder="—" oninput="marcarEstEditado()"></td></tr>`;
      prod.innerHTML += `<tr data-cor="${cor}" data-min="${minTU}"><td>${cor}</td><td><input class="ci${pvTU > 0 ? (pvTU > minTU ? ' acima' : ' ci-val') : ''}" type="number" min="0" value="${pvTU || ''}" placeholder="—" oninput="marcarProdEditado();calcProdTU(this);autoSave()"></td></tr>`;
    } else {
      const mins = necessidadeLeva(ab, ev, p2Cor, false, SZ.length);
      // normaliza pro nº de tamanhos do modelo (dados antigos podem ter menos posições — ex.: sapato migrado de PP-GG p/ 34-40)
      const pv   = ((d.prod && d.prod[cor]) || mins).map(v => v || 0).concat(new Array(SZ.length).fill(0)).slice(0, SZ.length);
      abt.innerHTML  += `<tr><td>${cor}</td>${ab.map(v => `<td class="${v > 0 ? 'val-areia' : ''}">${v || '—'}</td>`).join('')}<td class="${abTot > 0 ? 'val-areia' : ''}">${abTot || '0'}</td></tr>`;
      const etot = ev.reduce((a, b) => a + b, 0);
      est.innerHTML  += `<tr data-cor="${cor}"><td>${cor}</td>${ev.map(v => `<td><input class="ci${v > 0 ? ' ci-val' : ''}" type="number" min="0" value="${v || ''}" placeholder="—" oninput="marcarEstEditado()"></td>`).join('')}<td class="re ${etot > 0 ? 'val-grafite' : ''}">${etot || '—'}</td></tr>`;
      const ptot = pv.reduce((a, b) => a + b, 0);
      prod.innerHTML += `<tr data-cor="${cor}" data-min="${mins.join(',')}"><td>${cor}</td>${pv.map((v, i) => `<td><input class="ci${v > 0 ? (v > mins[i] ? ' acima' : ' ci-val') : ''}" type="number" min="0" value="${v || ''}" placeholder="—" oninput="marcarProdEditado();calcProd(this);autoSave()"></td>`).join('')}<td class="rp ${ptot > 0 ? 'val-escuro' : ''}">${ptot || '—'}</td></tr>`;
    }
  });

  // 2ª leva de produção (card extra com status próprio)
  renderLeva2(def, d, cores, SZ, tu);

  const abTotal = abTots.reduce((a, b) => a + b, 0);
  if (!tu) SZ.forEach((s, i) => { const el = document.getElementById('ab-' + s); if (el) el.textContent = abTots[i]; });
  const at = document.getElementById('ab-tot'); if (at) { at.textContent = abTotal; at.className = abTotal > 0 ? 'val-areia' : ''; }
  document.getElementById('m-aberto').textContent = abTotal;

  // Conjuntos linkados a este modelo
  const conjLinkEl = document.getElementById('conjuntos-linkados');
  if (conjLinkEl) {
    const conjuntosLink = [];
    for (const [conjKey, pecas] of Object.entries(CONJUNTO_PECAS)) {
      const contemModelo = pecas.some(p => (typeof p === 'string' ? p : p.key) === key);
      if (contemModelo && MODELOS[conjKey]) {
        conjuntosLink.push(MODELOS[conjKey].nome);
      }
    }
    if (conjuntosLink.length > 0) {
      conjLinkEl.style.display = '';
      conjLinkEl.innerHTML = '<i class="ti ti-link" style="margin-right:4px"></i><strong>Pedidos incluem distribuição de:</strong> ' +
        conjuntosLink.map(n => `<span style="display:inline-block;background:#e8e0d0;border-radius:4px;padding:1px 7px;margin:1px 2px;font-weight:600">${n}</span>`).join('');
    } else {
      conjLinkEl.style.display = 'none';
      conjLinkEl.innerHTML = '';
    }
  }

  // Data da última atualização do estoque
  const estUpd = document.getElementById('est-updated');
  if (estUpd) {
    const estDate = d.est_at;
    if (estDate) {
      const dt = new Date(estDate);
      const fmtDt = dt.toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'2-digit' });
      const fmtHr = dt.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
      estUpd.textContent = `Atualizado em ${fmtDt} às ${fmtHr}`;
    } else {
      estUpd.textContent = 'Edite direto';
    }
  }

  // Data da última atualização de produção
  const prodUpd = document.getElementById('prod-updated');
  if (prodUpd) {
    const prodDate = d.prod_at || d.updated_at;
    if (prodDate) {
      const dt = new Date(prodDate);
      const fmtDt = dt.toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'2-digit' });
      const fmtHr = dt.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
      prodUpd.textContent = `Atualizado em ${fmtDt} às ${fmtHr}`;
    } else {
      prodUpd.textContent = '';
    }
  }

  recalc();
  renderResumoProducao();
  // Alinha alturas das linhas nos 3 cards (desktop)
  setTimeout(syncRowHeights, 60);
}

function renderResumoProducao() {
  if (modeloAtual === '__dashboard__') return;
  const def   = MODELOS[modeloAtual];
  const d     = loadLocal('vc:' + modeloAtual) || {};
  const cores = coresDoModelo(def, d);
  const tu    = !!def.tamanhoUnico;

  const tbodyAp   = document.getElementById('resumo-aprod-tbody');
  const tbodySl   = document.getElementById('resumo-saldo-tbody');
  const theadAp   = document.getElementById('resumo-aprod-thead');
  const theadSl   = document.getElementById('resumo-saldo-thead');
  const tfootAp   = document.getElementById('resumo-aprod-tfoot');
  const tfootSl   = document.getElementById('resumo-saldo-tfoot');
  if (!tbodyAp || !tbodySl) return;

  tbodyAp.innerHTML = '';
  tbodySl.innerHTML = '';

  const SIZES = def.tamanhos || ['PP','P','M','G','GG'];
  const colsTu  = '<tr><th>Cor</th><th>Total</th></tr>';
  const colsFull = `<tr><th>Cor</th>${SIZES.map(s=>`<th>${s}</th>`).join('')}<th>Total</th></tr>`;
  const tfTu  = pfx => `<tr class="total-row"><td>Total</td><td id="${pfx}-tot">—</td></tr>`;
  const tfFull = pfx => `<tr class="total-row"><td>Total</td>${SIZES.map(s=>`<td id="${pfx}-${s}">—</td>`).join('')}<td id="${pfx}-tot">—</td></tr>`;

  if (theadAp) theadAp.innerHTML = tu ? colsTu  : colsFull;
  if (theadSl) theadSl.innerHTML = tu ? colsTu  : colsFull;
  if (tfootAp) tfootAp.innerHTML = tu ? tfTu('rp') : tfFull('rp');
  if (tfootSl) tfootSl.innerHTML = tu ? tfTu('rs') : tfFull('rs');

  const totAp = tu ? [0] : new Array(SIZES.length).fill(0);
  const totSl = tu ? [0] : new Array(SIZES.length).fill(0);
  let sumAp = 0, sumSl = 0;

  // Peça que ia ser cortada mas já existe pronta no tamanho vizinho: trocar a etiqueta
  // economiza a confecção inteira (e o tecido, se ainda não foi comprado).
  const aceitaTroca = modeloAceitaTrocaEtiqueta(def, modeloAtual, SEM_TROCA_ETIQUETA);
  const economia = [];

  cores.forEach(cor => {
    const ab = def.aberto[cor] || [0,0,0,0,0];
    const ev = d.est && d.est[cor] || [0,0,0,0,0];
    const pv = prodTotalCor(d, cor) || [0,0,0,0,0]; // leva 1 + leva 2

    if (tu) {
      const saldo = ab.reduce((a,b)=>a+b,0) - (ev[0]||0) - (pv[0]||0);
      if (saldo > 0) {
        sumAp += saldo; totAp[0] += saldo;
        tbodyAp.innerHTML += `<tr><td>${cor}</td><td class="saldo-falta">${saldo}</td></tr>`;
      } else if (saldo < 0) {
        sumSl += saldo; totSl[0] += saldo;
        tbodySl.innerHTML += `<tr><td>${cor}</td><td class="saldo-ok">${Math.abs(saldo)}</td></tr>`;
      }
    } else {
      const saldos = ab.map((a,i) => a - (ev[i]||0) - (pv[i]||0));
      const tot = saldos.reduce((a,b)=>a+b,0);

      // Economia de produção: falta um tamanho e sobra peça PRONTA no vizinho.
      // A fonte é ESTOQUE − PEDIDOS, não o saldo da tabela: aquele desconta a produção
      // também, e não dá para trocar a etiqueta de peça que ainda não foi costurada.
      if (aceitaTroca) {
        const livre = ab.map((a, i) => Math.max(0, (ev[i] || 0) - a));
        // A falta aqui é PEDIDOS − ESTOQUE, de propósito SEM descontar a leva: a peça que
        // já está na leva é justamente a que se quer evitar costurar. Descontando, um G que
        // já foi jogado na produção zerava a falta e a troca nunca era oferecida — foi o
        // caso da Calça Básica Moletom Off White (10/08/2026).
        const falta = ab.map((a, i) => Math.max(0, a - (ev[i] || 0)));
        casarVizinhos(falta, livre, SIZES.length).forEach(t =>
          economia.push({ cor, ...t, naLeva: Math.min(t.qtd, pv[t.para] || 0) }));
      }

      const temFalta  = saldos.some(v => v > 0);
      const temSobra  = saldos.some(v => v < 0);
      const faltaTotal = saldos.reduce((a,v) => a + (v > 0 ? v : 0), 0);
      const sobraTotal = saldos.reduce((a,v) => a + (v < 0 ? Math.abs(v) : 0), 0);

      // Card A PRODUZIR — cores com pelo menos 1 tamanho faltando
      if (temFalta) {
        sumAp += faltaTotal;
        saldos.forEach((v,i) => { if (v > 0) totAp[i] += v; });
        const cells = saldos.map(v => `<td class="${v>0?'saldo-falta':''}">${v>0?v:'—'}</td>`).join('');
        tbodyAp.innerHTML += `<tr><td>${cor}</td>${cells}<td class="${faltaTotal>0?'saldo-falta':''}">${faltaTotal||'—'}</td></tr>`;
      }

      // Card SALDO DISPONÍVEL — cores com pelo menos 1 tamanho sobrando
      if (temSobra) {
        sumSl += sobraTotal;
        saldos.forEach((v,i) => { if (v < 0) totSl[i] += Math.abs(v); });
        const cells = saldos.map(v => `<td class="${v<0?'saldo-ok':''}">${v<0?Math.abs(v):'—'}</td>`).join('');
        tbodySl.innerHTML += `<tr><td>${cor}</td>${cells}<td class="${sobraTotal>0?'saldo-ok':''}">${sobraTotal||'—'}</td></tr>`;
      }
    }
  });

  // Rodapés A PRODUZIR
  if (!tu) SIZES.forEach((s,i) => { const el=document.getElementById('rp-'+s); if(el){el.textContent=totAp[i]||'—'; el.className=totAp[i]>0?'saldo-falta':'';} });
  const rpTot = document.getElementById('rp-tot');
  if (rpTot) { rpTot.textContent = sumAp || '—'; rpTot.className = sumAp > 0 ? 'saldo-falta' : ''; }

  // Rodapés SALDO DISPONÍVEL
  if (!tu) SIZES.forEach((s,i) => { const el=document.getElementById('rs-'+s); if(el){el.textContent=totSl[i]||'—'; el.className=totSl[i]>0?'saldo-ok':'';} });
  const rsTot = document.getElementById('rs-tot');
  if (rsTot) { rsTot.textContent = sumSl || '—'; rsTot.className = sumSl > 0 ? 'saldo-ok' : ''; }

  // Badge no header de cada card
  const apBadge = document.getElementById('resumo-aprod-badge');
  if (apBadge) apBadge.textContent = sumAp > 0 ? sumAp + ' peças' : '';
  const slBadge = document.getElementById('resumo-saldo-badge');
  if (slBadge) slBadge.textContent = sumSl < 0 ? Math.abs(sumSl) + ' peças' : '';

  // Mantém compatibilidade com o ID legado usado em recalc
  const ra = document.getElementById('resumo-aprod');
  if (ra) { ra.textContent = sumAp || '0'; ra.className = sumAp > 0 ? 'saldo-falta' : ''; }

  // Atualiza métrica do topo "A PRODUZIR"
  const mp = document.getElementById('m-produzir');
  if (mp) { mp.textContent = sumAp; mp.className = 'val' + (sumAp > 0 ? ' val-escuro' : ''); }

  renderEconomiaTroca(economia, SIZES);
}

// Card "DÁ PRA NÃO PRODUZIR" — cada linha é uma peça que sairia da fila de confecção
// só trocando a etiqueta de uma que já está pronta no tamanho vizinho.
function renderEconomiaTroca(economia, SIZES) {
  const el    = document.getElementById('economia-troca');
  const card  = document.getElementById('card-economia-troca');
  const badge = document.getElementById('economia-troca-badge');
  if (!el || !card) return;

  window._economiaTroca = economia;
  if (!economia.length) { card.style.display = 'none'; el.innerHTML = ''; if (badge) badge.textContent = ''; return; }

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const total = economia.reduce((s, e) => s + e.qtd, 0);
  card.style.display = '';
  if (badge) badge.textContent = `${total} peça${total > 1 ? 's' : ''} a menos pra costurar`;

  el.innerHTML = `
    <div style="font-size:11px;color:var(--text-sec);margin-bottom:8px">
      Estas peças precisam ser feitas para atender os pedidos, mas já existe uma
      <b>pronta na arara</b> no tamanho vizinho, sem pedido em cima dela. Trocando a etiqueta
      você economiza a confecção — e o tecido, se ainda não comprou. A peça sai de um tamanho e
      entra no outro: o total do modelo não muda. Onde aparecer o aviso em laranja, a peça já
      tinha sido jogada numa leva: <b>tire ela da leva</b> depois de trocar, senão vira produção
      repetida.
    </div>
    <table style="table-layout:fixed;width:100%">
      <colgroup><col style="width:26%"><col style="width:40%"><col style="width:14%"><col style="width:20%"></colgroup>
      <thead><tr>
        <th style="text-align:left">Cor</th>
        <th style="text-align:left">Troca</th>
        <th style="text-align:center">Peças</th>
        <th style="text-align:center">Já troquei</th>
      </tr></thead>
      <tbody>
        ${economia.map((e, i) => `
          <tr>
            <td style="text-align:left;font-weight:600">${esc(e.cor)}</td>
            <td style="text-align:left;font-size:12px">
              <b>${esc(SIZES[e.de] || '?')}</b>
              <i class="ti ti-arrow-right" style="font-size:11px;vertical-align:-1px;color:#0d9488"></i>
              <b style="color:#0d9488">${esc(SIZES[e.para] || '?')}</b>
              <span style="color:var(--text-ter);font-size:11px"> — deixa de produzir ${esc(SIZES[e.para] || '?')}</span>
              ${e.naLeva > 0 ? `<div style="font-size:10px;color:#b45309;font-weight:700;padding-top:2px">
                <i class="ti ti-alert-triangle"></i> ${e.naLeva} já está na leva — tire de lá depois de trocar</div>` : ''}
            </td>
            <td style="text-align:center;font-weight:700">${e.qtd}</td>
            <td style="text-align:center">
              <button class="btn-primary" style="font-size:10px;padding:5px 9px;background:#0d9488;border-color:#0d9488;white-space:nowrap"
                onclick="aplicarEconomiaTroca(${i}, this)"
                title="Só depois de trocar a etiqueta na peça: move a peça do tamanho antigo para o novo no estoque">
                <i class="ti ti-tag"></i> troquei
              </button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

async function aplicarEconomiaTroca(i, btn) {
  const e = (window._economiaTroca || [])[i];
  if (!e) return;
  const def = MODELOS[modeloAtual];
  const SZ  = (def && def.tamanhos) || ['PP','P','M','G','GG'];

  if (!confirm(`Confirma que a etiqueta JÁ foi trocada?\n\n`
    + `• ${def.nome} ${e.cor}: ${SZ[e.de]} → ${SZ[e.para]}${e.qtd > 1 ? ' ×' + e.qtd : ''}\n\n`
    + `A peça passa do ${SZ[e.de]} para o ${SZ[e.para]} no estoque e sai da fila de produção.`)) return;

  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.innerHTML = '<i class="ti ti-loader-2"></i>'; }
  const mover = await transferirTamanhoEstoque(modeloAtual, e.cor, e.de, e.para, e.qtd);
  if (mover < e.qtd) {
    alert(mover === 0
      ? `Não há mais ${def.nome} ${e.cor} ${SZ[e.de]} no estoque — nada foi trocado.`
      : `Só havia ${mover} peça(s) de ${def.nome} ${e.cor} ${SZ[e.de]}. O resto não foi trocado.`);
  }
  renderModelo(modeloAtual);
}

// Cor PROVISÓRIA = apareceu porque um pedido caiu nela, mas não está cadastrada no modelo.
// Ela é mostrada (senão as peças do pedido sumiriam das tabelas), mas NÃO é gravada: quando
// a leitura do pedido está errada, a cor inventada virava cor permanente do modelo assim que
// qualquer coisa fosse salva naquela tela — foi assim que "Canelado + Calça Pantalona Cinza"
// entrou na Calça Pantalona Moletom e levou junto 1 peça para a leva (10/08/2026).
// Para cadastrar de vez existe o botão +.
function renderCoresTags(cores, fixas) {
  const container = document.getElementById('cores-tags');
  container.innerHTML = '';
  cores.forEach(cor => {
    const fixa = !fixas || fixas.has(chaveCor(cor));
    const tag = document.createElement('div');
    tag.className = 'cor-tag' + (fixa ? '' : ' cor-tag-prov');
    tag.dataset.fixa = fixa ? '1' : '0';
    if (!fixa) tag.title = 'Cor que veio de um pedido e não está cadastrada neste modelo. '
      + 'Não fica salva — some sozinha se a leitura do pedido for corrigida. Clique em + para cadastrar de vez.';
    tag.innerHTML = `<span>${cor}</span>` + (fixa
      ? `<button onclick="removerCor(this)" title="Remover">×</button>`
      : `<button onclick="fixarCor(this)" title="Cadastrar esta cor no modelo">+</button>`);
    container.appendChild(tag);
  });
}

// Promove uma cor provisória a cor do modelo (aí sim ela é gravada)
function fixarCor(btn) {
  const tag = btn.parentElement;
  const cor = tag.querySelector('span').textContent;
  tag.dataset.fixa = '1';
  tag.className = 'cor-tag';
  tag.removeAttribute('title');
  tag.innerHTML = `<span>${cor}</span><button onclick="removerCor(this)" title="Remover">×</button>`;
  autoSave();
}

function addCor() {
  const inp = document.getElementById('nova-cor');
  const val = inp.value.trim();
  if (!val) return;
  const tag = document.createElement('div');
  tag.className = 'cor-tag';
  tag.dataset.fixa = '1'; // digitada pela dona: é cor do modelo
  tag.innerHTML = `<span>${val}</span><button onclick="removerCor(this)" title="Remover">×</button>`;
  document.getElementById('cores-tags').appendChild(tag);
  inp.value = '';
  inp.focus();
  autoSave();
}

function removerCor(btn) {
  btn.parentElement.remove();
  autoSave();
}

function calcProdTU(inp) {
  const row = inp.closest('tr');
  const min = parseInt(row.dataset.min) || 0;
  const v   = parseInt(inp.value) || 0;
  inp.className = 'ci' + (v > 0 ? (v > min ? ' acima' : ' ci-val') : '');
  // atualiza total do rodapé
  let tot = 0;
  document.querySelectorAll('#prod-tbody tr').forEach(r => {
    tot += parseInt(r.querySelector('input').value) || 0;
  });
  const pt = document.getElementById('p-tot'); if (pt) { pt.textContent = tot; pt.className = tot > 0 ? 'val-escuro' : ''; }
  const mpEl = document.getElementById('m-producao'); if (mpEl) mpEl.textContent = tot;
  atualizarTecido();
}

function recalc() {
  const tu = modeloAtual !== '__dashboard__' && MODELOS[modeloAtual] && MODELOS[modeloAtual].tamanhoUnico;
  let es = 0;
  if (tu) {
    document.querySelectorAll('#est-tbody tr').forEach(row => {
      es += parseInt(row.querySelector('input').value) || 0;
    });
    const et = document.getElementById('e-tot'); if (et) { et.textContent = es; et.className = es > 0 ? 'val-grafite' : ''; }
  } else {
    const szLen = MODELOS[modeloAtual]?.tamanhos?.length || 5;
    const tots = new Array(szLen).fill(0);
    document.querySelectorAll('#est-tbody tr').forEach(row => {
      const vals = Array.from(row.querySelectorAll('input')).map(i => parseInt(i.value) || 0);
      const sum = vals.reduce((a, b) => a + b, 0);
      const t = row.querySelector('.re');
      if (t) { t.textContent = sum; t.className = 're ' + (sum > 0 ? 'val-grafite' : ''); }
      vals.forEach((v, i) => { if (i < tots.length) tots[i] += v; });
    });
    (MODELOS[modeloAtual]?.tamanhos || ['PP','P','M','G','GG']).forEach((s, i) => { const el = document.getElementById('e-' + s); if (el) el.textContent = tots[i]; });
    es = tots.reduce((a, b) => a + b, 0);
    const et = document.getElementById('e-tot'); if (et) { et.textContent = es; et.className = es > 0 ? 'val-grafite' : ''; }
  }
  document.getElementById('m-estoque').textContent = es;
  atualizarTecido();
}

function calcProd(inp) {
  const row = inp.closest('tr');
  const mins = row.dataset.min.split(',').map(Number);
  const inputs = Array.from(row.querySelectorAll('input'));
  inputs.forEach((i, idx) => { i.className = 'ci' + ((parseInt(i.value) || 0) > mins[idx] ? ' acima' : ''); });
  const sum = inputs.reduce((a, i) => a + (parseInt(i.value) || 0), 0);
  const t = row.querySelector('.rp');
  if (t) { t.textContent = sum; t.className = 'rp ' + (sum > 0 ? 'val-escuro' : ''); }
  atualizarTecido();
}

// Preenche a tabela de produção com max(0, aberto − estoque − 2ª leva) para cada cor/tamanho.
// A 2ª leva entra na conta: o que ela já está produzindo NÃO precisa ser produzido de novo aqui.
function recalcularProducao() {
  const def = MODELOS[modeloAtual];
  if (!def) return;
  if (!confirmarLeituraConfiavel(modeloAtual)) return;
  const saved = loadLocal('vc:' + modeloAtual) || {};
  const tu = !!def.tamanhoUnico;

  document.querySelectorAll('#prod-tbody tr').forEach(row => {
    const cor = row.dataset.cor;
    const ab  = def.aberto[cor]  || [0, 0, 0, 0, 0];
    const ev  = saved.est && saved.est[cor] || [0, 0, 0, 0, 0];
    const p2  = saved.prod2 && saved.prod2[cor] || [];
    const inputs = Array.from(row.querySelectorAll('input'));
    const mins = necessidadeLeva(ab, ev, p2, tu, inputs.length);

    if (tu) {
      // tamanhoUnico: 1 input = total (necessidade já vem somada na posição 0)
      inputs[0].value = mins[0] || '';
      calcProdTU(inputs[0]);
    } else {
      inputs.forEach((inp, i) => {
        inp.value = mins[i] || '';
        calcProd(inp);
      });
    }
  });

  prodEditado = true;
  salvarLocalImediato();   // persiste no localStorage imediatamente (antes de qualquer F5)
  autoSave();              // agenda envio para a nuvem
  renderModelo(modeloAtual); // atualiza card A Produzir e saldos
}

function transferirParaEstoque() {
  const saved = loadLocal('vc:' + modeloAtual) || {};
  if (!saved.prod || Object.keys(saved.prod).length === 0) return;

  const def  = MODELOS[modeloAtual];
  const tu   = !!def.tamanhoUnico;
  const cores = coresDoModelo(def, saved);

  if (!saved.est) saved.est = {};

  let temAlgo = false;
  cores.forEach(cor => {
    const pv = saved.prod[cor];
    if (!pv) return;
    const total = pv.reduce((a, b) => a + b, 0);
    if (total === 0) return;
    temAlgo = true;
    if (!saved.est[cor]) saved.est[cor] = [0, 0, 0, 0, 0];
    // Soma Em Produção ao estoque existente
    saved.est[cor] = saved.est[cor].map((v, i) => v + (pv[i] || 0));
  });

  if (!temAlgo) return;

  // Zera produção explicitamente em todas as cores (evita fallback para mínimos na re-renderização)
  cores.forEach(cor => { saved.prod[cor] = [0, 0, 0, 0, 0]; });

  const agora = new Date().toISOString();
  saved.est_at     = agora;
  saved.prod_at    = agora;
  saved.updated_at = agora;

  saveLocal('vc:' + modeloAtual, saved);
  salvarNuvem(modeloAtual, saved);
  renderModelo(modeloAtual);
}

// ─── 2ª LEVA DE PRODUÇÃO ─────────────────────────────────────────────────────
// Leva extra por modelo (ex.: leva 1 já na costura + nova compra de tecido para
// produzir mais). Começa sempre VAZIA (sem preenchimento automático) para não
// duplicar contagens; entra nos cálculos somada à leva 1 (falta líquida) e conta
// nos cards por etapa com o próprio status2.

function temLeva2(d) {
  return !!(d && (d.leva2 || d.status2 ||
    (d.prod2 && Object.values(d.prod2).some(v => (v || []).some(x => x > 0)))));
}

function renderLeva2(def, d, cores, SZ, tu) {
  const wrap  = document.getElementById('leva2-wrap');
  const vazio = document.getElementById('leva2-vazio');
  if (!wrap) return;
  const ativa = temLeva2(d);
  wrap.style.display = ativa ? '' : 'none';
  if (vazio) vazio.style.display = ativa ? 'none' : '';
  // Barra de status da 2ª leva (acima da linha, igual à barra principal)
  const bar = document.getElementById('leva2-bar');
  if (bar) bar.style.display = ativa ? '' : 'none';
  // Com leva ativa, a linha vira 3 colunas (2ª leva + A Produzir + Saldo); sem, volta a 2
  const rowResumo = document.getElementById('row-leva2-resumo');
  if (rowResumo) rowResumo.className = ativa ? 'sections-3' : 'sections-2';

  const thead = document.getElementById('prod2-thead');
  const tbody = document.getElementById('prod2-tbody');
  const tfoot = document.getElementById('prod2-tfoot');
  tbody.innerHTML = '';
  if (!ativa) { thead.innerHTML = ''; tfoot.innerHTML = ''; return; }

  if (tu) {
    thead.innerHTML = '<tr><th>Cor</th><th>Total</th></tr>';
    tfoot.innerHTML = '<tr class="total-row"><td>Total</td><td id="p2-tot">0</td></tr>';
  } else {
    thead.innerHTML = `<tr><th>Cor</th>${SZ.map(s => `<th>${s}</th>`).join('')}<th>Tot</th></tr>`;
    tfoot.innerHTML = `<tr class="total-row"><td>Total</td>${SZ.map(s => `<td id="p2-${s}">0</td>`).join('')}<td id="p2-tot">0</td></tr>`;
  }

  cores.forEach(cor => {
    const pv = ((d.prod2 && d.prod2[cor]) || []).map(v => v || 0).concat(new Array(SZ.length).fill(0)).slice(0, SZ.length);
    if (tu) {
      const v = pv[0] || 0;
      tbody.innerHTML += `<tr data-cor="${cor}"><td>${cor}</td><td><input class="ci${v > 0 ? ' ci-val' : ''}" type="number" min="0" value="${v || ''}" placeholder="—" oninput="marcarProd2Editado();calcProd2(this);autoSave()"></td></tr>`;
    } else {
      const tot = pv.reduce((a, b) => a + b, 0);
      tbody.innerHTML += `<tr data-cor="${cor}"><td>${cor}</td>${pv.map(v => `<td><input class="ci${v > 0 ? ' ci-val' : ''}" type="number" min="0" value="${v || ''}" placeholder="—" oninput="marcarProd2Editado();calcProd2(this);autoSave()"></td>`).join('')}<td class="rp2 ${tot > 0 ? 'val-escuro' : ''}">${tot || '—'}</td></tr>`;
    }
  });

  const updEl = document.getElementById('prod2-updated');
  if (updEl) {
    if (d.prod2_at) {
      const dt = new Date(d.prod2_at);
      const fmtDt = dt.toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'2-digit' });
      const fmtHr = dt.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
      updEl.textContent = `Atualizado em ${fmtDt} às ${fmtHr}`;
    } else {
      updEl.textContent = '';
    }
  }
}

function calcProd2(inp) {
  const row = inp.closest('tr');
  const inputs = Array.from(row.querySelectorAll('input'));
  inputs.forEach(i => { i.className = 'ci' + ((parseInt(i.value) || 0) > 0 ? ' ci-val' : ''); });
  const sum = inputs.reduce((a, i) => a + (parseInt(i.value) || 0), 0);
  const t = row.querySelector('.rp2');
  if (t) { t.textContent = sum || '—'; t.className = 'rp2 ' + (sum > 0 ? 'val-escuro' : ''); }
  atualizarTecido();
}

// Preenche a 2ª leva com o que está em "A Produzir": Pedidos − Estoque − leva principal
// (a leva 1 é lida do DOM, o mesmo que o card A Produzir enxerga)
function recalcularProducao2() {
  const def = MODELOS[modeloAtual];
  if (!def) return;
  if (!confirmarLeituraConfiavel(modeloAtual)) return;
  const saved = loadLocal('vc:' + modeloAtual) || {};
  const tu = !!def.tamanhoUnico;

  // Leva 1 como está na tela
  const p1Dom = {};
  document.querySelectorAll('#prod-tbody tr').forEach(r => {
    p1Dom[r.dataset.cor] = Array.from(r.querySelectorAll('input')).map(i => parseInt(i.value) || 0);
  });

  document.querySelectorAll('#prod2-tbody tr').forEach(row => {
    const cor = row.dataset.cor;
    const ab  = def.aberto[cor] || [0, 0, 0, 0, 0];
    const ev  = saved.est && saved.est[cor] || [0, 0, 0, 0, 0];
    const p1  = p1Dom[cor] || [0, 0, 0, 0, 0];
    const inputs = Array.from(row.querySelectorAll('input'));

    if (tu) {
      // tamanhoUnico: 1 input = total. Estoque em ev[0]; leva 1 = soma do input único
      const abTot = ab.reduce((a, b) => a + b, 0);
      const falta = Math.max(0, abTot - (ev[0] || 0) - p1.reduce((a, b) => a + (b || 0), 0));
      inputs[0].value = falta || '';
      calcProd2(inputs[0]);
    } else {
      inputs.forEach((inp, i) => {
        inp.value = Math.max(0, (ab[i] || 0) - (ev[i] || 0) - (p1[i] || 0)) || '';
        calcProd2(inp);
      });
    }
  });

  prod2Editado = true;
  salvarLocalImediato();   // persiste no localStorage imediatamente (antes de qualquer F5)
  autoSave();              // agenda envio para a nuvem
  renderModelo(modeloAtual); // atualiza card A Produzir e saldos
}

function adicionarLeva2() {
  if (modeloAtual === '__dashboard__' || !MODELOS[modeloAtual]) return;
  const saved = loadLocal('vc:' + modeloAtual) || {};
  saved.leva2 = true;
  saved.updated_at = new Date().toISOString();
  saveLocal('vc:' + modeloAtual, saved);
  _ultimoSaveTs = Date.now(); // carência: evita o sync da nuvem sobrescrever antes do upsert confirmar
  salvarNuvem(modeloAtual, saved);
  renderModelo(modeloAtual);
}

function removerLeva2() {
  const saved = loadLocal('vc:' + modeloAtual) || {};
  const temValores = saved.prod2 && Object.values(saved.prod2).some(v => (v || []).some(x => x > 0));
  if (temValores && !confirm('Remover a 2ª leva? As quantidades digitadas nela serão apagadas (a produção principal não muda).')) return;
  delete saved.prod2;
  delete saved.status2;
  delete saved.prazo2;
  delete saved.status2_at;
  delete saved.prod2_at;
  saved.leva2 = false;
  saved.updated_at = new Date().toISOString();
  saveLocal('vc:' + modeloAtual, saved);
  _ultimoSaveTs = Date.now();
  salvarNuvem(modeloAtual, saved);
  buildSidebar();
  verificarAvisosStatus();
  renderModelo(modeloAtual);
}

// Soma a 2ª leva ao Estoque e zera a leva (mesma lógica da leva 1)
function transferirParaEstoque2() {
  const saved = loadLocal('vc:' + modeloAtual) || {};
  if (!saved.prod2 || Object.keys(saved.prod2).length === 0) return;

  const def   = MODELOS[modeloAtual];
  const cores = coresDoModelo(def, saved);

  if (!saved.est) saved.est = {};

  let temAlgo = false;
  cores.forEach(cor => {
    const pv = saved.prod2[cor];
    if (!pv) return;
    const total = pv.reduce((a, b) => a + (b || 0), 0);
    if (total === 0) return;
    temAlgo = true;
    if (!saved.est[cor]) saved.est[cor] = [0, 0, 0, 0, 0];
    saved.est[cor] = saved.est[cor].map((v, i) => v + (pv[i] || 0));
  });

  if (!temAlgo) return;

  // Zera a leva explicitamente em todas as cores
  cores.forEach(cor => { saved.prod2[cor] = [0, 0, 0, 0, 0]; });

  const agora = new Date().toISOString();
  saved.est_at     = agora;
  saved.prod2_at   = agora;
  saved.updated_at = agora;

  saveLocal('vc:' + modeloAtual, saved);
  _ultimoSaveTs = Date.now();
  salvarNuvem(modeloAtual, saved);
  renderModelo(modeloAtual);
}
// ─────────────────────────────────────────────────────────────────────────────

function syncRowHeights() {
  // Só sincroniza no desktop (3 colunas visíveis)
  if (window.innerWidth < 769) return;
  const ids = ['aberto-tbody', 'est-tbody', 'prod-tbody'];
  const tbodies = ids.map(id => document.getElementById(id));
  if (!tbodies[0] || !tbodies[1] || !tbodies[2]) return;

  // Reset alturas anteriores
  tbodies.forEach(tb => Array.from(tb.rows).forEach(tr => { tr.style.height = ''; }));

  // Sincronia linha a linha
  const maxRows = Math.max(...tbodies.map(tb => tb.rows.length));
  for (let i = 0; i < maxRows; i++) {
    const rows = tbodies.map(tb => tb.rows[i]).filter(Boolean);
    const maxH = Math.max(...rows.map(r => r.getBoundingClientRect().height));
    if (maxH > 0) rows.forEach(r => { r.style.height = maxH + 'px'; });
  }

  // Sincronia do rodapé (tfoot)
  const tfootIds = ['aberto-tfoot', 'est-tfoot', 'prod-tfoot'];
  const tfoots = tfootIds.map(id => document.getElementById(id));
  const tfRows = tfoots.map(tf => tf && tf.rows[0]).filter(Boolean);
  if (tfRows.length > 1) {
    const maxTf = Math.max(...tfRows.map(r => r.getBoundingClientRect().height));
    if (maxTf > 0) tfRows.forEach(r => { r.style.height = maxTf + 'px'; });
  }
}

function atualizarTecido() {
  const consumo = parseFloat(document.getElementById('cfg-consumo').value) || MODELOS[modeloAtual].consumo;
  const preco = parseFloat(document.getElementById('preco-m').value) || 0;
  const SZ = (MODELOS[modeloAtual] && MODELOS[modeloAtual].tamanhos) || ['PP', 'P', 'M', 'G', 'GG'];
  // Tecido/custo por cor somam leva 1 + 2ª leva; rodapés das tabelas são separados
  const porCor = {}; // cor → peças (ordem de inserção = ordem das linhas)
  const lerTabela = (sel, tots) => {
    document.querySelectorAll(sel + ' tr').forEach(row => {
      const cor = row.dataset.cor;
      const vals = Array.from(row.querySelectorAll('input')).map(i => parseInt(i.value) || 0);
      vals.forEach((v, i) => { if (i < tots.length) tots[i] += v; });
      const pecas = vals.reduce((a, b) => a + b, 0);
      if (pecas > 0) porCor[cor] = (porCor[cor] || 0) + pecas;
    });
  };
  const tots  = new Array(SZ.length).fill(0);
  const tots2 = new Array(SZ.length).fill(0);
  lerTabela('#prod-tbody', tots);
  lerTabela('#prod2-tbody', tots2);
  const dados = Object.entries(porCor).map(([cor, pecas]) => ({ cor, pecas, metros: pecas * consumo, custo: pecas * consumo * preco }));
  SZ.forEach((s, i) => { const el = document.getElementById('p-' + s); if (el) el.textContent = tots[i]; });
  const sum = tots.reduce((a, b) => a + b, 0);
  const pt = document.getElementById('p-tot'); if (pt) { pt.textContent = sum; pt.className = sum > 0 ? 'val-escuro' : ''; }
  SZ.forEach((s, i) => { const el = document.getElementById('p2-' + s); if (el) el.textContent = tots2[i]; });
  const sum2 = tots2.reduce((a, b) => a + b, 0);
  const pt2 = document.getElementById('p2-tot'); if (pt2) { pt2.textContent = sum2; pt2.className = sum2 > 0 ? 'val-escuro' : ''; }
  document.getElementById('m-produzir').textContent = sum + sum2;
  renderResumoProducao();
  const tm = dados.reduce((a, d) => a + d.metros, 0);
  const tc = dados.reduce((a, d) => a + d.custo, 0);
  const mc = document.getElementById('m-custo'); if (mc) mc.textContent = 'R$ ' + fmt(tc);
  const grid = document.getElementById('tecido-grid'); if (!grid) return;
  grid.innerHTML = dados.map(d => `
    <div class="tc">
      <div class="tc-cor">${d.cor.toUpperCase()}</div>
      <div class="tc-m">${d.metros.toFixed(1)}m</div>
      <div class="tc-custo">R$ ${fmt(d.custo)}</div>
      <div class="tc-sub">${d.pecas} pcs × ${consumo}m × R$ ${fmt(preco)}</div>
    </div>
  `).join('') + (dados.length > 0 ? `
    <div class="tc-total">
      <div>
        <div class="tc-cor">TOTAL GERAL</div>
        <div class="tc-sub">${dados.reduce((a, d) => a + d.pecas, 0)} peças</div>
      </div>
      <div style="text-align:right">
        <div class="tc-m">${tm.toFixed(1)}m</div>
        <div class="tc-custo">R$ ${fmt(tc)}</div>
      </div>
    </div>
  ` : '');
}

function preencherMin() {
  document.querySelectorAll('#prod-tbody tr').forEach(row => {
    const mins = row.dataset.min.split(',').map(Number);
    Array.from(row.querySelectorAll('input')).forEach((inp, i) => { inp.value = mins[i]; inp.className = 'ci'; });
    const sum = mins.reduce((a, b) => a + b, 0);
    const t = row.querySelector('.rp'); if (t) { t.textContent = sum; t.className = 'rp ' + (sum > 0 ? 'val-escuro' : ''); }
  });
  atualizarTecido();
  autoSave();
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-btn-' + name).classList.add('active');
  document.getElementById('panel-' + name).classList.add('active');
}

function handleFile(input, tipo) {
  const f = input.files[0]; if (!f) return;
  const kb = Math.round(f.size / 1024);
  document.getElementById(tipo + '-vazio').style.display = 'none';
  document.getElementById(tipo + '-arquivo').style.display = 'block';
  document.getElementById(tipo + '-nome').textContent = f.name;
  document.getElementById(tipo + '-meta').textContent = `${kb}KB • Adicionado agora`;
  if ((tipo === 'croqui-frente' || tipo === 'croqui-costas') && f.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = ev => saveLocal('vc:' + tipo + ':' + modeloAtual, ev.target.result);
    reader.readAsDataURL(f);
  }
}

function handleDrop(e, tipo) {
  e.preventDefault();
  document.querySelectorAll('.upload-area').forEach(a => a.classList.remove('over'));
  const f = e.dataTransfer.files[0]; if (!f) return;
  const kb = Math.round(f.size / 1024);
  document.getElementById(tipo + '-vazio').style.display = 'none';
  document.getElementById(tipo + '-arquivo').style.display = 'block';
  document.getElementById(tipo + '-nome').textContent = f.name;
  document.getElementById(tipo + '-meta').textContent = `${kb}KB • Adicionado agora`;
  if ((tipo === 'croqui-frente' || tipo === 'croqui-costas') && f.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = ev => saveLocal('vc:' + tipo + ':' + modeloAtual, ev.target.result);
    reader.readAsDataURL(f);
  }
}

function removerArq(tipo) {
  document.getElementById(tipo + '-vazio').style.display = 'block';
  document.getElementById(tipo + '-arquivo').style.display = 'none';
}

async function urlToBase64(src) {
  if (!src) return null;
  if (src.startsWith('data:')) return src; // já é base64
  try {
    const resp = await fetch(src);
    const blob = await resp.blob();
    return new Promise(res => {
      const r = new FileReader();
      r.onload = e => res(e.target.result);
      r.readAsDataURL(blob);
    });
  } catch(_) { return null; }
}

// Sem argumento: ficha do modelo aberto, lendo a TELA — sai com o que acabou de ser
// digitado, mesmo antes de salvar. Com uma chave: monta a partir do que está SALVO, que
// é como a aba CORTE abre a ficha de qualquer modelo sem precisar abrir o modelo.
async function gerarFicha(keyArg) {
  const key = keyArg || modeloAtual;
  const def = MODELOS[key];
  if (!def) return;
  const tu = !!def.tamanhoUnico;
  const saved = loadLocal('vc:' + key) || {};
  const nome = saved.nome || def.nome;
  const tecido = saved.tecido || def.tecido;
  const consumo = saved.consumo || def.consumo;
  const componentes = saved.componentes || def.componentes || '—';
  const obs = saved.obs || def.obs || '';
  const cores = coresDoModelo(def, saved);
  // Só lê a tela quando é mesmo o modelo aberto e a tabela existe no DOM
  const daTela = !keyArg && key === modeloAtual && !!document.getElementById('prod-tbody');
  const status  = daTela ? document.getElementById('prod-status').value : (saved.status || '');
  const prazo   = daTela ? document.getElementById('prod-prazo').value  : (saved.prazo || '');
  // prioridade: upload manual → legado → caminho padrão do modelo
  const croquiFrenteRaw = loadLocal('vc:croqui-frente:' + key) || loadLocal('vc:croqui:' + key) || def.croquiFrente || null;
  const croquiCostasRaw = loadLocal('vc:croqui-costas:' + key) || def.croquiCostas || null;

  // Converte caminhos de URL para base64 (garante impressão offline)
  const [croquiFrente, croquiCostas] = await Promise.all([
    urlToBase64(croquiFrenteRaw),
    urlToBase64(croquiCostasRaw)
  ]);

  // Coleta dados de produção (leva 1 + 2ª leva, seções separadas na ficha)
  // grade do modelo (pode ter G1) — nunca assumir 5 colunas
  const SZ_FICHA = tamanhosDe(def);
  const lerRows = sel => {
    const rows = [];
    document.querySelectorAll(sel + ' tr').forEach(row => {
      const cor = row.dataset.cor;
      const vals = Array.from(row.querySelectorAll('input')).map(i => parseInt(i.value) || 0);
      const tot = vals.reduce((a, b) => a + b, 0);
      rows.push({ cor, vals, tot });
    });
    return rows;
  };
  // Mesma forma que lerRows devolve, só que a partir do mapa salvo {cor: [qtds]}
  const rowsDeSalvo = mapa => cores.map(cor => {
    const orig = (mapa && mapa[cor]) || [];
    const vals = Array.from({ length: SZ_FICHA.length }, (_, i) => orig[i] || 0);
    return { cor, vals, tot: vals.reduce((a, b) => a + b, 0) };
  });
  const prodRows  = daTela ? lerRows('#prod-tbody')  : rowsDeSalvo(saved.prod);
  const prod2Rows = (daTela ? lerRows('#prod2-tbody') : rowsDeSalvo(saved.prod2)).filter(r => r.tot > 0);
  const status2   = daTela ? (document.getElementById('prod2-status')?.value || '') : (saved.status2 || '');
  const prodTots = new Array(SZ_FICHA.length).fill(0);
  prodRows.forEach(r => r.vals.forEach((v,i) => prodTots[i] += v));
  const prod2Tots = new Array(SZ_FICHA.length).fill(0);
  prod2Rows.forEach(r => r.vals.forEach((v,i) => prod2Tots[i] += v));
  prod2Rows.forEach(r => r.vals.forEach((v,i) => prodTots[i] += v)); // total geral = leva 1 + 2ª leva
  const prodTotal = prodTots.reduce((a,b) => a+b, 0);

  const hoje = new Date().toLocaleDateString('pt-BR');
  const prazoFmt = prazo ? new Date(prazo + 'T12:00:00').toLocaleDateString('pt-BR') : '—';

  const colSpan = tu ? 2 : SZ_FICHA.length + 2;
  const rowsHtml = rows => rows.map((r, idx) => {
    const bg = idx % 2 === 1 ? '#faf8f5' : '#fff';
    const sizeCells = tu ? '' : r.vals.map(v => `<td style="text-align:center;padding:7px 8px;border:1px solid #ddd;background:${bg};color:${v ? '#111' : '#ccc'};">${v || '—'}</td>`).join('');
    return `
    <tr>
      <td style="text-align:left;font-weight:600;padding:7px 12px;border:1px solid #ddd;background:${bg};">${r.cor}</td>
      ${sizeCells}
      <td style="text-align:center;padding:7px 8px;border:1px solid #ddd;background:${bg};font-weight:700;">${r.tot || '—'}</td>
    </tr>`;
  }).join('');
  const colorRowsHtml = rowsHtml(prodRows);
  // Seção extra da 2ª leva (só entra se tiver quantidades)
  const leva2RowsHtml = prod2Rows.length > 0
    ? `<tr><td colspan="${colSpan}" class="section-hd">2ª leva${status2 ? ' — ' + status2 : ''}</td></tr>` + rowsHtml(prod2Rows)
    : '';

  const makeCroqui = (base64, label) => base64
    ? `<div style="text-align:center;padding:14px 10px;">
        <div style="font-size:8px;font-weight:800;letter-spacing:0.14em;color:#C4A882;margin-bottom:10px;text-transform:uppercase;">${label}</div>
        <img src="${base64}" style="max-width:100%;max-height:300px;object-fit:contain;">
       </div>`
    : `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:20px;color:#ccc;">
        <svg width="32" height="32" fill="none" stroke="#ddd" stroke-width="1.5" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
        <div style="font-size:8px;font-weight:800;letter-spacing:0.14em;color:#C4A882;margin-top:10px;text-transform:uppercase;">${label}</div>
        <div style="font-size:10px;margin-top:4px;">Sem imagem</div>
       </div>`;

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Ficha Técnica — ${nome}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Arial', sans-serif; color: #111; background: #fff; padding: 0; font-size: 12px; }

  /* ── CABEÇALHO ESCURO ── */
  .header-dark {
    background: #111;
    color: #fff;
    padding: 18px 28px 14px;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
  }
  .brand-mark { font-size: 8px; font-weight: 700; letter-spacing: 0.18em; color: #C4A882; margin-bottom: 5px; text-transform: uppercase; }
  .ficha-titulo { font-size: 26px; font-weight: 900; letter-spacing: 0.06em; color: #fff; line-height: 1; }
  .header-meta { text-align: right; font-size: 10px; color: #aaa; line-height: 1.9; }
  .header-meta strong { color: #C4A882; font-weight: 700; }

  /* ── FAIXA DE MODELO ── */
  .model-strip {
    background: #F5F0E8;
    border-bottom: 2px solid #C4A882;
    padding: 10px 28px;
    display: flex;
    gap: 32px;
    font-size: 11px;
  }
  .model-strip .item { display: flex; flex-direction: column; gap: 1px; }
  .model-strip .item-label { font-size: 8px; font-weight: 800; letter-spacing: 0.1em; color: #9a8870; text-transform: uppercase; }
  .model-strip .item-val { font-size: 12px; font-weight: 700; color: #111; }
  .model-strip .cores-list { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
  .cor-tag { padding: 2px 9px; border-radius: 20px; border: 1px solid #C4A882; font-size: 10px; font-weight: 600; color: #6b5740; background: #fff; }

  /* ── CORPO ── */
  .body-wrap { padding: 18px 28px 0; }

  /* ── TABELA DE PRODUÇÃO ── */
  .prod-table { width: 100%; border-collapse: collapse; margin-bottom: 18px; border: 1.5px solid #111; }
  .prod-table th { background: #111; color: #fff; padding: 8px 10px; text-align: center; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; border: 1px solid #333; }
  .prod-table th:first-child { text-align: left; }
  .prod-table .section-hd { background: #C4A882; color: #fff; font-size: 9px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; padding: 5px 12px; border: none; }
  .prod-table .total-row td { background: #111 !important; color: #fff; font-weight: 800; border: 1px solid #333; padding: 8px 10px; text-align: center; }
  .prod-table .total-row td:first-child { text-align: left; letter-spacing: 0.04em; }

  /* ── CROQUIS ── */
  .croqui-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 18px; }
  .croqui-cell { border: 1.5px solid #ddd; min-height: 200px; display: flex; flex-direction: column; justify-content: center; background: #fafafa; border-radius: 3px; }

  /* ── INFO RODAPÉ ── */
  .info-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 18px; }
  .info-card { border: 1px solid #e0d8cc; border-radius: 3px; padding: 12px 14px; background: #faf8f5; }
  .info-card .ic-label { font-size: 8px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: #C4A882; margin-bottom: 5px; }
  .info-card .ic-val { font-size: 11px; color: #333; line-height: 1.6; }

  /* ── RODAPÉ ── */
  .footer { background: #111; color: #666; font-size: 8px; padding: 8px 28px; display: flex; justify-content: space-between; letter-spacing: 0.06em; }
  .footer span { color: #C4A882; font-weight: 700; }

  @media print { @page { margin: 0; size: A4 portrait; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>

  <!-- Cabeçalho escuro -->
  <div class="header-dark">
    <div>
      <div class="brand-mark">Vista Conecte &nbsp;•&nbsp; Gestão de Confecção</div>
      <div class="ficha-titulo">FICHA TÉCNICA</div>
    </div>
    <div class="header-meta">
      <div>Data <strong>${hoje}</strong></div>
      <div>Prazo <strong>${prazoFmt}</strong></div>
      <div>Status <strong>${status}</strong></div>
      ${prod2Rows.length > 0 && status2 ? `<div>Status 2ª leva <strong>${status2}</strong></div>` : ''}
    </div>
  </div>

  <!-- Faixa de informações do modelo -->
  <div class="model-strip">
    <div class="item">
      <div class="item-label">Modelo</div>
      <div class="item-val">${nome}</div>
    </div>
    <div class="item">
      <div class="item-label">Tecido</div>
      <div class="item-val">${tecido}</div>
    </div>
    <div class="item">
      <div class="item-label">Consumo / Peça</div>
      <div class="item-val">${consumo}m</div>
    </div>
    <div class="item">
      <div class="item-label">Total a produzir</div>
      <div class="item-val">${prodTotal} peças</div>
    </div>
    <div class="item" style="flex:1">
      <div class="item-label">Cores</div>
      <div class="cores-list">${cores.map(c => `<span class="cor-tag">${c}</span>`).join('')}</div>
    </div>
  </div>

  <div class="body-wrap">

    <!-- Tabela de produção -->
    <table class="prod-table">
      <thead>
        <tr>
          <th style="text-align:left;width:22%">Cor</th>
          ${tu ? '' : SZ_FICHA.map(s => '<th>' + s + '</th>').join('')}
          <th style="background:#C4A882;">Total</th>
        </tr>
      </thead>
      <tbody>
        <tr><td colspan="${colSpan}" class="section-hd">Total de peças a produzir${leva2RowsHtml ? ' — leva principal' + (status ? ' (' + status + ')' : '') : ''}</td></tr>
        ${colorRowsHtml || `<tr><td colspan="${colSpan}" style="text-align:center;color:#bbb;padding:12px;">Nenhuma peça em produção</td></tr>`}
        ${leva2RowsHtml}
      </tbody>
      <tfoot>
        <tr class="total-row">
          <td>TOTAL GERAL</td>
          ${tu ? '' : prodTots.map(v => `<td>${v}</td>`).join('')}
          <td style="color:#C4A882;">${prodTotal}</td>
        </tr>
      </tfoot>
    </table>

    <!-- Croquis -->
    <div class="croqui-grid">
      <div class="croqui-cell">${makeCroqui(croquiFrente, 'Frente')}</div>
      <div class="croqui-cell">${makeCroqui(croquiCostas, 'Costas')}</div>
    </div>

    <!-- Observação e Componentes -->
    <div class="info-cards">
      <div class="info-card">
        <div class="ic-label">Observação para o cortador</div>
        <div class="ic-val">${obs || '—'}</div>
      </div>
      <div class="info-card">
        <div class="ic-label">Componentes de corte</div>
        <div class="ic-val">${componentes}</div>
      </div>
    </div>

  </div>

  <!-- Rodapé -->
  <div class="footer">
    <div>VISTA CONECTE &nbsp;•&nbsp; GESTÃO DE CONFECÇÃO</div>
    <div>Gerado em <span>${hoje}</span></div>
  </div>

  <script>window.onload = () => window.print();<\/script>
</body>
</html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
}

// Helper: calcula falta (pedidos − estoque) respeitando tamanhoUnico
// tamanhoUnico: pedidos somados em todas as posições, estoque apenas em ev[0]
function calcFalta(ab, ev, tu) {
  if (tu) return Math.max(0, ab.reduce((a,b) => a+b, 0) - (ev[0]||0));
  return ab.reduce((s,a,i) => s + Math.max(0, a - (ev[i]||0)), 0);
}

// Grade de tamanhos padrão de roupa (PP..GG, agora com G1 em alguns modelos).
// Calçado usa numeração (34..40) e é exibido de outro jeito — daí a distinção.
const GRADE_ROUPA = ['PP', 'P', 'M', 'G', 'GG', 'G1'];
function ehNumeracao(def) {
  return !!(def && def.tamanhos && def.tamanhos[0] !== 'PP');
}
function tamanhosDe(def) {
  return (def && def.tamanhos) || ['PP', 'P', 'M', 'G', 'GG'];
}

// Chave de comparação de cor: sem acento, minúscula, espaços colapsados ("CINZA" == "Cinza")
function chaveCor(c) {
  return String(c || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Nome canônico da cor dentro do modelo: se o modelo já conhece uma cor equivalente
// (só muda caixa/acento), usa a dele — senão mantém a que veio do pedido.
function corCanonica(def, cor) {
  const k = chaveCor(cor);
  // Apelido de cor do próprio modelo: o cliente compra "cinza" mas na produção a cor
  // se chama "Mescla" (Conjunto Boho). Declarado em `aliasCores` no data.js.
  const alias = def && def.aliasCores;
  if (alias) {
    const hit = Object.keys(alias).find(a => chaveCor(a) === k);
    if (hit) return alias[hit];
  }
  const conhecidas = [...(def.cores || []), ...Object.keys(def.aberto || {})];
  return conhecidas.find(c => chaveCor(c) === k) || cor;
}

// Cores a exibir/calcular num modelo: as do catálogo + as salvas + as que só existem
// porque CHEGOU PEDIDO nelas (ex.: cor de conjunto que a peça não lista). Sem essa última
// parte o pedido entra em def.aberto mas some da tela e das contas de produção.
function coresDoModelo(def, saved) {
  const lista = [], vistas = new Set();
  const add = c => { const k = chaveCor(c); if (!k || vistas.has(k)) return; vistas.add(k); lista.push(c); };
  (def.cores || []).forEach(add);
  ((saved && saved.cores) || []).forEach(add);
  Object.entries(def.aberto || {}).forEach(([cor, qt]) => { if ((qt || []).some(v => v > 0)) add(cor); });
  return lista;
}

// Necessidade de UMA leva: Pedidos − Estoque − o que a OUTRA leva já está produzindo.
// Sem descontar a outra leva, uma leva recém-recalculada manda produzir/comprar tecido
// de novo para pedidos que a outra leva já está cobrindo (duplicação de produção).
// Retorna sempre array; em tamanhoUnico o total fica na posição 0.
function necessidadeLeva(ab, ev, outra, tu, n) {
  const len = n || Math.max(ab.length, (ev||[]).length, (outra||[]).length, 5);
  const val = (arr, i) => (arr && arr[i]) || 0;
  if (tu) {
    const abTot    = (ab || []).reduce((a,b) => a + (b||0), 0);
    const outraTot = (outra || []).reduce((a,b) => a + (b||0), 0);
    const res = new Array(len).fill(0);
    res[0] = Math.max(0, abTot - val(ev, 0) - outraTot);
    return res;
  }
  return Array.from({ length: len }, (_, i) => Math.max(0, val(ab, i) - val(ev, i) - val(outra, i)));
}

// Mesma conta acima, já somada (total de peças da leva)
function calcFaltaLeva(ab, ev, outra, tu, n) {
  return necessidadeLeva(ab, ev, outra, tu, n).reduce((a,b) => a+b, 0);
}

// Soma leva 1 + leva 2 de produção de uma cor (para falta líquida e afins).
// Retorna null se nenhuma leva tem dados para a cor (preserva o fallback dos chamadores).
function prodTotalCor(saved, cor) {
  const p1 = saved.prod  && saved.prod[cor];
  const p2 = saved.prod2 && saved.prod2[cor];
  if (!p1 && !p2) return null;
  const len = Math.max(p1 ? p1.length : 0, p2 ? p2.length : 0);
  return Array.from({ length: len }, (_, i) => ((p1 && p1[i]) || 0) + ((p2 && p2[i]) || 0));
}

// Falta líquida: Pedidos − Estoque − Em Produção (o que ainda falta mandar para produção)
function calcFaltaLiquido(ab, ev, pv, tu) {
  if (tu) {
    const abTot = ab.reduce((a,b) => (a||0)+(b||0), 0);
    const pvTot = pv ? pv.reduce((a,b) => (a||0)+(b||0), 0) : 0;
    return Math.max(0, abTot - (ev[0]||0) - pvTot);
  }
  return ab.reduce((s,a,i) => s + Math.max(0, (a||0) - (ev[i]||0) - (pv ? (pv[i]||0) : 0)), 0);
}

// Mapa de sinônimos de tecido: chave normalizada → nome canônico para exibição
const TECIDO_SINONIMOS = {
  'viscolycra' : 'Viscolycra',
  'visclycra'  : 'Viscolycra',
  'vicolycra'  : 'Viscolycra',
  'viscolicra' : 'Viscolycra',
  'moletom'    : 'Moletom',
  'ribana'     : 'Ribana',
  'malha'      : 'Malha',
  'canelado'   : 'Canelado',
  'linho'      : 'Linho',
  'viscose'    : 'Viscose',
};

function normalizarTecido(tecido) {
  const chave = tecido.toLowerCase().replace(/\s+/g, ' ').trim();
  return TECIDO_SINONIMOS[chave] ? TECIDO_SINONIMOS[chave].toLowerCase() : chave;
}

function labelTecido(tecido) {
  const chave = tecido.toLowerCase().replace(/\s+/g, ' ').trim();
  return TECIDO_SINONIMOS[chave] || tecido;
}

function gerarFichaCompraGlobal() {
  const hoje = new Date().toLocaleDateString('pt-BR');

  // Coleta todos os modelos com alguma leva em "Comprando tecido"
  // (leva 1 mantém o fallback Pedidos − Estoque; a 2ª leva só conta o digitado)
  const modelos = [];
  for (const [key, def] of Object.entries(MODELOS)) {
    if (CONJUNTO_PECAS[key]) continue;
    const saved = loadLocal('vc:' + key) || {};
    const consumo = saved.consumo || def.consumo;
    const preco   = saved.preco   || def.preco || 0;
    const tecido  = (saved.tecido || def.tecido || '').trim();
    const cores   = coresDoModelo(def, saved);
    const tuFC = !!def.tamanhoUnico;
    let totalPecas = 0;
    if (saved.status === 'Comprando tecido') {
      cores.forEach(cor => {
        const pv = saved.prod && saved.prod[cor];
        if (pv) {
          totalPecas += pv.reduce((a,b) => a+b, 0);
        } else {
          const ab = def.aberto[cor] || [0,0,0,0,0];
          const ev = saved.est && saved.est[cor] || [0,0,0,0,0];
          const p2 = saved.prod2 && saved.prod2[cor] || [];
          totalPecas += calcFaltaLeva(ab, ev, p2, tuFC);
        }
      });
    }
    if (saved.status2 === 'Comprando tecido') {
      cores.forEach(cor => {
        const pv = saved.prod2 && saved.prod2[cor];
        if (pv) totalPecas += pv.reduce((a,b) => a+b, 0);
      });
    }
    if (totalPecas === 0) continue;
    const metros = totalPecas * consumo;
    const custo  = metros * preco;
    modelos.push({ nome: def.nome, tecido, consumo, preco, totalPecas, metros, custo });
  }

  if (modelos.length === 0) {
    alert('Nenhum modelo com status "Comprando tecido" encontrado.');
    return;
  }

  // Agrupa por tecido → cor (o que o fornecedor precisa ver)
  // Usa chave normalizada para unificar variações de maiúsculas/espaços
  const grupos    = {}; // { chaveNorm: { label, cores: { cor: { metros, custo, modelos[] } } } }
  const gruposLabel = {}; // chaveNorm → nome para exibição (primeiro encontrado)
  for (const [key, def] of Object.entries(MODELOS)) {
    if (CONJUNTO_PECAS[key]) continue;
    const saved = loadLocal('vc:' + key) || {};
    if (saved.status !== 'Comprando tecido' && saved.status2 !== 'Comprando tecido') continue;
    const consumo = saved.consumo || def.consumo;
    const preco   = saved.preco   || def.preco || 0;
    const tecido  = (saved.tecido || def.tecido || 'Não especificado').trim();
    const cores   = coresDoModelo(def, saved);
    const chave = normalizarTecido(tecido);
    if (!grupos[chave])      grupos[chave]      = {};
    if (!gruposLabel[chave]) gruposLabel[chave] = labelTecido(tecido);
    const tuG = !!def.tamanhoUnico;
    cores.forEach(cor => {
      let pecas = 0;
      // Leva 1 (com fallback Pedidos − Estoque)
      if (saved.status === 'Comprando tecido') {
        const pv = saved.prod && saved.prod[cor];
        if (pv) {
          pecas += pv.reduce((a,b) => a+b, 0);
        } else {
          const ab = def.aberto[cor] || [0,0,0,0,0];
          const ev = saved.est && saved.est[cor] || [0,0,0,0,0];
          const p2 = saved.prod2 && saved.prod2[cor] || [];
          pecas += calcFaltaLeva(ab, ev, p2, tuG);
        }
      }
      // 2ª leva (só o digitado)
      if (saved.status2 === 'Comprando tecido') {
        const pv2 = saved.prod2 && saved.prod2[cor];
        if (pv2) pecas += pv2.reduce((a,b) => a+b, 0);
      }
      if (pecas === 0) return;
      const metros = pecas * consumo;
      const custo  = metros * preco;
      if (!grupos[chave][cor]) grupos[chave][cor] = { metros: 0, custo: 0, modelos: [] };
      grupos[chave][cor].metros  += metros;
      grupos[chave][cor].custo   += custo;
      grupos[chave][cor].modelos.push(def.nome);
    });
  }

  const totalGeral       = modelos.reduce((s,m) => s + m.custo, 0);
  const totalMetrosGeral = modelos.reduce((s,m) => s + m.metros, 0);

  // Gera seções por tecido → cor (com linhas editáveis)
  const secoesData = Object.entries(grupos).map(([chave, coresObj]) => {
    const tecido    = gruposLabel[chave] || chave;
    const coresList = Object.entries(coresObj);
    return { chave, tecido, coresList };
  });

  // Serializa dados para o HTML (para recálculo JS interno)
  const gruposJSON = JSON.stringify(
    secoesData.map(s => ({
      tecido: s.tecido,
      cores: s.coresList.map(([cor, c]) => ({
        cor,
        metros: c.metros,
        precoM: c.metros > 0 ? c.custo / c.metros : 0,
        modelos: c.modelos
      }))
    }))
  );

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Ficha de Compra — ${hoje}</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:Arial,sans-serif; color:#111; background:#fff; font-size:13px; }
  .header { background:#111; color:#fff; padding:20px 32px 16px; display:flex; justify-content:space-between; align-items:flex-end; }
  .brand  { font-size:8px; font-weight:700; letter-spacing:0.18em; color:#C4A882; margin-bottom:6px; text-transform:uppercase; }
  .titulo { font-size:28px; font-weight:900; letter-spacing:0.06em; line-height:1; }
  .header-meta { text-align:right; font-size:11px; color:#aaa; line-height:2; }
  .header-meta strong { color:#C4A882; }
  .resumo { background:#F5F0E8; border-bottom:2px solid #C4A882; padding:14px 32px; display:flex; gap:40px; flex-wrap:wrap; align-items:flex-end; }
  .rl { font-size:8px; font-weight:800; letter-spacing:0.1em; color:#9a8870; text-transform:uppercase; margin-bottom:2px; }
  .rv { font-size:13px; font-weight:700; color:#111; }
  .body { padding:24px 32px; }
  .footer { background:#111; color:#666; font-size:8px; padding:8px 32px; display:flex; justify-content:space-between; letter-spacing:0.06em; }
  .footer span { color:#C4A882; font-weight:700; }
  .obs-label { font-size:8px; font-weight:800; letter-spacing:0.12em; text-transform:uppercase; color:#C4A882; margin:24px 0 6px; }
  .obs-box { border:1px solid #e0d8cc; border-radius:4px; padding:14px 16px; background:#faf8f5; min-height:60px; margin-bottom:24px; }
  .m-inp { width:80px; text-align:center; font-size:15px; font-weight:900; border:1.5px solid #C4A882; border-radius:4px; padding:3px 6px; background:#fffdf9; color:#111; outline:none; }
  .m-inp:focus { border-color:#9A7A56; background:#fff8ee; }
  .btn-rem { background:none; border:none; color:#ccc; font-size:16px; cursor:pointer; padding:0 4px; line-height:1; }
  .btn-rem:hover { color:#dc2626; }
  .toolbar { position:sticky; top:0; z-index:99; background:#1a1a1a; padding:10px 32px; display:flex; align-items:center; justify-content:space-between; gap:16px; }
  .toolbar-hint { font-size:11px; color:#aaa; }
  .btn-print { background:#C4A882; color:#111; font-weight:800; font-size:13px; border:none; border-radius:4px; padding:8px 22px; cursor:pointer; letter-spacing:0.04em; }
  .btn-print:hover { background:#d4b892; }
  @media print {
    .toolbar, .btn-rem, .no-print { display:none !important; }
    .m-inp { border:none; background:transparent; width:auto; font-size:16px; padding:0; pointer-events:none; }
    @page { margin:0; size:A4 portrait; }
    body { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  }
</style>
</head>
<body>

<div class="toolbar no-print">
  <span class="toolbar-hint">✏️ Ajuste metros ou remova cores antes de imprimir</span>
  <button class="btn-print" onclick="window.print()">🖨️ Imprimir Ficha</button>
</div>

<div class="header">
  <div>
    <div class="brand">Vista Conecte &nbsp;•&nbsp; Gestão de Confecção</div>
    <div class="titulo">FICHA DE COMPRA</div>
  </div>
  <div class="header-meta">
    <div>Data <strong>${hoje}</strong></div>
    <div>Tecidos <strong>${Object.keys(grupos).length} tipos</strong></div>
    <div>Modelos <strong>${modelos.length} modelos</strong></div>
  </div>
</div>

<div class="resumo">
  <div><div class="rl">Tipos de Tecido</div><div class="rv">${Object.values(gruposLabel).join(' · ')}</div></div>
</div>

<div class="body" id="body-ficha"></div>

<div class="footer">
  <div>VISTA CONECTE &nbsp;•&nbsp; FICHA DE COMPRA CONSOLIDADA</div>
  <div>Gerado em <span>${hoje}</span></div>
</div>

<script>
const GRUPOS = ${gruposJSON};

function fmt(n) {
  return n.toLocaleString('pt-BR', { minimumFractionDigits:2, maximumFractionDigits:2 });
}

function removerLinha(btn) {
  const tr = btn.closest('tr');
  tr.remove();
  recalc();
}

function recalc() {
  let totalGeral = 0;
  document.querySelectorAll('.secao-ficha').forEach(sec => {
    let subM = 0, subC = 0;
    sec.querySelectorAll('tbody tr').forEach(tr => {
      const inp = tr.querySelector('.m-inp');
      const pm  = parseFloat(tr.dataset.precom || 0);
      const m   = parseFloat(inp.value) || 0;
      subM += m;
      subC += m * pm;
    });
    const footTd = sec.querySelectorAll('tfoot td');
    if (footTd[1]) footTd[1].textContent = subM.toFixed(2) + 'm';
    if (footTd[2]) footTd[2].textContent = 'R$ ' + fmt(subC);
    totalGeral += subC;
    const hdr = sec.querySelector('.sec-total');
    if (hdr) hdr.textContent = subM.toFixed(2) + 'm total';
  });
  const totEl = document.getElementById('total-geral-val');
  if (totEl) totEl.textContent = 'R$ ' + fmt(totalGeral);
}

function renderFicha() {
  const body = document.getElementById('body-ficha');
  let html = '';
  GRUPOS.forEach((g, gi) => {
    const subM = g.cores.reduce((s,c) => s + c.metros, 0);
    const subC = g.cores.reduce((s,c) => s + c.metros * c.precoM, 0);
    const linhas = g.cores.map((c, idx) => \`
      <tr style="background:\${idx%2===1?'#faf8f5':'#fff'}" data-precom="\${c.precoM.toFixed(4)}">
        <td style="padding:10px 16px;border-bottom:1px solid #f0ece6;font-weight:700;font-size:14px">\${c.cor}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #f0ece6;text-align:center">
          <input class="m-inp" type="number" min="0" step="0.5" value="\${c.metros.toFixed(2)}" oninput="recalc()">
        </td>
        <td style="padding:10px 16px;border-bottom:1px solid #f0ece6;text-align:right;font-size:10px;color:#aaa">R$ \${fmt(c.metros * c.precoM)}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #f0ece6;font-size:10px;color:#bbb">\${c.modelos.join(', ')}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0ece6" class="no-print">
          <button class="btn-rem" onclick="removerLinha(this)" title="Remover cor">×</button>
        </td>
      </tr>\`).join('');
    html += \`
      <div class="secao-ficha" style="margin-bottom:32px">
        <div style="border-bottom:2px solid #C4A882;padding-bottom:6px;margin-bottom:0;display:flex;justify-content:space-between;align-items:flex-end">
          <span style="font-size:22px;font-weight:900;letter-spacing:0.02em;color:#111">\${g.tecido}</span>
          <span class="sec-total" style="font-size:12px;font-weight:700;color:#9A7A56">\${subM.toFixed(2)}m total</span>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#F5F0E8">
              <th style="padding:7px 16px;text-align:left;font-size:10px;letter-spacing:0.06em;color:#9a8870;font-weight:800;text-transform:uppercase">Cor</th>
              <th style="padding:7px 16px;text-align:center;font-size:10px;letter-spacing:0.06em;color:#9a8870;font-weight:800;text-transform:uppercase">Metros</th>
              <th style="padding:7px 16px;text-align:right;font-size:10px;letter-spacing:0.06em;color:#9a8870;font-weight:800;text-transform:uppercase">Total (R$)</th>
              <th style="padding:7px 16px;font-size:10px;letter-spacing:0.06em;color:#9a8870;font-weight:800;text-transform:uppercase">Modelos</th>
              <th class="no-print"></th>
            </tr>
          </thead>
          <tbody>\${linhas}</tbody>
          <tfoot>
            <tr style="background:#F5F0E8;border-top:1.5px solid #C4A882">
              <td style="padding:10px 16px;font-weight:800;font-size:12px">Total \${g.tecido}</td>
              <td style="padding:10px 16px;text-align:center;font-weight:900;font-size:15px;color:#9A7A56">\${subM.toFixed(2)}m</td>
              <td style="padding:10px 16px;text-align:right;font-weight:900;font-size:14px;color:#9A7A56">R$ \${fmt(subC)}</td>
              <td></td><td class="no-print"></td>
            </tr>
          </tfoot>
        </table>
      </div>\`;
  });

  html += \`
    <div class="obs-label">Observações ao fornecedor</div>
    <div class="obs-box" contenteditable="true" style="outline:none"></div>
    <div style="display:flex;justify-content:flex-end;align-items:center;gap:16px;padding:12px 0;border-top:1.5px solid #C4A882;margin-top:8px">
      <span style="font-size:9px;font-weight:800;letter-spacing:0.1em;color:#9a8870;text-transform:uppercase">Valor Estimado Total</span>
      <span id="total-geral-val" style="font-size:16px;font-weight:900;color:#9A7A56">R$ \${fmt(GRUPOS.reduce((s,g) => s + g.cores.reduce((ss,c) => ss + c.metros*c.precoM, 0), 0))}</span>
    </div>\`;

  body.innerHTML = html;
}

renderFicha();
<\/script>
</body>
</html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
}

function gerarFichaProducaoGeral() {
  const hoje = new Date().toLocaleDateString('pt-BR');

  // Mesma lógica do card "EM PRODUÇÃO" do dashboard (cada leva com o próprio status)
  const prodList = [];
  for (const [key, def] of Object.entries(MODELOS)) {
    if (CONJUNTO_PECAS[key]) continue;
    const saved = loadLocal('vc:' + key) || {};
    const cores = coresDoModelo(def, saved);
    [{ prod: saved.prod, status: saved.status, sufixo: '' },
     { prod: saved.prod2, status: saved.status2, sufixo: ' — 2ª leva' }].forEach(l => {
      if (!['Comprando tecido', 'Em corte', 'Em costura'].includes(l.status)) return;
      let total = 0;
      cores.forEach(cor => {
        const pv = l.prod && l.prod[cor];
        if (pv) total += pv.reduce((a,b) => (a||0)+(b||0), 0);
      });
      if (total > 0) prodList.push({ nome: def.nome + l.sufixo, status: l.status, total });
    });
  }

  if (prodList.length === 0) {
    alert('Nenhum modelo em produção no momento.');
    return;
  }

  prodList.sort((a,b) => b.total - a.total);
  const totalGeral = prodList.reduce((s,p) => s + p.total, 0);

  const linhas = prodList.map((p, idx) => `
    <tr style="background:${idx % 2 === 1 ? '#faf8f5' : '#fff'}">
      <td style="padding:10px 16px;border-bottom:1px solid #f0ece6;font-weight:700;font-size:14px">${p.nome}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #f0ece6;text-align:center;font-size:12px;color:#0891b2;font-weight:600">${p.status}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #f0ece6;text-align:center;font-weight:800;font-size:14px">${p.total}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Ficha de Produção — ${hoje}</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:Arial,sans-serif; color:#111; background:#fff; font-size:13px; }
  .header { background:#111; color:#fff; padding:20px 32px 16px; display:flex; justify-content:space-between; align-items:flex-end; }
  .brand  { font-size:8px; font-weight:700; letter-spacing:0.18em; color:#C4A882; margin-bottom:6px; text-transform:uppercase; }
  .titulo { font-size:28px; font-weight:900; letter-spacing:0.06em; line-height:1; }
  .header-meta { text-align:right; font-size:11px; color:#aaa; line-height:2; }
  .header-meta strong { color:#C4A882; }
  .resumo { background:#F5F0E8; border-bottom:2px solid #C4A882; padding:14px 32px; display:flex; gap:40px; flex-wrap:wrap; align-items:flex-end; }
  .rl { font-size:8px; font-weight:800; letter-spacing:0.1em; color:#9a8870; text-transform:uppercase; margin-bottom:2px; }
  .rv { font-size:13px; font-weight:700; color:#111; }
  .rv-destaque { font-size:26px; font-weight:900; color:#111; letter-spacing:-0.01em; line-height:1; }
  .body { padding:24px 32px; }
  table { width:100%; border-collapse:collapse; }
  thead tr { background:#F5F0E8; }
  thead th { padding:8px 16px; text-align:left; font-size:10px; letter-spacing:0.06em; color:#9a8870; font-weight:800; text-transform:uppercase; }
  thead th:not(:first-child) { text-align:center; }
  tfoot tr { background:#111; }
  tfoot td { padding:10px 16px; color:#fff; font-weight:800; }
  tfoot td:not(:first-child) { text-align:center; color:#C4A882; }
  .footer { background:#111; color:#666; font-size:8px; padding:8px 32px; display:flex; justify-content:space-between; letter-spacing:0.06em; }
  .footer span { color:#C4A882; font-weight:700; }
  .toolbar { position:sticky; top:0; z-index:99; background:#1a1a1a; padding:10px 32px; display:flex; align-items:center; justify-content:flex-end; }
  .btn-print { background:#C4A882; color:#111; font-weight:800; font-size:13px; border:none; border-radius:4px; padding:8px 22px; cursor:pointer; letter-spacing:0.04em; }
  .btn-print:hover { background:#d4b892; }
  @media print {
    .toolbar { display:none !important; }
    @page { margin:0; size:A4 portrait; }
    body { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  }
</style>
</head>
<body>

<div class="toolbar no-print">
  <button class="btn-print" onclick="window.print()">🖨️ Imprimir Ficha</button>
</div>

<div class="header">
  <div>
    <div class="brand">Vista Conecte &nbsp;•&nbsp; Gestão de Confecção</div>
    <div class="titulo">FICHA DE PRODUÇÃO</div>
  </div>
  <div class="header-meta">
    <div>Data <strong>${hoje}</strong></div>
    <div>Modelos <strong>${prodList.length}</strong></div>
  </div>
</div>

<div class="resumo">
  <div><div class="rl">Total em Produção</div><div class="rv-destaque">${totalGeral} peças</div></div>
</div>

<div class="body">
  <table>
    <thead><tr>
      <th>Modelo</th>
      <th>Status</th>
      <th>Peças</th>
    </tr></thead>
    <tbody>${linhas}</tbody>
    <tfoot><tr>
      <td>Total</td>
      <td></td>
      <td>${totalGeral}</td>
    </tr></tfoot>
  </table>
</div>

<div class="footer">
  <div>VISTA CONECTE &nbsp;•&nbsp; FICHA DE PRODUÇÃO</div>
  <div>Gerado em <span>${hoje}</span></div>
</div>

</body>
</html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
}

function gerarFichaConfeccao() {
  const hoje = new Date().toLocaleDateString('pt-BR');

  // Coleta modelos com alguma leva em "Comprando tecido"
  // (leva 1 com fallback Pedidos − Estoque; 2ª leva só o digitado, somadas por cor)
  const lista = [];
  for (const [key, def] of Object.entries(MODELOS)) {
    if (CONJUNTO_PECAS[key]) continue;
    const saved = loadLocal('vc:' + key) || {};
    if (saved.status !== 'Comprando tecido' && saved.status2 !== 'Comprando tecido') continue;
    const tu    = !!def.tamanhoUnico;
    const cores = coresDoModelo(def, saved);
    const linhas = [];
    let totalModelo = 0;
    cores.forEach(cor => {
      let vals = [0, 0, 0, 0, 0];
      if (saved.status === 'Comprando tecido') {
        const pv = saved.prod && saved.prod[cor];
        if (pv) {
          vals = vals.map((v,i) => v + (pv[i] || 0));
        } else {
          // Fallback da leva 1: Pedidos − Estoque − 2ª leva (tamanhoUnico soma tudo na posição 0)
          const ab   = def.aberto[cor] || [0,0,0,0,0];
          const ev   = saved.est && saved.est[cor] || [0,0,0,0,0];
          const p2   = saved.prod2 && saved.prod2[cor] || [];
          const nec  = necessidadeLeva(ab, ev, p2, tu, vals.length);
          vals = vals.map((v,i) => v + (nec[i] || 0));
        }
      }
      if (saved.status2 === 'Comprando tecido') {
        const pv2 = saved.prod2 && saved.prod2[cor];
        if (pv2) vals = vals.map((v,i) => v + (pv2[i] || 0));
      }
      const tot = vals.reduce((a,b) => a+b, 0);
      if (tot === 0) return;
      totalModelo += tot;
      linhas.push({ cor, vals, tot });
    });
    if (totalModelo === 0) continue;
    // Totais por tamanho
    const totSizes = [0,0,0,0,0];
    linhas.forEach(l => l.vals.forEach((v,i) => totSizes[i] += v));
    lista.push({ nome: def.nome, tu, linhas, totalModelo, totSizes });
  }

  if (lista.length === 0) {
    alert('Nenhum modelo com status "Comprando tecido" encontrado.');
    return;
  }

  const totalGeral = lista.reduce((s,m) => s + m.totalModelo, 0);

  const secoes = lista.map(m => {
    const corRows = m.linhas.map((l, idx) => `
      <tr style="background:${idx%2===1?'#fafafa':'#fff'}">
        <td style="padding:9px 14px;border-bottom:1px solid #eee;font-weight:600;font-size:13px">${l.cor}</td>
        ${m.tu
          ? `<td colspan="5" style="padding:9px 14px;border-bottom:1px solid #eee;text-align:center;font-size:13px;color:#555">Tamanho único</td>`
          : l.vals.map(v => `<td style="padding:9px 14px;border-bottom:1px solid #eee;text-align:center;font-size:14px;font-weight:${v>0?'700':'400'};color:${v>0?'#111':'#ccc'}">${v>0?v:'—'}</td>`).join('')
        }
        <td style="padding:9px 14px;border-bottom:1px solid #eee;text-align:center;font-weight:900;font-size:15px;color:#7C3AED">${l.tot}</td>
      </tr>`).join('');

    const footRow = m.tu
      ? `<td colspan="5" style="padding:9px 14px;text-align:center">—</td>`
      : m.totSizes.map(v => `<td style="padding:9px 14px;text-align:center;font-weight:700;font-size:13px">${v>0?v:'—'}</td>`).join('');

    return `
      <div style="margin-bottom:28px;page-break-inside:avoid">
        <div style="background:#7C3AED;color:#fff;padding:10px 16px;border-radius:4px 4px 0 0;display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:16px;font-weight:800;letter-spacing:0.03em">${m.nome}</span>
          <span style="font-size:13px;font-weight:700;opacity:0.9">${m.totalModelo} peças</span>
        </div>
        <table style="width:100%;border-collapse:collapse;border:1px solid #e5e0f5;border-top:none">
          <thead>
            <tr style="background:#f3f0fb">
              <th style="padding:7px 14px;text-align:left;font-size:10px;letter-spacing:0.06em;color:#7C3AED;font-weight:800;text-transform:uppercase">Cor</th>
              ${m.tu
                ? `<th colspan="5" style="padding:7px 14px;text-align:center;font-size:10px;letter-spacing:0.06em;color:#7C3AED;font-weight:800;text-transform:uppercase">Tamanho</th>`
                : ['PP','P','M','G','GG'].map(s => `<th style="padding:7px 14px;text-align:center;font-size:10px;letter-spacing:0.06em;color:#7C3AED;font-weight:800;text-transform:uppercase">${s}</th>`).join('')
              }
              <th style="padding:7px 14px;text-align:center;font-size:10px;letter-spacing:0.06em;color:#7C3AED;font-weight:800;text-transform:uppercase">Total</th>
            </tr>
          </thead>
          <tbody>${corRows}</tbody>
          <tfoot>
            <tr style="background:#f3f0fb;border-top:2px solid #7C3AED">
              <td style="padding:9px 14px;font-weight:800;font-size:12px">Total</td>
              ${footRow}
              <td style="padding:9px 14px;text-align:center;font-weight:900;font-size:16px;color:#7C3AED">${m.totalModelo}</td>
            </tr>
          </tfoot>
        </table>
      </div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Ficha de Confecção — ${hoje}</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:Arial,sans-serif; color:#111; background:#fff; font-size:13px; }
  .header { background:#111; color:#fff; padding:20px 32px 16px; display:flex; justify-content:space-between; align-items:flex-end; }
  .brand  { font-size:8px; font-weight:700; letter-spacing:0.18em; color:#A78BFA; margin-bottom:6px; text-transform:uppercase; }
  .titulo { font-size:28px; font-weight:900; letter-spacing:0.06em; line-height:1; }
  .header-meta { text-align:right; font-size:11px; color:#aaa; line-height:2; }
  .header-meta strong { color:#A78BFA; }
  .resumo { background:#f3f0fb; border-bottom:2px solid #7C3AED; padding:12px 32px; display:flex; gap:40px; align-items:center; }
  .rl { font-size:8px; font-weight:800; letter-spacing:0.1em; color:#7C3AED; text-transform:uppercase; margin-bottom:2px; }
  .rv { font-size:13px; font-weight:700; color:#111; }
  .rv-big { font-size:22px; font-weight:900; color:#7C3AED; }
  .body { padding:24px 32px; }
  .footer { background:#111; color:#666; font-size:8px; padding:8px 32px; display:flex; justify-content:space-between; letter-spacing:0.06em; }
  .footer span { color:#A78BFA; font-weight:700; }
  @media print { @page { margin:0; size:A4 portrait; } body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="brand">Vista Conecte &nbsp;•&nbsp; Gestão de Confecção</div>
    <div class="titulo">FICHA DE CONFECÇÃO</div>
  </div>
  <div class="header-meta">
    <div>Data <strong>${hoje}</strong></div>
    <div>Modelos <strong>${lista.length}</strong></div>
    <div>Total <strong>${totalGeral} peças</strong></div>
  </div>
</div>

<div class="resumo">
  <div><div class="rl">Modelos</div><div class="rv">${lista.map(m=>m.nome).join(' · ')}</div></div>
  <div style="margin-left:auto"><div class="rl">Total de Peças</div><div class="rv-big">${totalGeral}</div></div>
</div>

<div class="body">
  ${secoes}
</div>

<div class="footer">
  <div>VISTA CONECTE &nbsp;•&nbsp; FICHA DE CONFECÇÃO</div>
  <div>Gerado em <span>${hoje}</span></div>
</div>

<script>window.onload = () => window.print();<\/script>
</body>
</html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
}

function gerarFichaCompra() {
  const def     = MODELOS[modeloAtual];
  const saved   = loadLocal('vc:' + modeloAtual) || {};
  const nome    = saved.nome    || def.nome;
  const tecido  = saved.tecido  || def.tecido;
  const consumo = saved.consumo || def.consumo;
  const preco   = parseFloat(document.getElementById('preco-m').value) || 0;
  const hoje    = new Date().toLocaleDateString('pt-BR');

  // Coleta dados de produção (mesma lógica de atualizarTecido).
  // Com 2ª leva ativa: entram só as levas com status "Comprando tecido"
  // (se nenhuma tiver, entram as duas). Sem 2ª leva: comportamento original.
  const statusL1 = document.getElementById('prod-status')?.value || '';
  const statusL2 = document.getElementById('prod2-status')?.value || '';
  const leva2Ativa = document.querySelectorAll('#prod2-tbody tr').length > 0;
  let incluiL1 = true, incluiL2 = leva2Ativa;
  if (leva2Ativa && (statusL1 === 'Comprando tecido' || statusL2 === 'Comprando tecido')) {
    incluiL1 = statusL1 === 'Comprando tecido';
    incluiL2 = statusL2 === 'Comprando tecido';
  }
  const porCorFC = {};
  const lerFC = sel => {
    document.querySelectorAll(sel + ' tr').forEach(row => {
      const cor   = row.dataset.cor;
      const vals  = Array.from(row.querySelectorAll('input')).map(i => parseInt(i.value) || 0);
      const pecas = vals.reduce((a, b) => a + b, 0);
      if (pecas > 0) porCorFC[cor] = (porCorFC[cor] || 0) + pecas;
    });
  };
  if (incluiL1) lerFC('#prod-tbody');
  if (incluiL2) lerFC('#prod2-tbody');
  const dados = Object.entries(porCorFC).map(([cor, pecas]) => ({ cor, pecas, metros: pecas * consumo, custo: pecas * consumo * preco }));

  if (dados.length === 0) {
    alert('Nenhuma peça em produção para gerar a ficha de compra.');
    return;
  }

  const totalPecas  = dados.reduce((a, d) => a + d.pecas,  0);
  const totalMetros = dados.reduce((a, d) => a + d.metros, 0);
  const totalCusto  = dados.reduce((a, d) => a + d.custo,  0);

  const linhas = dados.map((d, idx) => `
    <tr style="background:${idx % 2 === 1 ? '#faf8f5' : '#fff'}">
      <td style="padding:10px 14px;border:1px solid #e5e7eb;font-weight:600">${d.cor}</td>
      <td style="padding:10px 14px;border:1px solid #e5e7eb;text-align:center;font-weight:700">${d.metros.toFixed(2)}m</td>
      <td style="padding:10px 14px;border:1px solid #e5e7eb;text-align:right;font-size:10px;color:#aaa">R$ ${fmt(preco)}</td>
      <td style="padding:10px 14px;border:1px solid #e5e7eb;text-align:right;font-size:10px;color:#bbb">R$ ${fmt(d.custo)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Ficha de Compra — ${nome}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; color: #111; background: #fff; font-size: 13px; }

  .header { background: #111; color: #fff; padding: 20px 32px 16px; display: flex; justify-content: space-between; align-items: flex-end; }
  .brand  { font-size: 8px; font-weight: 700; letter-spacing: 0.18em; color: #C4A882; margin-bottom: 6px; text-transform: uppercase; }
  .titulo { font-size: 28px; font-weight: 900; letter-spacing: 0.06em; line-height: 1; }
  .header-meta { text-align: right; font-size: 11px; color: #aaa; line-height: 2; }
  .header-meta strong { color: #C4A882; }

  .strip { background: #F5F0E8; border-bottom: 2px solid #C4A882; padding: 14px 32px; display: flex; gap: 40px; flex-wrap: wrap; align-items: flex-end; }
  .strip-item { display: flex; flex-direction: column; gap: 3px; }
  .strip-label { font-size: 8px; font-weight: 800; letter-spacing: 0.1em; color: #9a8870; text-transform: uppercase; }
  .strip-val   { font-size: 13px; font-weight: 700; color: #111; }
  .strip-item-destaque .strip-label { font-size: 9px; color: #7a6040; }
  .strip-item-destaque .strip-val   { font-size: 26px; font-weight: 900; color: #111; letter-spacing: -0.01em; line-height: 1; }

  .body { padding: 24px 32px; }

  .section-title { font-size: 9px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: #C4A882; margin-bottom: 10px; }

  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  thead tr { background: #111; }
  thead th { color: #fff; padding: 10px 14px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-align: center; border: 1px solid #333; }
  thead th:first-child { text-align: left; }

  .total-row td { background: #111 !important; color: #fff; font-weight: 800; padding: 10px 14px; border: 1px solid #333; text-align: center; }
  .total-row td:first-child { text-align: left; }
  .total-row .gold { color: #C4A882; }

  .obs-box { border: 1px solid #e0d8cc; border-radius: 4px; padding: 14px 16px; background: #faf8f5; min-height: 80px; margin-bottom: 24px; }
  .obs-label { font-size: 8px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: #C4A882; margin-bottom: 6px; }

  .footer { background: #111; color: #666; font-size: 8px; padding: 8px 32px; display: flex; justify-content: space-between; letter-spacing: 0.06em; margin-top: auto; }
  .footer span { color: #C4A882; font-weight: 700; }

  .assinatura { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px; }
  .ass-campo { border-top: 1.5px solid #111; padding-top: 6px; font-size: 10px; color: #666; text-align: center; padding-bottom: 32px; }

  @media print { @page { margin: 0; size: A4 portrait; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="brand">Vista Conecte &nbsp;•&nbsp; Gestão de Confecção</div>
    <div class="titulo">FICHA DE COMPRA</div>
  </div>
  <div class="header-meta">
    <div>Data <strong>${hoje}</strong></div>
    <div>Modelo <strong>${nome}</strong></div>
    <div>Tecido <strong>${tecido}</strong></div>
  </div>
</div>

<div class="strip">
  <div class="strip-item strip-item-destaque"><div class="strip-label">Tecido</div><div class="strip-val">${tecido}</div></div>
  <div class="strip-item"><div class="strip-label">Modelo</div><div class="strip-val">${nome}</div></div>
  <div class="strip-item"><div class="strip-label">Consumo / Peça</div><div class="strip-val">${consumo}m</div></div>
  <div class="strip-item"><div class="strip-label">Total de Peças</div><div class="strip-val">${totalPecas} pcs</div></div>
  <div class="strip-item"><div class="strip-label">Total de Metros</div><div class="strip-val">${totalMetros.toFixed(2)}m</div></div>
  <div class="strip-item"><div class="strip-label">Valor Total</div><div class="strip-val" style="color:#9A7A56">R$ ${fmt(totalCusto)}</div></div>
</div>

<div class="body">

  <div class="section-title">Metragem necessária por cor</div>
  <table>
    <thead>
      <tr>
        <th style="text-align:left;width:30%">Cor</th>
        <th>Metros Necessários</th>
        <th>Valor / Metro</th>
        <th>Total (R$)</th>
      </tr>
    </thead>
    <tbody>${linhas}</tbody>
    <tfoot>
      <tr class="total-row">
        <td>TOTAL GERAL</td>
        <td class="gold">${totalMetros.toFixed(2)}m</td>
        <td style="color:#C4A882;font-style:italic;font-weight:700;font-size:13px;letter-spacing:0.03em">Valor variável</td>
        <td class="gold">R$ ${fmt(totalCusto)}</td>
      </tr>
    </tfoot>
  </table>

  <div class="obs-label">Observações / Instruções ao fornecedor</div>
  <div class="obs-box"></div>

  <div class="assinatura">
    <div class="ass-campo">Fornecedor</div>
    <div class="ass-campo">Vista Conecte — Responsável</div>
  </div>

</div>

<div class="footer">
  <div>VISTA CONECTE &nbsp;•&nbsp; FICHA DE COMPRA DE TECIDO</div>
  <div>Gerado em <span>${hoje}</span></div>
</div>

<script>window.onload = () => window.print();<\/script>
</body>
</html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
}

async function carregarPedidosShopify() {
  // Os perfis de oficina não têm acesso a /api/shopify-orders (as fichas saem do que já
  // veio do Supabase). Sem esta saída, o middleware devolveria 403 a cada minuto.
  if (ehPerfilOficina()) return;
  try {
    const res = await fetch('/api/shopify-orders');
    if (!res.ok) return;
    const resp = await res.json();
    const data = resp.pedidos || resp; // API retorna { pedidos:{...}, ignorados:[...] }
    // Guarda ignorados para diagnóstico
    window._shopifyIgnorados = resp.ignorados || [];
    // Cores que a API ADIVINHOU por regra fixa em vez de ler do pedido — alarme
    window._shopifyCoresAssumidas = resp.cores_assumidas || [];
    window._shopifyTotalPedidos = resp.total_pedidos || 0;
    // Guarda detalhe por pedido (número, cliente, data, itens) p/ card "Prontos para envio"
    window._shopifyDetalhados = resp.detalhados || [];
    // Pedidos que a Shopify já processou (envio criado) — fonte da baixa de estoque
    window._shopifyProcessados = resp.processados || [];

    // Zera aberto de todos os modelos antes de preencher
    for (const key of Object.keys(MODELOS)) {
      for (const cor of Object.keys(MODELOS[key].aberto)) {
        MODELOS[key].aberto[cor] = Array(MODELOS[key].tamanhos?.length || 5).fill(0);
      }
    }

    // Pedido em tamanho que o modelo não tem (ex.: G1 num modelo de grade PP..GG) era
    // truncado aqui e sumia sem deixar rastro. Agora vira aviso na faixa.
    window._shopifyForaDaGrade = [];

    for (const [modelKey, coresDados] of Object.entries(data)) {
      if (!MODELOS[modelKey]) continue;
      const sz = MODELOS[modelKey].tamanhos?.length || 5;
      for (const [cor, qtds] of Object.entries(coresDados)) {
        // Casa a cor com a que o modelo já conhece ignorando caixa/acento ("CINZA" soma em "Cinza",
        // senão vira uma cor separada que não aparece na tela). Soma em vez de atribuir porque
        // o mesmo modelo pode receber a mesma cor grafada de dois jeitos.
        const c = corCanonica(MODELOS[modelKey], cor);
        const base = MODELOS[modelKey].aberto[c] || Array(sz).fill(0);
        // Tamanho além da grade do modelo (ex.: G1 num modelo PP..GG): a peça NÃO some —
        // entra no maior tamanho da grade, que é o GG. Regra definida pela Bárbara em
        // 29/07/2026 para o Carneirinho Cropped e vale para qualquer modelo sem G1.
        const extra = (qtds || []).slice(sz).reduce((a, b) => a + (b || 0), 0);
        MODELOS[modelKey].aberto[c] = Array(sz).fill(0).map((_, i) => (base[i] || 0) + (qtds[i] || 0));
        if (extra > 0) {
          MODELOS[modelKey].aberto[c][sz - 1] += extra;
          window._shopifyForaDaGrade.push({ modelo: modelKey, cor: c, qtd: extra, caiuEm: tamanhosDe(MODELOS[modelKey])[sz - 1] });
        }
      }
    }

    // Distribui pedidos de conjuntos para as peças individuais.
    // A cor de cada peça sai de pecasDoConjunto (cor combinada, cor fixa ou a própria cor).
    for (const conjuntoKey of Object.keys(CONJUNTO_PECAS)) {
      if (!MODELOS[conjuntoKey]) continue;
      for (const [cor, qtds] of Object.entries(MODELOS[conjuntoKey].aberto)) {
        const total = qtds.reduce((a, b) => (a || 0) + (b || 0), 0);
        if (total === 0) continue;
        for (const { key: pecaKey, cor: pecaCor } of pecasDoConjunto(conjuntoKey, cor)) {
          const pecaSz = MODELOS[pecaKey].tamanhos?.length || 5;
          if (!MODELOS[pecaKey].aberto[pecaCor]) {
            MODELOS[pecaKey].aberto[pecaCor] = Array(pecaSz).fill(0);
          }
          // Usa || 0 para proteger contra undefined em arrays esparsos
          MODELOS[pecaKey].aberto[pecaCor] = MODELOS[pecaKey].aberto[pecaCor].map((v, i) => (v || 0) + (qtds[i] || 0));
        }
      }
    }

    verificarLeituraPedidos();
  } catch (_) {}
}

// Trava antes de gravar produção: se a leitura dos pedidos DESTE modelo tem aviso
// (cor adivinhada, item ignorado, cor não cadastrada), pede confirmação em vez de
// gravar calado. Recalcular grava por cima do que a costura já tem — o dado errado
// aqui vira compra de tecido errada.
function confirmarLeituraConfiavel(key) {
  const avisos = (window._avisosLeitura || []).filter(a => a.modelo === key);
  if (avisos.length === 0) return true;
  const txt = avisos.map(a => '• ' + a.texto.replace(/<[^>]+>/g, '')).join('\n');
  return confirm(
    'ATENÇÃO — a leitura dos pedidos deste modelo tem pendência:\n\n' + txt +
    '\n\nRecalcular agora vai gravar a produção em cima desses números, que podem estar ' +
    'na cor errada ou incompletos.\n\nQuer recalcular mesmo assim?'
  );
}

// ─── AUDITORIA DA LEITURA DE PEDIDOS ─────────────────────────────────────────
// Rede de segurança: um pedido só entra na produção se o sistema souber DE VERDADE
// o modelo e a cor. Quando ele adivinha (regra fixa), ignora um item ou joga o pedido
// numa cor que o modelo não tem, isso aparece aqui em vez de virar número silencioso.
// Motivo: em 07/2026 uma regra antiga apagou a cor real de todos os pedidos de
// Calça Peace/Conjunto Peace e a produção foi comprada em cima do dado errado.
// Avisos já conferidos pela dona ficam guardados na nuvem (id `avisos-conferidos`),
// então somem no PC e no celular. A assinatura inclui a COR — se a regra mudar a cor
// de novo, o aviso volta a aparecer para ser conferido outra vez.
const AVISOS_KEY = 'avisos-conferidos';
const avisoAssinatura = a => [a.tipo, a.modelo || '', a.texto.replace(/<[^>]+>/g, '')].join('|');

function avisosConferidos() {
  return (loadLocal('vc:' + AVISOS_KEY) || {}).conferidos || {};
}

function marcarAvisoConferido(assinatura) {
  const dados = loadLocal('vc:' + AVISOS_KEY) || { conferidos: {} };
  dados.conferidos = dados.conferidos || {};
  dados.conferidos[assinatura] = new Date().toISOString();
  dados.updated_at = new Date().toISOString();
  saveLocal('vc:' + AVISOS_KEY, dados);
  salvarNuvem(AVISOS_KEY, dados);
  verificarLeituraPedidos();
}

function auditarLeituraPedidos() {
  const avisos = [];

  (window._shopifyCoresAssumidas || []).forEach(c => {
    avisos.push({
      tipo: 'cor-assumida',
      texto: `${c.pedido}: "${c.item}"${c.variante ? ' (' + c.variante + ')' : ''} — cor <b>${c.corAssumida}</b> foi assumida por regra fixa, não veio do pedido`,
      modelo: c.modelo,
    });
  });

  (window._shopifyIgnorados || []).forEach(txt => {
    avisos.push({ tipo: 'ignorado', texto: `Item fora da produção — ${txt}`, modelo: null });
  });

  // Tamanho fora da grade NÃO vira aviso: por regra, cai no maior tamanho do modelo
  // (fica registrado em window._shopifyForaDaGrade para diagnóstico).

  // Pedido caiu numa cor que o modelo não tem cadastrada
  for (const [key, def] of Object.entries(MODELOS)) {
    const cadastradas = new Set([...(def.cores || []), ...((loadLocal('vc:' + key) || {}).cores || [])].map(chaveCor));
    Object.entries(def.aberto || {}).forEach(([cor, qt]) => {
      if (!(qt || []).some(v => v > 0)) return;
      if (!cadastradas.has(chaveCor(cor))) {
        const n = qt.reduce((a, b) => a + (b || 0), 0);
        avisos.push({ tipo: 'cor-nova', texto: `<b>${def.nome}</b>: ${n} peça(s) na cor "<b>${cor}</b>", que não está cadastrada no modelo`, modelo: key });
      }
    });
  }

  // Tira os que a dona já conferiu (ex.: cor assumida que ela confirmou estar certa)
  const conferidos = avisosConferidos();
  const pendentes = avisos.filter(a => !conferidos[avisoAssinatura(a)]);

  window._avisosLeitura = pendentes;
  window._avisosLeituraTodos = avisos;
  return pendentes;
}

function verificarLeituraPedidos() {
  const avisos = auditarLeituraPedidos();
  const el = document.getElementById('faixa-leitura');
  if (avisos.length === 0) { if (el) el.remove(); return; }
  const btnStyle = 'background:#fff;color:#b45309;border:0;border-radius:5px;padding:3px 10px;' +
                   'font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0';
  const linhas = avisos.slice(0, 8).map(a =>
    `<div style="display:flex;align-items:center;gap:10px;padding:3px 0">
       <div style="flex:1">• ${a.texto}</div>
       <button title="Já conferi, está correto — não mostrar de novo"
               onclick="marcarAvisoConferido(${JSON.stringify(avisoAssinatura(a)).replace(/"/g, '&quot;')})"
               style="${btnStyle}">✓ conferido</button>
     </div>`).join('');
  const html =
    `<div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
       <div style="flex:1;min-width:260px">
         <div style="font-weight:700;margin-bottom:4px">
           <i class="ti ti-alert-triangle"></i> Confira a leitura dos pedidos (${avisos.length})
           <button onclick="verIgnoradosShopify()" title="Abre a lista completa de itens que a leitura não reconheceu"
                   style="background:transparent;border:0;color:#fff;text-decoration:underline;font-size:11px;font-weight:600;cursor:pointer;padding:0 0 0 8px">ver diagnóstico</button>
         </div>
         <div style="font-size:12px;line-height:1.6">${linhas}
         ${avisos.length > 8 ? `<div style="padding-top:4px"><i>…e mais ${avisos.length - 8}</i></div>` : ''}</div>
         <div style="font-size:11px;margin-top:6px;opacity:.85">Enquanto isso não for resolvido, esses pedidos podem estar na cor errada ou fora da conta de produção. O "conferido" vale para este pedido e some no celular também.</div>
       </div>
       <button onclick="this.closest('#faixa-leitura').remove()" style="background:transparent;border:1px solid rgba(255,255,255,.6);color:#fff;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer">Ocultar</button>
     </div>`;
  if (el) { el.innerHTML = html; return; }
  const div = document.createElement('div');
  div.id = 'faixa-leitura';
  div.style.cssText = 'position:sticky;top:0;z-index:900;background:#b45309;color:#fff;padding:12px 16px;margin:0 0 12px;border-radius:8px';
  div.innerHTML = html;
  const alvo = document.getElementById('panel-dashboard') || document.querySelector('.content') || document.body;
  alvo.insertBefore(div, alvo.firstChild);
}

// ─── DETECÇÃO DE ENVIOS E BAIXA AUTOMÁTICA DE ESTOQUE ────────────────────────

let _enviosPendentes = null; // envios sem baixa aguardando decisão na conferência manual

// Mapa de conjuntos → peças individuais (usado em pedidos E baixa de estoque)
const CONJUNTO_PECAS = {
  'conjunto-calca-pantalona-moletom': ['calca-pantalona', 'moletom-gola-alta'],
  'conjunto-calca-pantalona-cropped': ['calca-pantalona', 'cropped-moletom'],
  'conjunto-cozy':                    ['calca-pantalona', 'moletom-ziper-bolsos'],
  'conjunto-mood':                    ['calca-basica-moletom', 'moletom-ziper-bolsos'],
  'conjunto-wide':                    ['calca-pantalona', 'moletom-gola-alta'],
  'conjunto-canelado':                ['blusa-canelada', 'calca-flare'],
  // Separado em 04/08/2026: antes o Conjunto Boho era peça única (o estoque era lançado nele).
  'conjunto-boho':                    ['calca-boho', 'blusa-boho'],
  'conjunto-pantalona-blusa':         ['calca-pantalona-viscolycra', 'blusa-canelada-simples'],
  'conjunto-peace':                   ['calca-peace', 'cropped-peace'],
  'conjunto-calca-flare-moletom':     ['calca-flare', 'moletom-gola-alta'],
  'conjunto-moletom-saia-midi':       ['moletom-gola-alta', 'saia-midi'],
  'conjunto-moletom-short-bolso':     ['moletom-gola-alta', 'calca-bolso-frontal'],
  // Calça Off White + Camiseta Preta — cores fixas por peça
  'conjunto-calca-bolso-camiseta':    [
    { key: 'calca-bolso-frontal', cor: 'Off White' },
    { key: 'camiseta-oversized',  cor: 'Preto'     },
  ],
  // Camiseta Oversized + Saia Midi
  'conjunto-saia-midi-oversized':     ['camiseta-oversized', 'saia-midi'],
  'conjunto-regata-mini-saia':         ['regata-oversized', 'mini-saia-canelada'],
  // Camiseta Oversized + Mini Saia Canelada
  'conjunto-camiseta-mini-saia':      ['camiseta-oversized', 'mini-saia-canelada'],
  // Cropped Canelado + Mini Saia Canelada
  'cropped-mini-saia':                ['cropped-canelado', 'mini-saia-canelada'],
  // Canguru Longo distribui para Canguru Amplo + Calça Básica Moletom
  'conjunto-canguru-longo':           ['canguru-amplo', 'calca-basica-moletom'],
};

// Cores COMBINADAS: a variante do conjunto descreve as duas peças de uma vez
// ("Verde Militar + Preta" = camiseta militar + mini saia preta). Sem este mapa a cor
// combinada vira uma cor que não existe em peça nenhuma, e o pedido fica sem estoque
// possível — travado para sempre. Confirmado com a Bárbara em 28/07/2026.
const CONJUNTO_CORES_COMBINADAS = {
  'conjunto-camiseta-mini-saia': {
    'Verde Militar + Preta': { 'camiseta-oversized': 'Militar', 'mini-saia-canelada': 'Preto' },
    'Marsala + Nude':        { 'camiseta-oversized': 'Marsala', 'mini-saia-canelada': 'Nude'  },
  },
};

// Resolve as peças de um pedido de conjunto e a COR de cada peça.
// Fonte única: usada tanto na distribuição dos pedidos quanto na liberação de estoque —
// antes a regra estava escrita nos dois lugares e uma delas ficou desatualizada.
function pecasDoConjunto(conjuntoKey, cor) {
  const pecas = CONJUNTO_PECAS[conjuntoKey];
  if (!pecas) return [];
  const combinada = (CONJUNTO_CORES_COMBINADAS[conjuntoKey] || {})[cor];
  const ALIAS = { 'Branca': 'Branco' }; // Branco é cor própria, não Off White
  return pecas.map(p => {
    const key = typeof p === 'string' ? p : p.key;
    if (!MODELOS[key]) return null;
    let corPeca;
    if (combinada && combinada[key]) corPeca = combinada[key];
    else if (typeof p !== 'string')  corPeca = p.cor;
    else {
      const alias = ALIAS[cor] || cor;
      corPeca = MODELOS[key].aberto.hasOwnProperty(alias) ? alias : corCanonica(MODELOS[key], alias);
    }
    return { key, cor: corPeca };
  }).filter(Boolean);
}


// ─── CONFERÊNCIA MANUAL DE ENVIOS SEM BAIXA ──────────────────────────────────
// Rede de segurança do botão "conferir envios". Compara o que a Shopify diz que foi
// enviado com o registro de baixas e mostra o que ficou de fora — envio que aconteceu
// com o app fechado, ou que a automação não pegou por algum motivo.
//
// A conta é feita CONTRA O REGISTRO, não contra uma foto do total em aberto. A foto era
// o jeito antigo e não serve mais: como a baixa automática mexe no estoque sem tocar na
// foto, a diferença mostraria de novo tudo o que já foi baixado — e confirmar subtrairia
// duas vezes. Pelo registro isso não acontece: remessa já aplicada nunca reaparece.
async function verificarEnvios() {
  await carregarPedidosShopify();

  const ledger = await lerLedgerBaixas();
  if (ledger === undefined) {
    alert('Não deu para ler o registro de baixas na nuvem agora. Tente de novo em instantes.');
    return;
  }
  if (!ledger) {
    alert('O registro de baixas ainda está sendo criado. Recarregue a página e tente de novo.');
    return;
  }

  const semBaixa = (window._shopifyProcessados || []).filter(p => !ledger.envios[p.id]);
  if (semBaixa.length === 0) {
    alert('Tudo certo — todos os envios da Shopify já tiveram baixa no estoque.');
    return;
  }

  // Agrupa por modelo+cor para caber na tabela do modal (uma linha por cor, colunas = tamanhos)
  const porCor = {};
  for (const p of semBaixa) {
    for (const item of p.itens) {
      for (const r of requisitosDoItem(item)) {
        const def = MODELOS[r.key];
        if (!def) continue;
        const nSz = (def.tamanhos || ['PP','P','M','G','GG']).length;
        const ch = r.key + '|' + r.cor;
        if (!porCor[ch]) porCor[ch] = { key: r.key, nome: def.nome, cor: r.cor, delta: new Array(nSz).fill(0), total: 0 };
        const i = def.tamanhoUnico ? 0 : r.tam;
        porCor[ch].delta[i] = (porCor[ch].delta[i] || 0) + r.qtd;
        porCor[ch].total += r.qtd;
      }
    }
  }

  _enviosPendentes = { linhas: Object.values(porCor), ids: semBaixa.map(p => p.id), numeros: [...new Set(semBaixa.map(p => p.numero))] };

  const tbody = document.getElementById('modal-envios-tbody');
  tbody.innerHTML = _enviosPendentes.linhas.map(e => `
    <tr style="border-top:1px solid var(--border)">
      <td style="padding:7px 4px;font-weight:500">${e.nome}</td>
      <td style="padding:7px 4px">${e.cor}</td>
      ${e.delta.map(v => `<td style="text-align:center;padding:7px 4px;color:${v > 0 ? '#dc2626' : 'var(--text-ter)'}">${v > 0 ? '-' + v : '—'}</td>`).join('')}
      <td style="text-align:center;font-weight:700;color:#dc2626;padding:7px 4px">-${e.total}</td>
    </tr>`).join('');
  document.getElementById('modal-envios').style.display = 'flex';
}

async function confirmarBaixaEstoque() {
  const pend = _enviosPendentes;
  document.getElementById('modal-envios').style.display = 'none';
  if (!pend || !pend.ids || !pend.ids.length) return;

  const ledger = await lerLedgerBaixas();
  if (!ledger) return; // inclui undefined: sem confirmar na nuvem, não baixa

  const porId = Object.fromEntries((window._shopifyProcessados || []).map(p => [p.id, p]));
  const pecas = [];
  for (const id of pend.ids) {
    if (ledger.envios[id]) continue; // já aplicada nesse meio-tempo
    const p = porId[id];
    if (!p) continue;
    const b = await baixarEstoqueDoPedido(p.itens);
    ledger.envios[id] = { numero: p.numero, em: p.enviado_em, aplicado: new Date().toISOString(), pecas: b.length, nota: 'conferência manual' };
    pecas.push(...b);
  }
  saveLocal(LEDGER_LOCAL, ledger);
  await salvarNuvem(LEDGER_BAIXAS, ledger);

  if (pecas.length) _ultimaBaixaAuto = { quando: new Date().toISOString(), pedidos: pend.numeros, pecas };
  _enviosPendentes = null;
  if (modeloAtual === '__dashboard__') renderDashboard();
  else if (MODELOS[modeloAtual]) renderModelo(modeloAtual);
}

function fecharModalEnvios() {
  // X = só fecha, sem decidir: o registro NÃO é tocado, então os envios voltam a
  // aparecer na próxima conferência (diferente de "Ignorar")
  document.getElementById('modal-envios').style.display = 'none';
}

async function ignorarEnvios() {
  // Marca como resolvidos SEM mexer no estoque — para envio que já foi baixado na mão.
  const pend = _enviosPendentes;
  document.getElementById('modal-envios').style.display = 'none';
  if (!pend || !pend.ids) return;
  const ledger = await lerLedgerBaixas();
  if (!ledger) return; // inclui undefined: sem ler a nuvem não dá para marcar nada
  for (const id of pend.ids) {
    if (ledger.envios[id]) continue;
    const p = (window._shopifyProcessados || []).find(x => x.id === id);
    ledger.envios[id] = { numero: p && p.numero, em: p && p.enviado_em, aplicado: null, pecas: 0, nota: 'ignorado na conferência' };
  }
  saveLocal(LEDGER_LOCAL, ledger);
  await salvarNuvem(LEDGER_BAIXAS, ledger);
  _enviosPendentes = null;
}

// ─── BAIXA DE ESTOQUE NA HORA DO PROCESSAMENTO ───────────────────────────────
// Até 10/08/2026 a baixa acontecia UMA VEZ POR DIA, às 16h, e ainda dependia de a dona
// confirmar num modal. No intervalo o pedido processado já tinha saído de "pedidos em
// aberto" (some do filtro unfulfilled) mas o estoque continuava cheio — então
// "estoque − pedidos em aberto" inflava e a peça aparecia como saldo livre para outro
// pedido. Foi o que aconteceu com o Vestido Amplo PP.
//
// O processamento é feito NA SHOPIFY, não aqui. Então a fonte da verdade é ela: o
// /api/shopify-orders devolve `processados` (pedidos com envio criado, cancelados já
// filtrados) e a baixa aplica esses. Deduzir por "sumiu da lista de não-enviados" seria
// pior — o cancelado some igual e a peça dele continua na arara.
//
// Registro do que JÁ foi baixado, guardado na NUVEM (vc_modelos id=baixas-estoque).
// Precisa ser compartilhado: se ficasse só no localStorage, abrir o app no celular e no
// computador daria baixa duas vezes no mesmo pedido — o estoque é o mesmo lá e cá.
const LEDGER_BAIXAS = 'baixas-estoque';
const LEDGER_LOCAL  = 'vc:' + LEDGER_BAIXAS;

// chave 'fulfillment' = registro por REMESSA. Registro em formato antigo (por pedido) é
// tratado como inexistente: volta a semear do zero, sem baixar nada.
const LEDGER_CHAVE = 'fulfillment';

// Lê o registro DIRETO DA NUVEM, nunca do localStorage. Um aparelho que ficou horas
// dormindo (celular na tela bloqueada, aba velha aberta) tem uma cópia de antes das
// baixas do dia: para ele TODA remessa é nova e o estoque sai duas vezes. Foi o que
// aconteceu em 11/08/2026 às 19:00 — 18 envios já baixados foram baixados de novo.
//
// Três respostas diferentes, e cada uma quer um comportamento:
//   objeto    → registro válido, pode usar
//   null      → ainda não existe (ou está em formato antigo) → semear, sem baixar nada
//   undefined → não deu para ler a nuvem → NÃO fazer nada (o lado seguro é não baixar)
async function lerLedgerBaixas() {
  const l = await carregarNuvem(LEDGER_BAIXAS);
  if (l === undefined) return undefined;
  if (l && typeof l === 'object' && l.envios && l.chave === LEDGER_CHAVE) {
    saveLocal(LEDGER_LOCAL, l); // espelho local só para leitura offline; não manda mais
    return l;
  }
  return null;
}

// Datas da Shopify vêm com fuso ("...-03:00") e as nossas em Z. Comparar como TEXTO dá
// resultado errado quando o envio cruza a meia-noite — o envio virava "antigo" e nunca
// tinha baixa. Sempre comparar em milissegundos.
function maisNovoQue(iso, refISO) {
  const a = Date.parse(iso), b = Date.parse(refISO);
  if (isNaN(a) || isNaN(b)) return false;
  return a >= b;
}

// Aplica a baixa das peças de um pedido. Devolve o que foi baixado, para o aviso.
async function baixarEstoqueDoPedido(itens) {
  const baixado = [];
  for (const item of (itens || [])) {
    for (const r of requisitosDoItem(item)) {
      // Sempre da NUVEM. Ler o local e devolver o objeto inteiro para a nuvem faz este
      // aparelho gravar por cima do que os outros mexeram: em 11/08/2026 isso apagou as
      // contagens de estoque de uma tarde inteira e ressuscitou uma leva já concluída.
      const saved = await carregarNuvem(r.key);
      if (saved === undefined) continue; // nuvem fora do ar: não inventa baixa
      // Sem estoque cadastrado para esta cor não há o que baixar (e criar entrada
      // zerada aqui inventaria linha de estoque que a dona nunca lançou).
      if (!saved || !saved.est || !saved.est[r.cor]) continue;
      const i = (MODELOS[r.key] && MODELOS[r.key].tamanhoUnico) ? 0 : r.tam;
      const antes = saved.est[r.cor][i] || 0;
      if (antes <= 0) continue;
      const tirar = Math.min(antes, r.qtd);
      saved.est[r.cor][i] = antes - tirar;
      saved.est_at = saved.updated_at = new Date().toISOString();
      saveLocal('vc:' + r.key, saved);
      salvarNuvem(r.key, saved);
      baixado.push({ key: r.key, nome: (MODELOS[r.key] && MODELOS[r.key].nome) || r.key, cor: r.cor, tam: i, qtd: tirar });
    }
  }
  return baixado;
}

let _ultimaBaixaAuto = null; // { quando, pedidos:[], pecas:[] } — alimenta o aviso do dashboard
let _baixaRodando = false;   // trava: agora a baixa espera a nuvem e o ciclo de 1 min pode alcançá-la

async function baixaImediataDeProcessados() {
  // Página desatualizada não mexe mais em estoque. A faixa vermelha depende de alguém
  // clicar em "Recarregar", e até clicarem o código velho continuava rodando o ciclo de
  // 1 minuto — que é exatamente por onde o estrago entra.
  if (_versaoAvisada) return;
  if (_baixaRodando) return; // duas rodadas ao mesmo tempo baixariam a mesma remessa duas vezes
  _baixaRodando = true;
  try {
    await _baixaImediataDeProcessados();
  } finally {
    _baixaRodando = false;
  }
}

async function _baixaImediataDeProcessados() {
  const processados = window._shopifyProcessados || [];

  let ledger = await lerLedgerBaixas();
  // Nuvem fora do ar: sai sem fazer nada. Semear aqui apagaria o registro de verdade.
  if (ledger === undefined) return;
  if (!ledger) {
    // PRIMEIRA VEZ: não baixa nada, só registra o que já existe.
    //
    // A janela da API traz 7 dias de envios, e esses já tiveram baixa pela rotina antiga
    // das 16h (e pelo acerto manual do dia da virada — em 10/08/2026 o modal foi
    // confirmado às 17h41). Reaplicar aqui subtrairia a mesma remessa duas vezes, e
    // estoque subtraído a mais só reaparece se alguém contar a arara na mão.
    //
    // Vale também para o registro em formato antigo (chave por pedido): semeia de novo
    // com o corte em AGORA, senão o que já foi baixado pela versão anterior sairia outra vez.
    ledger = { chave: LEDGER_CHAVE, desde: new Date().toISOString(), envios: {} };
    for (const p of processados) {
      ledger.envios[p.id] = { numero: p.numero, em: p.enviado_em, aplicado: null, pecas: 0, nota: 'anterior ao registro' };
    }
    saveLocal(LEDGER_LOCAL, ledger);
    await salvarNuvem(LEDGER_BAIXAS, ledger);
    return;
  }

  const novos = processados.filter(p =>
    !ledger.envios[p.id] && p.enviado_em && maisNovoQue(p.enviado_em, ledger.desde)
  );
  if (novos.length === 0) return;

  const pecas = [], numeros = [];
  for (const p of novos) {
    const b = await baixarEstoqueDoPedido(p.itens);
    ledger.envios[p.id] = { numero: p.numero, em: p.enviado_em, aplicado: new Date().toISOString(), pecas: b.length };
    if (b.length) { pecas.push(...b); if (!numeros.includes(p.numero)) numeros.push(p.numero); }
  }

  // Poda: 60 dias bastam para a idempotência (a janela da API é de 7)
  const corte = new Date(Date.now() - 60 * 86400000).toISOString();
  for (const [id, r] of Object.entries(ledger.envios)) if (r.em && !maisNovoQue(r.em, corte)) delete ledger.envios[id];

  saveLocal(LEDGER_LOCAL, ledger);
  await salvarNuvem(LEDGER_BAIXAS, ledger);

  if (pecas.length) {
    _ultimaBaixaAuto = { quando: new Date().toISOString(), pedidos: numeros, pecas };
    if (modeloAtual === '__dashboard__') renderDashboard();
    else if (MODELOS[modeloAtual]) renderModelo(modeloAtual);
  }
}

// ─── ABA MODELAGEM (pastas por modelo: croqui, arquivo Audaces, consumo, alterações) ──────────
let mdlProjetos = [];
let mdlProjetoAtual = null;

function abrirModelagem(item) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (item) item.classList.add('active');
  if (modeloAtual !== '__dashboard__' && modeloAtual !== '__modelagem__' && (estEditado || prodEditado || cfgEditado)) {
    clearTimeout(saveTimer); salvarModelo();
  }
  estEditado = false; prodEditado = false; cfgEditado = false; esconderBtnSalvar();
  modeloAtual = '__modelagem__';
  location.hash = 'modelagem';
  document.getElementById('model-title').innerHTML = '<span style="font-family:\'Bebas Neue\',\'Arial Narrow\',sans-serif;font-weight:400;font-size:26px;letter-spacing:0.1em">MODELAGEM</span>';
  document.getElementById('model-sub').textContent = '';
  document.getElementById('topbar-actions').style.display = 'none';
  document.getElementById('tabs-modelo').style.display = 'none';
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-modelagem').classList.add('active');
  document.body.classList.remove('precos-mode');
  const ok = sessionStorage.getItem('mdl-ok') === '1';
  document.getElementById('mdl-gate').style.display = ok ? 'none' : '';
  document.getElementById('mdl-content').style.display = ok ? '' : 'none';
  if (ok) { mdlVoltarLista(); mdlCarregarLista(); }
  else setTimeout(() => document.getElementById('mdl-senha')?.focus(), 60);
  closeSidebar();
}

async function mdlUnlock() {
  const v = document.getElementById('mdl-senha').value;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex === MDL_HASH) {
    sessionStorage.setItem('mdl-ok', '1');
    document.getElementById('mdl-erro').textContent = '';
    document.getElementById('mdl-senha').value = '';
    document.getElementById('mdl-gate').style.display = 'none';
    document.getElementById('mdl-content').style.display = '';
    mdlVoltarLista();
    mdlCarregarLista();
  } else {
    document.getElementById('mdl-erro').textContent = 'Senha incorreta';
  }
}
function mdlLock() {
  sessionStorage.removeItem('mdl-ok');
  document.getElementById('mdl-gate').style.display = '';
  document.getElementById('mdl-content').style.display = 'none';
}

async function mdlCarregarLista() {
  const grid = document.getElementById('mdl-grid');
  grid.innerHTML = '<div style="color:var(--text-ter);font-size:13px;padding:20px">Carregando...</div>';
  try {
    const res = await fetch('/api/modelagem-list');
    const data = await res.json();
    if (data.erro) throw new Error(data.erro);
    mdlProjetos = data.projetos || [];
    mdlRenderLista();
  } catch (e) {
    grid.innerHTML = `<div style="color:#dc2626;font-size:13px;padding:20px">Erro ao carregar: ${e.message}</div>`;
  }
}

// O valor do ajuste é digitado livre ("50", "50,00", "R$ 50,00", "1.250,00"), então a
// soma não pode confiar em parseFloat direto — em pt-BR a vírgula é o decimal e o ponto
// costuma ser milhar. Texto que não vira número conta como 0 e é sinalizado na tela.
function mdlValorNum(txt) {
  let s = String(txt == null ? '' : txt).replace(/r\$/i, '').replace(/\s/g, '').trim();
  if (!s) return 0;
  const temVirgula = s.includes(','), temPonto = s.includes('.');
  if (temVirgula && temPonto) s = s.replace(/\./g, '').replace(',', '.'); // 1.250,00
  else if (temVirgula) s = s.replace(',', '.');                            // 50,00
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

// Soma de dinheiro em ponto flutuante acumula lixo (10,10 + 10,20 + 10,70 = 30,999…).
// Fechar em centavos evita total esquisito e diferença contra a conta feita na mão.
const mdlSomaValores = arr => Math.round(arr.reduce((s, v) => s + v, 0) * 100) / 100;
const mdlBRL = n => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// ─── PAGAMENTOS DA MODELISTA ─────────────────────────────────────────────────
// Fica em vc_modelos (mesma tabela chave-valor de precificacao/baixas-estoque), e não
// numa coluna nova da tabela de projetos: assim não precisa mexer no banco, e o histórico
// de versões passa a cobrir os pagamentos de graça, porque passa por salvarNuvem.
//
// Guarda o VALOR pago junto com a data. Se o valor do ajuste mudar depois, o acerto
// antigo não serve mais e o modelo volta para "a pagar" — senão uma correção de valor
// ficaria escondida atrás de um "pago" que era de outro número.
const MDL_PAGOS_KEY = 'modelagem-pagos';

function mdlPagos() {
  const d = loadLocal('vc:' + MDL_PAGOS_KEY);
  return (d && typeof d === 'object' && d.pagos) ? d.pagos : {};
}

// Estado de acerto de um projeto: 'pago', 'valor-mudou' ou 'aberto'
function mdlStatusPagamento(p, pagos) {
  const reg = pagos[String(p.id)];
  if (!reg) return { estado: 'aberto' };
  const mesmoValor = mdlValorNum(reg.valor) === mdlValorNum(p.valorAjuste);
  return { estado: mesmoValor ? 'pago' : 'valor-mudou', em: reg.em, valorPago: reg.valor };
}

async function mdlMarcarPago(id) {
  const p = (mdlProjetos || []).find(x => x.id === id);
  if (!p) return;
  const pagos = { ...mdlPagos() };
  pagos[String(id)] = { em: new Date().toISOString(), valor: p.valorAjuste || '' };
  const dados = { pagos };
  saveLocal('vc:' + MDL_PAGOS_KEY, dados);
  mdlRenderTotalModelista();
  if (mdlProjetoAtual && mdlProjetoAtual.projeto && mdlProjetoAtual.projeto.id === id) mdlRenderDetalhe();
  await salvarNuvem(MDL_PAGOS_KEY, dados);
  showSaved();
}

async function mdlDesmarcarPago(id) {
  const pagos = { ...mdlPagos() };
  delete pagos[String(id)];
  const dados = { pagos };
  saveLocal('vc:' + MDL_PAGOS_KEY, dados);
  mdlRenderTotalModelista();
  if (mdlProjetoAtual && mdlProjetoAtual.projeto && mdlProjetoAtual.projeto.id === id) mdlRenderDetalhe();
  await salvarNuvem(MDL_PAGOS_KEY, dados);
  showSaved();
}

// Quanto se deve à modelista somando o valor lançado em cada projeto.
function mdlRenderTotalModelista() {
  const el = document.getElementById('mdl-total-modelista');
  if (!el) return;
  const pagos = mdlPagos();
  const comValor = (mdlProjetos || [])
    .map(p => ({ ...p, num: mdlValorNum(p.valorAjuste), pg: mdlStatusPagamento(p, pagos) }))
    .filter(p => (p.valorAjuste || '').trim() !== '');
  const ilegiveis = comValor.filter(p => p.num === 0);
  const validos   = comValor.filter(p => p.num > 0);
  const aPagar    = validos.filter(p => p.pg.estado !== 'pago').sort((a, b) => b.num - a.num);
  const jaPago    = validos.filter(p => p.pg.estado === 'pago').sort((a, b) => String(b.pg.em).localeCompare(String(a.pg.em)));
  const totalPagar = mdlSomaValores(aPagar.map(p => p.num));
  const totalPago  = mdlSomaValores(jaPago.map(p => p.num));
  const semValor   = (mdlProjetos || []).length - comValor.length;

  if (!comValor.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const dia = t => t ? new Date(t).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'2-digit' }) : '';
  el.style.display = '';
  el.innerHTML = `
    <div class="card" style="border-left:3px solid #16a34a">
      <div class="card-header">
        <div class="card-title" style="color:#16a34a"><i class="ti ti-cash"></i> PAGAMENTO DA MODELISTA</div>
        <span style="font-size:11px;font-weight:700;color:var(--text-sec)">
          a pagar <b style="font-size:16px;color:#16a34a">${mdlBRL(totalPagar)}</b>
          ${jaPago.length ? ` · já pago <b style="color:var(--text-ter)">${mdlBRL(totalPago)}</b>` : ''}
        </span>
      </div>
      <div style="font-size:11px;color:var(--text-sec);margin-bottom:8px">
        Soma do <b>Valor do ajuste</b> de cada modelo. Marque como pago quando acertar com ela —
        o valor sai do total e fica registrado com a data.
        ${semValor > 0 ? `${semValor} modelo(s) ainda sem valor lançado.` : ''}
      </div>
      ${aPagar.length ? `
      <table style="width:100%">
        <thead><tr><th style="text-align:left">A pagar</th><th style="text-align:right;width:110px">Valor</th><th style="width:110px"></th></tr></thead>
        <tbody>
          ${aPagar.map(p => `<tr>
            <td style="text-align:left;font-weight:600;cursor:pointer" onclick="mdlAbrirDetalhe(${p.id})">${esc(p.title || '(sem nome)')}
              ${p.pg.estado === 'valor-mudou' ? `<div style="font-size:10px;color:#b45309;font-weight:700">
                <i class="ti ti-alert-triangle"></i> pago ${esc(dia(p.pg.em))} por R$ ${esc(p.pg.valorPago)} — o valor mudou desde então</div>` : ''}
            </td>
            <td style="text-align:right;font-weight:700">${mdlBRL(p.num)}</td>
            <td style="text-align:center">
              <button class="btn-primary" style="font-size:10px;padding:5px 9px;background:#16a34a;border-color:#16a34a;white-space:nowrap"
                onclick="mdlMarcarPago(${p.id})"><i class="ti ti-check"></i> paguei</button>
            </td></tr>`).join('')}
        </tbody>
        <tfoot><tr class="total-row">
          <td style="text-align:left">Total a pagar</td>
          <td style="text-align:right;color:#16a34a">${mdlBRL(totalPagar)}</td><td></td>
        </tr></tfoot>
      </table>` : `<div style="font-size:12px;color:#16a34a;font-weight:600;padding:6px 0">
        <i class="ti ti-circle-check"></i> Nada em aberto com a modelista.</div>`}
      ${jaPago.length ? `
      <div style="margin-top:12px">
        <div style="font-size:11px;font-weight:700;color:var(--text-ter);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Já acertado</div>
        <table style="width:100%">
          <tbody>
            ${jaPago.map(p => `<tr style="opacity:.75">
              <td style="text-align:left;cursor:pointer" onclick="mdlAbrirDetalhe(${p.id})">${esc(p.title || '(sem nome)')}
                <span style="font-size:10px;color:var(--text-ter)"> · pago em ${esc(dia(p.pg.em))}</span></td>
              <td style="text-align:right;width:110px">${mdlBRL(p.num)}</td>
              <td style="text-align:center;width:110px">
                <button class="btn-outline" style="font-size:10px;padding:4px 8px;white-space:nowrap"
                  onclick="mdlDesmarcarPago(${p.id})" title="Desfazer a marcação de pago">desfazer</button>
              </td></tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}
      ${ilegiveis.length ? `<div style="font-size:11px;color:#b45309;margin-top:8px">
        <i class="ti ti-alert-triangle"></i> ${ilegiveis.length} modelo(s) com valor que não dá para somar
        (${ilegiveis.map(p => esc(p.title) + ': "' + esc(p.valorAjuste) + '"').join(' · ')}) — ficaram de fora do total.</div>` : ''}
    </div>`;
}

function mdlRenderLista() {
  mdlRenderTotalModelista();
  const grid = document.getElementById('mdl-grid');
  const busca = (document.getElementById('mdl-busca').value || '').toLowerCase().trim();
  const nPend = p => (p.alteracoesPendentes || 0); // grade destaca só alterações/ajustes no projeto (consumo e pendências antigas não contam)
  const lista = mdlProjetos
    .filter(p => !busca || (p.title || '').toLowerCase().includes(busca))
    .sort((a, b) => nPend(b) - nPend(a)); // com pendência primeiro (empate mantém a ordem original)
  if (!lista.length) {
    grid.innerHTML = '<div style="color:var(--text-ter);font-size:13px;padding:20px">Nenhum modelo encontrado.</div>';
    return;
  }
  grid.innerHTML = lista.map(p => {
    const thumb = p.croquiKey
      ? `<img src="/api/modelagem-storage?key=${encodeURIComponent(p.croquiKey)}" style="width:100%;height:100%;object-fit:contain" loading="lazy">`
      : `<i class="ti ti-folder" style="font-size:38px;color:var(--gold)"></i>`;
    const audacesIcon = p.temAudaces ? ' · <i class="ti ti-file-check" style="color:#16a34a"></i>' : '';
    const totalPendencias = (p.alteracoesPendentes || 0); // grade destaca só alterações/ajustes no projeto
    const faixaPendencia = totalPendencias > 0
      ? `<div style="background:#dc2626;color:#fff;font-size:8px;font-weight:700;letter-spacing:0.03em;text-align:center;padding:2px 6px"><i class="ti ti-alert-triangle"></i> ${totalPendencias} PENDÊNCIA${totalPendencias > 1 ? 'S' : ''}</div>`
      : '';
    return `
      <div class="card" style="padding:0;cursor:pointer;overflow:hidden" onclick="mdlAbrirDetalhe(${p.id})">
        ${faixaPendencia}
        <div style="position:relative;aspect-ratio:4/5;background:${p.croquiKey ? '#fff' : '#f5f0e8'};display:flex;align-items:center;justify-content:center">
          ${thumb}
        </div>
        <div style="padding:10px 12px">
          <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.title}</div>
          <div style="font-size:11px;color:var(--text-ter);margin-top:2px">${p.category || '—'}${audacesIcon}</div>
        </div>
      </div>`;
  }).join('');
}

async function mdlNovoModelo() {
  const title = prompt('Nome do novo modelo:');
  if (!title || !title.trim()) return;
  const category = prompt('Categoria (opcional, ex.: Vestido, Conjunto...):') || null;
  try {
    const res = await fetch('/api/modelagem-projeto', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acao: 'criar', title: title.trim(), category }),
    });
    const data = await res.json();
    if (data.erro) throw new Error(data.erro);
    await mdlCarregarLista();
    mdlAbrirDetalhe(data.projeto.id);
  } catch (e) {
    alert('Erro ao criar modelo: ' + e.message);
  }
}

function mdlVoltarLista() {
  mdlProjetoAtual = null;
  document.getElementById('mdl-detalhe').style.display = 'none';
  document.getElementById('mdl-lista').style.display = '';
  mdlRenderLista(); // recalcula o total a pagar com o valor que acabou de ser lançado
}

async function mdlAbrirDetalhe(id) {
  document.getElementById('mdl-lista').style.display = 'none';
  document.getElementById('mdl-detalhe').style.display = '';
  document.getElementById('mdl-det-titulo').textContent = 'Carregando...';
  document.getElementById('mdl-det-body').innerHTML = '';
  try {
    const res = await fetch('/api/modelagem-projeto?id=' + id);
    const data = await res.json();
    if (data.erro) throw new Error(data.erro);
    mdlProjetoAtual = data;
    mdlRenderDetalhe();
  } catch (e) {
    document.getElementById('mdl-det-titulo').textContent = 'Erro';
    document.getElementById('mdl-det-body').innerHTML = `<div style="color:#dc2626;font-size:13px">${e.message}</div>`;
  }
}

function mdlRenderDetalhe() {
  const d = mdlProjetoAtual;
  if (!d) return;
  document.getElementById('mdl-det-titulo').textContent = d.projeto.title;

  const btnRemoverImg = (tipo, fileId) => `
    <button onclick="mdlRemoverArquivo(${d.projeto.id},'${tipo}',${fileId})" title="Remover" style="position:absolute;top:3px;right:3px;width:15px;height:15px;border:none;border-radius:50%;background:rgba(0,0,0,0.55);color:#fff;font-size:9px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0"><i class="ti ti-x"></i></button>`;

  const croquisHtml = (d.croquis || []).map(c => `
    <div style="position:relative">
      <img src="/api/modelagem-storage?key=${encodeURIComponent(c.fileKey)}" style="width:100%;max-height:170px;object-fit:contain;border-radius:8px;border:1px solid var(--border);background:#fafafa">
      ${btnRemoverImg('croqui', c.id)}
    </div>`
  ).join('') || '<div style="color:var(--text-ter);font-size:12px">Nenhum croqui ainda.</div>';

  const fotosHtml = (d.fotos || []).map(f => `
    <div style="position:relative">
      <img src="/api/modelagem-storage?key=${encodeURIComponent(f.fileKey)}" style="width:100%;max-height:170px;object-fit:contain;border-radius:8px;border:1px solid var(--border);background:#fff">
      ${btnRemoverImg('foto', f.id)}
    </div>`
  ).join('') || '<div style="color:var(--text-ter);font-size:12px">Nenhuma foto ainda.</div>';

  // Versão do arquivo da Audaces pela DATA de envio: o mais antigo é V1, o seguinte V2…
  // (a modelista reenvia o mesmo arquivo com o mesmo nome — sem isso não dá para saber
  //  qual é o atual). A lista continua com o mais recente no topo, marcado como ATUAL.
  // O Postgres devolve o createdAt SEM fuso ("2026-08-03T16:52:28.9") e o valor é UTC —
  // sem o 'Z' o navegador leria como hora local e mostraria 3h a mais (e o dia errado
  // em upload feito à noite). Por isso o Z é acrescentado quando não vem fuso na string.
  const dataUpload = iso => {
    if (!iso) return null;
    const s = String(iso);
    const t = new Date(/([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : s + 'Z');
    return isNaN(t.getTime()) ? null : t;
  };
  const audacesPorData = [...(d.audaces || [])].sort((a, b) => {
    const ta = dataUpload(a.createdAt), tb = dataUpload(b.createdAt);
    return ((ta ? ta.getTime() : 0) - (tb ? tb.getTime() : 0)) || (a.id - b.id);
  });
  const versaoAudaces = new Map(audacesPorData.map((a, i) => [a.id, i + 1]));
  const totalAudaces = audacesPorData.length;
  // Data + hora: os dois arquivos costumam ser do mesmo dia, então só a data não separa as versões.
  const dataCurta = iso => {
    const t = dataUpload(iso);
    return t ? `${t.toLocaleDateString('pt-BR')} ${t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : '';
  };
  // Dois envios no mesmo minuto (acontece ao reenviar em seguida) mostrariam a mesma hora —
  // nesse caso, e só nele, o rótulo ganha os segundos para as versões ficarem distinguíveis.
  const rotuloBase = new Map(audacesPorData.map(a => [a.id, dataCurta(a.createdAt)]));
  const rotulosRepetidos = new Set();
  const jaVistos = new Set();
  for (const r of rotuloBase.values()) {
    if (!r) continue;
    if (jaVistos.has(r)) rotulosRepetidos.add(r);
    jaVistos.add(r);
  }
  const rotuloData = a => {
    const base = rotuloBase.get(a.id);
    if (!base || !rotulosRepetidos.has(base)) return base;
    const t = dataUpload(a.createdAt);
    return `${t.toLocaleDateString('pt-BR')} ${t.toLocaleTimeString('pt-BR')}`;
  };
  const audacesHtml = audacesPorData.slice().reverse().map(a => {
    const v = versaoAudaces.get(a.id);
    const atual = v === totalAudaces;
    const dt = rotuloData(a);
    const selo = `<span title="${atual ? 'versão mais recente' : 'versão anterior'}" style="font-size:10px;font-weight:700;border-radius:4px;padding:1px 6px;white-space:nowrap;${atual ? 'background:var(--gold-dark);color:#fff' : 'background:rgba(0,0,0,.06);color:var(--text-ter)'}">V${v}</span>`;
    return `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px${atual ? '' : ';opacity:.65'}">
      <i class="ti ti-file-type-xls" style="color:var(--gold-dark)"></i>
      ${selo}
      <a href="/api/modelagem-storage?key=${encodeURIComponent(a.fileKey)}" target="_blank" style="font-size:12px;color:inherit;text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.name}</a>
      ${dt ? `<span style="font-size:10px;color:var(--text-ter);white-space:nowrap">${dt}</span>` : ''}
      <i class="ti ti-trash" onclick="mdlRemoverArquivo(${d.projeto.id},'audaces',${a.id})" title="Remover arquivo" style="cursor:pointer;color:#dc2626;font-size:15px"></i>
    </div>`;
  }).join('') || '<div style="color:var(--text-ter);font-size:12px">Nenhum arquivo da Audaces ainda.</div>';

  const faixaAlertaCard = texto => `<div style="background:#dc2626;color:#fff;font-size:10px;font-weight:700;letter-spacing:0.03em;text-align:center;padding:4px 6px;margin:-12px -16px 10px"><i class="ti ti-alert-triangle"></i> ${texto}</div>`;

  const consumo = d.consumo || {};
  const temLargura = !!(consumo.larguraTecido || '').trim();
  const temConsumoPeca = !!(consumo.consumoPorPeca || '').trim();
  const consumoFaltando = !temLargura || !temConsumoPeca; // pendência se faltar qualquer campo essencial
  const consumoTexto = (!temLargura && !temConsumoPeca) ? 'NÃO PREENCHIDO' : 'INCOMPLETO';
  const valorAjuste = (d.projeto.valorAjuste || '').trim();
  // medidas da peça: JSON em texto na coluna `medidas` ({ Busto: {PP:'88', ...}, __obs:'' })
  let medidas = {};
  try { medidas = d.projeto.medidas ? JSON.parse(d.projeto.medidas) : {}; } catch (_) { medidas = {}; }
  const alteracoes = d.alteracoes || [];
  const alteracoesHtml = alteracoes.length ? alteracoes.map(a => `
    <div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">
      <input type="checkbox" ${a.status === 'done' ? 'checked' : ''} onchange="mdlToggleAlteracao(${a.id})" style="margin-top:3px">
      <div style="flex:1">
        <div style="font-size:12px;${a.status === 'done' ? 'text-decoration:line-through;color:var(--text-ter)' : ''}">${a.description}</div>
        <div style="font-size:10px;color:var(--text-ter);margin-top:2px">${a.version} · ${new Date(a.createdAt).toLocaleDateString('pt-BR')}</div>
      </div>
      <i class="ti ti-pencil" onclick="mdlEditAlteracao(${a.id})" style="cursor:pointer;color:var(--text-ter);font-size:14px;margin-top:2px" title="Editar"></i>
    </div>`).join('') : '<div style="color:var(--text-ter);font-size:12px">Nenhuma alteração registrada.</div>';

  document.getElementById('mdl-det-body').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px">
      <div class="card">
        ${consumoFaltando ? faixaAlertaCard(consumoTexto) : ''}
        <div class="card-header"><div class="card-title"><i class="ti ti-ruler-2"></i> CONSUMO DO MODELO</div></div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <label style="font-size:11px;color:var(--text-sec)">Largura do tecido
            <input id="mdl-consumo-largura" value="${consumo.larguraTecido || ''}" placeholder="ex.: 1,40m" style="width:100%;margin-top:3px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
          </label>
          <label style="font-size:11px;color:var(--text-sec)">Consumo por peça
            <input id="mdl-consumo-peca" value="${consumo.consumoPorPeca || ''}" placeholder="ex.: 1,80m" style="width:100%;margin-top:3px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
          </label>
          <label style="font-size:11px;color:var(--text-sec)">Observações
            <textarea id="mdl-consumo-obs" rows="2" style="width:100%;margin-top:3px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;resize:vertical">${consumo.observacoes || ''}</textarea>
          </label>
          <button class="btn-primary" style="font-size:12px;padding:8px;align-self:flex-start" onclick="mdlSalvarConsumo(${d.projeto.id})"><i class="ti ti-device-floppy"></i> Salvar consumo</button>
        </div>
      </div>

      <div class="card">
        ${alteracoes.filter(a => a.status === 'pending').length > 0 ? faixaAlertaCard(`${alteracoes.filter(a => a.status === 'pending').length} EM ABERTO`) : ''}
        <div class="card-header"><div class="card-title"><i class="ti ti-list-details"></i> ALTERAÇÕES NO PROJETO</div></div>
        <div style="max-height:220px;overflow-y:auto;margin-bottom:10px">${alteracoesHtml}</div>
        <div style="display:flex;gap:6px">
          <input id="mdl-nova-alteracao" placeholder="Descrever alteração..." style="flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px" onkeydown="if(event.key==='Enter')mdlAddAlteracao(${d.projeto.id})">
          <button class="btn-primary" style="font-size:12px;padding:7px 12px" onclick="mdlAddAlteracao(${d.projeto.id})"><i class="ti ti-plus"></i></button>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title"><i class="ti ti-cash"></i> VALOR DO AJUSTE</div>${(() => {
          const pg = mdlStatusPagamento(d.projeto, mdlPagos());
          if (pg.estado === 'pago') return `<span style="font-size:10px;background:rgba(22,163,74,.15);color:#16a34a;border-radius:4px;padding:2px 8px;font-weight:700"><i class="ti ti-check"></i> PAGO EM ${new Date(pg.em).toLocaleDateString('pt-BR')}</span>`;
          if (pg.estado === 'valor-mudou') return `<span style="font-size:10px;background:rgba(217,119,6,.15);color:#b45309;border-radius:4px;padding:2px 8px;font-weight:700"><i class="ti ti-alert-triangle"></i> VALOR MUDOU DEPOIS DO PAGAMENTO</span>`;
          return '';
        })()}</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <label style="font-size:11px;color:var(--text-sec)">Valor cobrado pela modelista
            <div style="display:flex;align-items:center;gap:6px;margin-top:3px">
              <span style="font-size:14px;color:var(--text-sec);font-weight:600">R$</span>
              <input id="mdl-valor-ajuste" value="${valorAjuste.replace(/"/g, '&quot;')}" placeholder="ex.: 50,00" onkeydown="if(event.key==='Enter')mdlSalvarValorAjuste(${d.projeto.id})" style="flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
            </div>
          </label>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn-primary" style="font-size:12px;padding:8px" onclick="mdlSalvarValorAjuste(${d.projeto.id})"><i class="ti ti-device-floppy"></i> Salvar valor</button>
            ${(valorAjuste || '').trim() === '' ? '' : (mdlStatusPagamento(d.projeto, mdlPagos()).estado === 'pago'
              ? `<button class="btn-outline" style="font-size:12px;padding:8px" onclick="mdlDesmarcarPago(${d.projeto.id})">desfazer pagamento</button>`
              : `<button class="btn-primary" style="font-size:12px;padding:8px;background:#16a34a;border-color:#16a34a" onclick="mdlMarcarPago(${d.projeto.id})"><i class="ti ti-check"></i> Marcar como pago</button>`)}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title"><i class="ti ti-camera"></i> FOTO DO MODELO</div></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(95px,1fr));gap:8px;margin-bottom:10px">${fotosHtml}</div>
        <label class="btn-outline" style="font-size:12px;padding:7px 12px;display:inline-flex;align-items:center;gap:6px;cursor:pointer">
          <i class="ti ti-upload"></i> Enviar foto
          <input type="file" accept="image/*" style="display:none" onchange="mdlUpload(${d.projeto.id},'foto',this)">
        </label>
      </div>

      <div class="card">
        ${!(d.croquis || []).length ? faixaAlertaCard('NÃO PREENCHIDO') : ''}
        <div class="card-header"><div class="card-title"><i class="ti ti-photo"></i> CROQUI</div></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(95px,1fr));gap:8px;margin-bottom:10px">${croquisHtml}</div>
        <label class="btn-outline" style="font-size:12px;padding:7px 12px;display:inline-flex;align-items:center;gap:6px;cursor:pointer">
          <i class="ti ti-upload"></i> Enviar croqui
          <input type="file" accept="image/*" style="display:none" onchange="mdlUpload(${d.projeto.id},'croqui',this)">
        </label>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title"><i class="ti ti-file-type-xls"></i> ARQUIVO DA AUDACES</div></div>
        <div style="margin-bottom:10px">${audacesHtml}</div>
        <label class="btn-outline" style="font-size:12px;padding:7px 12px;display:inline-flex;align-items:center;gap:6px;cursor:pointer">
          <i class="ti ti-upload"></i> Enviar arquivo
          <input type="file" style="display:none" onchange="mdlUpload(${d.projeto.id},'audaces',this)">
        </label>
      </div>

      <div class="card" style="grid-column:1/-1">
        <div class="card-header"><div class="card-title"><i class="ti ti-ruler-measure"></i> MEDIDAS DA PEÇA</div></div>
        <div style="font-size:10px;color:var(--text-ter);margin-bottom:8px">Medida da peça pronta, em cm. O nome de cada linha é livre — escreva o que essa peça precisa.</div>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead>
              <tr>
                <th style="text-align:left;padding:4px 6px;font-size:10px;color:var(--text-sec);width:22%;min-width:150px">Medida</th>
                ${MDL_TAMANHOS.map(t => `<th style="padding:4px 3px;font-size:10px;color:var(--text-sec)">${t}</th>`).join('')}
                <th style="width:24px"></th>
              </tr>
            </thead>
            <tbody id="mdl-medidas-tbody">
              ${mdlLinhasMedidaHtml(d.projeto.id, medidas)}
            </tbody>
          </table>
        </div>
        <button class="btn-outline" style="font-size:11px;padding:5px 10px;align-self:flex-start;margin-top:6px" onclick="mdlAddLinhaMedida(${d.projeto.id})"><i class="ti ti-plus"></i> Adicionar linha</button>
        <label style="font-size:11px;color:var(--text-sec);display:block;margin-top:8px">Observações da modelagem
          <textarea id="mdl-medidas-obs" rows="2" style="width:100%;margin-top:3px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;resize:vertical">${(medidas.__obs || '').toString()}</textarea>
        </label>
        <button class="btn-primary" style="font-size:12px;padding:8px;align-self:flex-start;margin-top:8px" onclick="mdlSalvarMedidas(${d.projeto.id})"><i class="ti ti-device-floppy"></i> Salvar medidas</button>
      </div>

    </div>`;
}

async function mdlSalvarConsumo(id) {
  const larguraTecido = document.getElementById('mdl-consumo-largura').value.trim();
  const consumoPorPeca = document.getElementById('mdl-consumo-peca').value.trim();
  const observacoes = document.getElementById('mdl-consumo-obs').value.trim();
  try {
    const res = await fetch('/api/modelagem-projeto', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, acao: 'consumo', larguraTecido, consumoPorPeca, observacoes }),
    });
    const data = await res.json();
    if (data.erro) throw new Error(data.erro);
    showSaved();
  } catch (e) {
    alert('Erro ao salvar consumo: ' + e.message);
  }
}

// Medidas da peça — colunas do card MEDIDAS DA PEÇA.
// O NOME de cada linha é digitado pela modelista (não há mais lista fixa de Busto/Cintura/…):
// cada peça precisa de medidas diferentes. O dado continua guardado por nome
// ({ 'Busto': {PP:'88'}, __obs:'' }), então o que já estava preenchido continua aparecendo.
const MDL_TAMANHOS = ['PP', 'P', 'M', 'G', 'GG', 'G1'];
const MDL_LINHAS_NOVAS = 8; // linhas em branco quando o projeto ainda não tem medida nenhuma
const MDL_LINHAS_EXTRA = 3; // linhas em branco no fim, para continuar preenchendo

function mdlLinhaMedidaHtml(idProjeto, nome, valores) {
  const esc = v => (v == null ? '' : String(v)).replace(/"/g, '&quot;');
  const val = t => esc((valores || {})[t] || '');
  return `
    <tr>
      <td style="padding:3px 6px">
        <input class="mdl-medida-nome" value="${esc(nome)}" placeholder="nome da medida"
          onkeydown="if(event.key==='Enter')mdlSalvarMedidas(${idProjeto})"
          style="width:100%;min-width:110px;padding:5px 6px;border:1px solid var(--border);border-radius:5px;font-size:12px;font-weight:600">
      </td>
      ${MDL_TAMANHOS.map(t => `<td style="padding:2px 3px">
        <input data-tam="${t}" value="${val(t)}"
          onkeydown="if(event.key==='Enter')mdlSalvarMedidas(${idProjeto})"
          style="width:100%;min-width:44px;padding:5px 4px;border:1px solid var(--border);border-radius:5px;font-size:12px;text-align:center">
      </td>`).join('')}
      <td style="padding:2px 3px;text-align:center">
        <button onclick="mdlRemoverLinhaMedida(this)" title="remover esta linha"
          style="background:none;border:none;cursor:pointer;color:var(--text-ter);font-size:15px;line-height:1">×</button>
      </td>
    </tr>`;
}

function mdlLinhasMedidaHtml(idProjeto, medidas) {
  const nomes = Object.keys(medidas || {}).filter(k => k !== '__obs');
  const vazias = nomes.length ? MDL_LINHAS_EXTRA : MDL_LINHAS_NOVAS;
  return [
    ...nomes.map(n => mdlLinhaMedidaHtml(idProjeto, n, medidas[n])),
    ...Array.from({ length: vazias }, () => mdlLinhaMedidaHtml(idProjeto, '', {})),
  ].join('');
}

function mdlAddLinhaMedida(idProjeto) {
  const tbody = document.getElementById('mdl-medidas-tbody');
  if (!tbody) return;
  tbody.insertAdjacentHTML('beforeend', mdlLinhaMedidaHtml(idProjeto, '', {}));
  const inp = tbody.querySelector('tr:last-child .mdl-medida-nome');
  if (inp) inp.focus();
}

// Só tira a linha da tela; o que some do JSON é gravado no próximo "Salvar medidas".
function mdlRemoverLinhaMedida(btn) {
  const tr = btn.closest('tr');
  if (tr) tr.remove();
}

async function mdlSalvarMedidas(id) {
  const medidas = {};
  const semNome = [];
  const repetidos = [];
  document.querySelectorAll('#mdl-medidas-tbody tr').forEach((tr, i) => {
    const nome = (tr.querySelector('.mdl-medida-nome') || {}).value || '';
    const valores = {};
    tr.querySelectorAll('input[data-tam]').forEach(inp => {
      const v = inp.value.trim();
      if (v) valores[inp.dataset.tam] = v;
    });
    const temValor = Object.keys(valores).length > 0;
    const nomeLimpo = nome.trim();
    if (!nomeLimpo) { if (temValor) semNome.push(i + 1); return; } // linha em branco: ignora
    if (medidas[nomeLimpo]) { repetidos.push(nomeLimpo); return; }
    if (temValor) medidas[nomeLimpo] = valores;
  });
  // Valor digitado sem nome de medida seria perdido em silêncio — avisa e não grava.
  if (semNome.length) { alert('Dê um nome à medida da linha ' + semNome.join(', ') + ' antes de salvar.'); return; }
  if (repetidos.length) { alert('Há duas linhas com o mesmo nome: ' + [...new Set(repetidos)].join(', ') + '. Renomeie uma delas.'); return; }
  const obs = (document.getElementById('mdl-medidas-obs') || {}).value || '';
  if (obs.trim()) medidas.__obs = obs.trim();
  try {
    const res = await fetch('/api/modelagem-projeto', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, acao: 'medidas', medidas }),
    });
    const data = await res.json();
    if (data.erro) throw new Error(data.erro);
    if (mdlProjetoAtual && mdlProjetoAtual.projeto) {
      mdlProjetoAtual.projeto.medidas = JSON.stringify(medidas);
      mdlRenderDetalhe();
    }
    showSaved();
  } catch (e) {
    alert('Erro ao salvar medidas: ' + e.message);
  }
}

async function mdlSalvarValorAjuste(id) {
  const valorAjuste = document.getElementById('mdl-valor-ajuste').value.trim();
  try {
    const res = await fetch('/api/modelagem-projeto', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, acao: 'valor-ajuste', valorAjuste }),
    });
    const data = await res.json();
    if (data.erro) throw new Error(data.erro);
    if (mdlProjetoAtual && mdlProjetoAtual.projeto) { mdlProjetoAtual.projeto.valorAjuste = valorAjuste; mdlRenderDetalhe(); }
    // mantém a listagem em dia para o total a pagar não ficar defasado até o próximo carregamento
    const naLista = (mdlProjetos || []).find(p => p.id === id);
    if (naLista) naLista.valorAjuste = valorAjuste;
    showSaved();
  } catch (e) {
    alert('Erro ao salvar valor: ' + e.message);
  }
}

async function mdlAddAlteracao(id) {
  const input = document.getElementById('mdl-nova-alteracao');
  const description = input.value.trim();
  if (!description) return;
  try {
    const res = await fetch('/api/modelagem-projeto', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, acao: 'alteracao-add', description }),
    });
    const data = await res.json();
    if (data.erro) throw new Error(data.erro);
    input.value = '';
    await mdlAbrirDetalhe(id);
    mdlCarregarLista(); // atualiza badge de pendências na grid
  } catch (e) {
    alert('Erro ao adicionar alteração: ' + e.message);
  }
}

async function mdlToggleAlteracao(alteracaoId) {
  const id = mdlProjetoAtual.projeto.id;
  try {
    const res = await fetch('/api/modelagem-projeto', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, acao: 'alteracao-toggle', alteracaoId }),
    });
    const data = await res.json();
    if (data.erro) throw new Error(data.erro);
    await mdlAbrirDetalhe(id);
    mdlCarregarLista();
  } catch (e) {
    alert('Erro ao atualizar alteração: ' + e.message);
  }
}

async function mdlAddPendencia(id) {
  const input = document.getElementById('mdl-nova-pendencia');
  const description = input.value.trim();
  if (!description) return;
  try {
    const res = await fetch('/api/modelagem-projeto', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, acao: 'pendencia-add', description }),
    });
    const data = await res.json();
    if (data.erro) throw new Error(data.erro);
    input.value = '';
    await mdlAbrirDetalhe(id);
    mdlCarregarLista(); // atualiza a faixa de pendências na grid
  } catch (e) {
    alert('Erro ao adicionar pendência: ' + e.message);
  }
}

async function mdlTogglePendencia(pendenciaId) {
  const id = mdlProjetoAtual.projeto.id;
  try {
    const res = await fetch('/api/modelagem-projeto', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, acao: 'pendencia-toggle', pendenciaId }),
    });
    const data = await res.json();
    if (data.erro) throw new Error(data.erro);
    await mdlAbrirDetalhe(id);
    mdlCarregarLista();
  } catch (e) {
    alert('Erro ao atualizar pendência: ' + e.message);
  }
}

async function mdlEditAlteracao(alteracaoId) {
  const id = mdlProjetoAtual.projeto.id;
  const atual = (mdlProjetoAtual.alteracoes || []).find(a => a.id === alteracaoId);
  const nova = prompt('Editar alteração:', atual ? atual.description : '');
  if (nova === null || !nova.trim() || nova.trim() === (atual && atual.description)) return;
  try {
    const res = await fetch('/api/modelagem-projeto', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, acao: 'alteracao-edit', alteracaoId, description: nova.trim() }),
    });
    const data = await res.json();
    if (data.erro) throw new Error(data.erro);
    await mdlAbrirDetalhe(id);
  } catch (e) {
    alert('Erro ao editar alteração: ' + e.message);
  }
}

async function mdlEditPendencia(pendenciaId) {
  const id = mdlProjetoAtual.projeto.id;
  const atual = (mdlProjetoAtual.pendencias || []).find(p => p.id === pendenciaId);
  const nova = prompt('Editar pendência:', atual ? atual.description : '');
  if (nova === null || !nova.trim() || nova.trim() === (atual && atual.description)) return;
  try {
    const res = await fetch('/api/modelagem-projeto', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, acao: 'pendencia-edit', pendenciaId, description: nova.trim() }),
    });
    const data = await res.json();
    if (data.erro) throw new Error(data.erro);
    await mdlAbrirDetalhe(id);
  } catch (e) {
    alert('Erro ao editar pendência: ' + e.message);
  }
}

async function mdlUpload(id, tipo, inputEl) {
  const file = inputEl.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('projectId', id);
  form.append('tipo', tipo);
  form.append('file', file);
  try {
    const res = await fetch('/api/modelagem-upload', { method: 'POST', body: form });
    const data = await res.json();
    if (data.erro) throw new Error(data.erro);
    await mdlAbrirDetalhe(id);
    mdlCarregarLista();
  } catch (e) {
    alert('Erro ao enviar arquivo: ' + e.message);
  } finally {
    inputEl.value = '';
  }
}

async function mdlRemoverArquivo(id, tipo, fileId) {
  const nomes = { foto: 'esta foto', croqui: 'este croqui', audaces: 'este arquivo' };
  if (!confirm(`Remover ${nomes[tipo] || 'este arquivo'}? Esta ação não pode ser desfeita.`)) return;
  try {
    const res = await fetch('/api/modelagem-projeto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, acao: 'arquivo-remover', tipo, fileId }),
    });
    const data = await res.json();
    if (data.erro) throw new Error(data.erro);
    await mdlAbrirDetalhe(id);
    mdlCarregarLista();
  } catch (e) {
    alert('Erro ao remover: ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// 1. Monta sidebar e restaura tela pelo hash da URL (ou abre dashboard)
// Tudo isto só roda DEPOIS de alguém passar pelo cadeado — inclusive a leitura da
// nuvem, que antes acontecia com a tela ainda em branco.
let _appIniciado = false;

function iniciarApp() {
  if (_appIniciado) return;
  _appIniciado = true;

const _hashKey = location.hash.replace('#', '');
const _ESPECIAIS = { confeccao: '__confeccao__', precos: '__precos__', financeiro: '__financeiro__', trafego: '__trafego__', fluxo: '__fluxo__', atendimento: '__atendimento__', modelagem: '__modelagem__', corte: '__corte__', costura: '__costura__', faturamento: '__faturamento__' };
modeloAtual = _ESPECIAIS[_hashKey] || ((_hashKey && MODELOS[_hashKey]) ? _hashKey : '__dashboard__');
// Perfis de oficina não escolhem tela: só as abas deles existem. A costureira tem duas
// (COSTURA e FATURAMENTO), então o hash vale entre essas duas e nada além disso.
if (ehPerfilCorte())   modeloAtual = '__corte__';
if (ehPerfilCostura() && modeloAtual !== '__faturamento__') modeloAtual = '__costura__';
// #macacao-amplo na URL não pode furar o cadeado da confecção
if (MODELOS[modeloAtual] && !confLiberada()) modeloAtual = '__confeccao__';
buildSidebar();

if (modeloAtual === '__confeccao__') {
  abrirConfeccao(null);
} else if (modeloAtual === '__corte__') {
  abrirCorte(null);
} else if (modeloAtual === '__costura__') {
  abrirCostura(null);
} else if (modeloAtual === '__faturamento__') {
  abrirFaturamento(null);
} else if (modeloAtual === '__precos__') {
  abrirPrecos(null); // restaura a aba Precificação após F5 (mantém o gate de senha)
} else if (modeloAtual === '__financeiro__') {
  abrirFinanceiro(null); // restaura a aba Financeiro após F5
} else if (modeloAtual === '__trafego__') {
  abrirTrafego(null); // restaura a aba Tráfego após F5
} else if (modeloAtual === '__fluxo__') {
  abrirFluxo(null); // restaura a aba Fluxo de Caixa após F5
} else if (modeloAtual === '__atendimento__') {
  abrirAtendimento(null); // restaura a aba Atendimento após F5
} else if (modeloAtual === '__modelagem__') {
  abrirModelagem(null); // restaura a aba Modelagem após F5
} else if (modeloAtual === '__dashboard__') {
  document.getElementById('tabs-modelo').style.display = 'none';
} else {
  document.getElementById('tabs-modelo').style.display = '';
  document.getElementById('topbar-actions').style.display = '';
  showTab('producao');
}

// 2. Sincroniza todos os modelos da nuvem → depois carrega Shopify e renderiza
const _renderInicial = () => {
  if (modeloAtual === '__corte__') renderCorte();
  else if (modeloAtual === '__costura__') renderCostura();
  else if (modeloAtual === '__faturamento__') renderFaturamento();
  else if (modeloAtual === '__confeccao__') { if (confLiberada()) renderConfeccao(); }
  else if (modeloAtual === '__dashboard__') renderDashboard();
  else if (modeloAtual === '__precos__') { if (sessionStorage.getItem('fin-ok') === '1') renderPrecos(); }
  else if (modeloAtual === '__financeiro__') { if (sessionStorage.getItem('fin-ok') === '1') renderFinanceiro(); }
  else if (modeloAtual === '__trafego__') { if (sessionStorage.getItem('fin-ok') === '1') trafCarregarFrame(); }
  else if (modeloAtual === '__fluxo__') { if (sessionStorage.getItem('fin-ok') === '1') renderFluxo(); }
  else if (modeloAtual === '__atendimento__') { if (sessionStorage.getItem('fin-ok') === '1') atdShowSub('sac'); }
  else if (modeloAtual === '__modelagem__') { if (sessionStorage.getItem('mdl-ok') === '1') mdlCarregarLista(); }
  else renderModelo(modeloAtual);
};
carregarTodosNuvem().then(() => carregarPedidosShopify()).then(async () => {
  // Baixa de estoque dos pedidos que a Shopify já processou (inclusive o atraso de hoje).
  // Os perfis de oficina não mexem em estoque: eles só leem fichas.
  if (!ehPerfilOficina()) await baixaImediataDeProcessados().catch(() => {});

  _renderInicial();
  if (!ehPerfilOficina()) verificarAvisosStatus();
  crtSincronizarPrioridade().catch(() => {}); // solta: a ordem do corte não segura a tela
  cstFatSincronizar().catch(() => {});        // idem: fecha o valor das levas que saíram da costura
}).catch(() => {
  _renderInicial();
  if (!ehPerfilOficina()) verificarAvisosStatus();
});

// 3. Atualiza pedidos Shopify automaticamente a cada 1 minuto
setInterval(() => {
  carregarPedidosShopify().then(async () => {
    // Baixa de estoque na hora: se algum pedido foi processado desde o ciclo anterior,
    // a peça sai do estoque agora, não às 16h. Os perfis de oficina nunca dão baixa.
    if (!ehPerfilOficina()) await baixaImediataDeProcessados().catch(() => {});
    crtSincronizarPrioridade().catch(() => {}); // recalcula a ordem do corte e grava se mudou
    crtArquivarConcluidas().catch(() => {});    // leva que saiu do corte vira histórico
    cstFatSincronizar().catch(() => {});        // leva que saiu da costura vira valor a pagar
    // crtOcupado: não redesenhar a aba CORTE enquanto ele digita o que cortou — o
    // innerHTML novo levaria junto o que ainda não foi gravado.
    if (modeloAtual === '__corte__') { if (!crtOcupado()) renderCorte(); }
    else if (modeloAtual === '__costura__') renderCostura(); // só leitura: nada digitado para perder
    else if (modeloAtual === '__faturamento__') renderFaturamento();
    else if (modeloAtual === '__dashboard__') renderDashboard();
    else if (modeloAtual === '__confeccao__' && confLiberada()) renderConfeccao(); // atualiza os selos de etapa do catálogo
    else if (!estEditado && !prodEditado && MODELOS[modeloAtual]) renderModelo(modeloAtual); // só modelos reais; pula precos/financeiro
  }).catch(() => {});
}, 1 * 60 * 1000);

// 3b. Sincroniza estoque/produção entre dispositivos a cada 15 segundos (rede de segurança do realtime)
setInterval(() => { sincronizarNuvem(); }, 15 * 1000);

// 3c. Sincroniza IMEDIATAMENTE ao voltar para o app/aba (celular: ao desbloquear/voltar pra aba).
// Navegadores móveis pausam os timers em segundo plano, então isto garante dados frescos na volta.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { sincronizarNuvem(); checarVersaoNova(); }
});
window.addEventListener('focus', () => sincronizarNuvem());
window.addEventListener('pageshow', () => sincronizarNuvem());

} // fim de iniciarApp()

// Quem manda é o cookie de sessão, não o localStorage: um aparelho que "já entrou" mas
// está com a sessão vencida precisa ver o cadeado de novo, senão o app carrega a tela
// toda e cada chamada de API morre em 401. O localStorage vira só um espelho do perfil,
// que ehPerfilCorte()/ehPerfilCostura() leem de forma síncrona durante a montagem da tela.
(async () => {
  let perfil = null;
  try {
    const r = await fetch('/api/sessao');
    if (r.ok) perfil = (await r.json()).perfil;
  } catch (e) {}
  if (perfil) {
    try { localStorage.setItem(PERFIL_KEY, perfil); } catch (e) {}
    aplicarPerfil(perfil);
    iniciarApp();
  } else {
    try { localStorage.removeItem(PERFIL_KEY); } catch (e) {}
    setTimeout(() => document.getElementById('app-gate-senha')?.focus(), 100);
  }
})();

// ─── AVISO DE VERSÃO NOVA ────────────────────────────────────────────────────
// Aba deixada aberta continua rodando o JS antigo depois de um deploy — e um
// clique em Recalcular grava conta velha por cima do dado certo (aconteceu em
// 28/07/2026). Aqui a página compara a versão que ELA carregou com a que está no
// servidor e avisa. Fonte da verdade: o ?v= do index.html, que já é bumpado a cada
// deploy — sem arquivo de versão separado para esquecer de atualizar.
const APP_VERSAO = ((document.querySelector('script[src*="main.js"]') || {}).src || '').match(/[?&]v=(\d+)/)?.[1] || '';
// _versaoAvisada é declarado lá no topo do arquivo (a baixa de estoque consulta antes daqui)

async function checarVersaoNova() {
  if (_versaoAvisada || !APP_VERSAO) return;
  try {
    const res = await fetch('/?_v=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const m = (await res.text()).match(/main\.js\?v=(\d+)/);
    if (m && m[1] !== APP_VERSAO) { _versaoAvisada = true; mostrarFaixaVersaoNova(m[1]); }
  } catch (_) {}
}

function mostrarFaixaVersaoNova(versaoNova) {
  if (document.getElementById('faixa-versao')) return;
  const el = document.createElement('div');
  el.id = 'faixa-versao';
  el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#dc2626;color:#fff;' +
    'padding:12px 16px;display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;' +
    'font-size:14px;font-weight:600;box-shadow:0 2px 12px rgba(0,0,0,.3)';
  el.innerHTML =
    '<span><i class="ti ti-alert-triangle"></i> Esta página está desatualizada — o sistema foi atualizado. ' +
    'Recarregue ANTES de mexer em produção ou estoque, senão os cálculos saem errados.</span>' +
    '<button id="btn-versao-reload" style="background:#fff;color:#dc2626;border:0;border-radius:6px;' +
    'padding:7px 16px;font-weight:700;font-size:13px;cursor:pointer">Recarregar agora</button>';
  document.body.appendChild(el);
  document.body.style.paddingTop = el.offsetHeight + 'px';
  document.getElementById('btn-versao-reload').onclick = () => {
    // salva o que estiver pendente antes de recarregar (não perde digitação)
    try { if ((estEditado || prodEditado || cfgEditado) && modeloAtual !== '__dashboard__') salvarModelo(); } catch (_) {}
    location.reload();
  };
  console.warn('[Vista Conecte] versão carregada:', APP_VERSAO, '· versão no servidor:', versaoNova);
}

setInterval(checarVersaoNova, 60 * 1000);   // 1x por minuto
checarVersaoNova();

// 4. Baixa de estoque: não existe mais horário marcado — ver baixaImediataDeProcessados,
// que roda junto com cada atualização de pedidos (startup, ciclo de 1 min e após processar).

// Resincroniza alturas ao redimensionar janela
// Força save ao fechar/atualizar página se houver edições pendentes
window.addEventListener('beforeunload', () => {
  if ((estEditado || prodEditado || cfgEditado) && modeloAtual !== '__dashboard__') {
    clearTimeout(saveTimer);
    salvarModelo();
  }
});

window.addEventListener('resize', () => {
  clearTimeout(window._syncTimer);
  window._syncTimer = setTimeout(syncRowHeights, 80);
});

// 4. CDN Supabase (realtime) carrega em segundo plano via onload
