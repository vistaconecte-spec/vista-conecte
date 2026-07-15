let modeloAtual = 'macacao-amplo';
let saveTimer = null;

// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPABASE_URL  = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhja3pzYmx3eWFibWh6Ympkamd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNTEyOTIsImV4cCI6MjA5NDcyNzI5Mn0.guif8jtidWmfqykhgDgPJiaRbWLoEEDMp1usTlAs1dQ';
let   supabase      = null;

function initSupabase() {
  try {
    if (window.supabase && SUPABASE_KEY !== '__SUPABASE_ANON_KEY__') {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
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

async function salvarNuvem(key, dados) {
  await salvarNuvemREST(key, dados);
}

async function carregarNuvem(key) {
  // Usa REST direto — não depende do CDN do Supabase
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/vc_modelos?id=eq.${encodeURIComponent(key)}&select=dados`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0]?.dados || null;
  } catch(e) { return null; }
}

// Carrega TODOS os modelos da nuvem — só atualiza se local estiver vazio ou nuvem for ESTRITAMENTE mais recente
async function carregarTodosNuvem() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/vc_modelos?select=id,dados`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, cache: 'no-store' }
    );
    if (!res.ok) return;
    const rows = await res.json();
    rows.forEach(row => {
      if (!row.id || !row.dados) return;
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
  if (!supabase) return;
  supabase
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
      else if (!estEditado && !prodEditado && !cfgEditado) renderModelo(modeloAtual);
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
      else if (!estEditado && !prodEditado && !cfgEditado) renderModelo(modeloAtual);
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
let cfgEditado  = false;
// Marca o último salvamento LOCAL (relógio local). Durante a carência logo após,
// a sincronização não sobrescreve o modelo aberto (evita corrida com o envio à nuvem).
let _ultimoSaveTs = 0;
const SYNC_CARENCIA_MS = 6000;
function modeloAbertoProtegido(id) {
  return id === modeloAtual &&
    (estEditado || prodEditado || cfgEditado || (Date.now() - _ultimoSaveTs < SYNC_CARENCIA_MS));
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
  const existente = loadLocal('vc:' + modeloAtual) || {};
  const agora = new Date().toISOString();
  saveLocal('vc:' + modeloAtual, {
    ...existente,
    est, prod,
    est_at:     estEditado  ? agora : (existente.est_at  || null),
    prod_at:    prodEditado ? agora : (existente.prod_at || null),
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
  const existente  = loadLocal('vc:' + modeloAtual) || {};
  const statusVal  = document.getElementById('prod-status').value;
  const data = {
    est, prod,
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

function getCoresTags() {
  return Array.from(document.querySelectorAll('#cores-tags .cor-tag span')).map(s => s.textContent);
}

function buildSidebar() {
  const nav = document.getElementById('sidebar-nav');
  nav.innerHTML = '';

  // Botão Dashboard no topo
  const dashItem = document.createElement('div');
  dashItem.className = 'nav-item nav-dashboard' + (modeloAtual === '__dashboard__' ? ' active' : '');
  dashItem.innerHTML = '<i class="ti ti-layout-dashboard"></i> INÍCIO';
  dashItem.onclick = () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    dashItem.classList.add('active');
    // Salva edições pendentes antes de ir ao dashboard
    if (modeloAtual !== '__dashboard__' && (estEditado || prodEditado || cfgEditado)) {
      clearTimeout(saveTimer);
      salvarModelo();
    }
    estEditado = false; prodEditado = false;
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

  // Título de seção: separa as ferramentas (acima) do catálogo de modelos (abaixo)
  const confTitle = document.createElement('div');
  confTitle.className = 'sidebar-section';
  confTitle.innerHTML = '<i class="ti ti-needle-thread"></i> CONFECÇÃO';
  nav.appendChild(confTitle);

  SIDEBAR_ESTRUTURA.forEach(grupo => {
    const title = document.createElement('div');
    title.className = 'sidebar-title';
    title.textContent = grupo.titulo;
    nav.appendChild(title);
    grupo.modelos.forEach(key => {
      const def = MODELOS[key];
      if (!def) return;
      const saved  = loadLocal('vc:' + key) || {};
      const status = saved.status || '';
      const item   = document.createElement('div');
      item.className  = 'nav-item' + (key === modeloAtual ? ' active' : '');
      item.dataset.key = key;
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
        item.textContent = nome;
      }
      item.onclick = () => selectModel(item, key);
      nav.appendChild(item);
    });
  });
}

// ─── ABA FINANCEIRA ──────────────────────────────────────────────────────────
const FIN_HASH = '61ec6cb14cce98a7e71c4ae4668d1df518e59a253aa83d0f7ba52773743aa78a';
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
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex === FIN_HASH) {
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
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex === FIN_HASH) {
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
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex === FIN_HASH) {
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
  ['sac', 'retorno', 'estorno'].forEach(s => {
    document.getElementById('atd-sub-' + s).style.display = (s === sub) ? '' : 'none';
    const pill = document.getElementById('atd-pill-' + s);
    if (pill) pill.classList.toggle('active', s === sub);
  });
  if (sub === 'sac') sacRender();
  else if (sub === 'retorno') { retRender(); retSincronizarShopify(); }
  else if (sub === 'estorno') { estRender(); estSincronizarShopify(); }
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
      window._sacItensAtuais = d.itens || []; // usado pelo checkbox de "faltando"
      const itensHtml = (d.itens || []).map((i, idx) => `
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer;padding:2px 0">
          <input type="checkbox" onchange="sacFaltanteToggle()" data-sac-faltante="${idx}">
          ${i.qtd}× ${i.titulo}${i.variante ? ' (' + i.variante + ')' : ''}
        </label>`).join('');
      const statusCor = d.cancelado ? '#dc2626' : (d.status_financeiro === 'paid' ? '#16a34a' : '#b45309');
      preview.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline">
          <strong>${d.numero}</strong>
          <span>${d.cliente || '(sem nome)'}</span>
          <span style="color:${statusCor};font-weight:600">${d.cancelado ? 'cancelado' : d.status_financeiro}</span>
          <span style="color:var(--text-ter)">${d.status_envio === 'fulfilled' ? 'enviado' : d.status_envio === 'partial' ? 'parcialmente enviado' : 'não enviado'}</span>
          ${d.rastreio ? `<span style="color:var(--text-ter)">rastreio: ${d.rastreio}</span>` : ''}
        </div>
        <div style="margin-top:4px">${itensHtml || '<span style="color:var(--text-ter)">(sem itens)</span>'}</div>
        ${(d.itens || []).length ? '<div style="font-size:11px;color:var(--text-ter);margin-top:2px">marque as peças que estão faltando pra preencher o motivo sozinho</div>' : ''}`;
      // Preenche o rastreio automaticamente se o campo ainda estiver vazio
      const rastreioEl = document.getElementById('sac-rastreio');
      if (d.rastreio && rastreioEl && !rastreioEl.value) rastreioEl.value = d.rastreio;
    } catch (e) {
      preview.innerHTML = '<span style="color:#dc2626">Erro ao buscar pedido.</span>';
    }
  }, 500);
}

// Monta "Informação da expedição" a partir das peças marcadas como faltando na prévia do pedido.
function sacFaltanteToggle() {
  const marcados = Array.from(document.querySelectorAll('[data-sac-faltante]:checked'))
    .map(el => window._sacItensAtuais[parseInt(el.dataset.sacFaltante)])
    .filter(Boolean);
  const infoEl = document.getElementById('sac-info-expedicao');
  if (!infoEl) return;
  if (marcados.length === 0) { infoEl.value = ''; return; }
  infoEl.value = 'Faltando: ' + marcados.map(i => `${i.titulo}${i.variante ? ' (' + i.variante + ')' : ''}`).join(', ');
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
  const infoExpedicao = (document.getElementById('sac-info-expedicao').value || '').trim();
  const rastreio = (document.getElementById('sac-rastreio').value || '').trim();
  if (!pedido || !caso) { alert('Preencha ao menos o nº do pedido e a informação do caso.'); return; }
  const cfg = sacGetConfig();
  const novo = {
    id: 'sac' + Date.now(), pedido, caso, info_expedicao: infoExpedicao,
    rastreio, status: 'pendente', criado_em: new Date().toISOString(),
  };
  cfg.tickets.push(novo);
  sacSalvar(cfg);
  sacRender();
  sacCarregarItens(novo.id, pedido); // busca itens/cliente em segundo plano
  ['sac-pedido', 'sac-caso', 'sac-info-expedicao', 'sac-rastreio'].forEach(id => document.getElementById(id).value = '');
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
  sacRender();
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
  sacRender();
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
function retAdd() {
  const cliente  = (document.getElementById('ret-cliente').value || '').trim();
  const data     = (document.getElementById('ret-data').value || '').trim();
  const produtos = (document.getElementById('ret-produtos').value || '').trim();
  const obs      = (document.getElementById('ret-obs').value || '').trim();
  const codigo   = (document.getElementById('ret-codigo').value || '').trim();
  if (!cliente || !produtos) { alert('Preencha ao menos o cliente e os produtos.'); return; }
  const cfg = retGetConfig();
  cfg.itens.push({ id: 'ret' + Date.now(), cliente, data, produtos, obs, codigo_reenvio: codigo, status: 'pendente', criado_em: new Date().toISOString() });
  retSalvar(cfg);
  retRender();
  ['ret-cliente', 'ret-data', 'ret-produtos', 'ret-obs', 'ret-codigo'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('ret-cliente').focus();
}
function retToggle(id) {
  const cfg = retGetConfig();
  const t = cfg.itens.find(x => x.id === id); if (!t) return;
  t.status = (t.status === 'resolvido') ? 'pendente' : 'resolvido';
  retSalvar(cfg);
  retRender();
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
  retRender();
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
function retRender() {
  const cfg = retGetConfig();
  const mostrarResolvidos = document.getElementById('ret-mostrar-resolvidos')?.checked;
  const lista = cfg.itens
    .filter(t => mostrarResolvidos || t.status !== 'resolvido')
    .sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''));
  const rows = lista.map(t => `
    <tr style="${t.status === 'resolvido' ? 'opacity:0.5' : ''}">
      <td style="padding:4px"><input type="checkbox" ${t.status === 'resolvido' ? 'checked' : ''} onchange="retToggle('${t.id}')" title="marcar como resolvido"></td>
      <td style="padding:4px"><input value="${(t.cliente || '').replace(/"/g, '&quot;')}" oninput="retEdit('${t.id}','cliente',this.value)" style="width:150px;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px;${t.status === 'resolvido' ? 'text-decoration:line-through' : ''}"></td>
      <td style="padding:4px;white-space:nowrap">${t.data || ''}</td>
      <td style="padding:4px"><input value="${(t.produtos || '').replace(/"/g, '&quot;')}" oninput="retEdit('${t.id}','produtos',this.value)" style="width:100%;min-width:180px;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:4px"><input value="${(t.obs || '').replace(/"/g, '&quot;')}" oninput="retEdit('${t.id}','obs',this.value)" style="width:120px;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:4px"><input value="${(t.codigo_reenvio || '').replace(/"/g, '&quot;')}" oninput="retEdit('${t.id}','codigo_reenvio',this.value)" style="width:130px;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:4px;text-align:center"><button onclick="retDel('${t.id}')" title="excluir" style="background:none;border:none;cursor:pointer;color:var(--text-ter);font-size:15px">×</button></td>
    </tr>`).join('');
  document.getElementById('ret-tbody').innerHTML = rows ||
    '<tr><td colspan="7" style="text-align:center;color:var(--text-ter);font-size:12px;padding:12px">Nenhum registro ' + (mostrarResolvidos ? '' : 'pendente') + '.</td></tr>';
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
  estRender();
}
function estDel(id) {
  if (!confirm('Excluir esse registro de devolução?')) return;
  const cfg = estGetConfig();
  cfg.itens = cfg.itens.filter(x => x.id !== id);
  estSalvar(cfg);
  estRender();
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
function estRender() {
  const cfg = estGetConfig();
  const lista = [...cfg.itens].sort((a, b) => (b.criado_em || '').localeCompare(a.criado_em || ''));
  const rows = lista.map(t => `
    <tr>
      <td style="padding:4px"><input value="${(t.cliente || '').replace(/"/g, '&quot;')}" oninput="estEdit('${t.id}','cliente',this.value)" style="width:150px;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:4px"><input value="${(t.pecas || '').replace(/"/g, '&quot;')}" oninput="estEdit('${t.id}','pecas',this.value)" style="width:100%;min-width:200px;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:4px"><input type="number" step="0.01" value="${t.valor}" oninput="estEdit('${t.id}','valor',this.value)" style="width:90px;text-align:right;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:4px"><input value="${(t.codigo_devolucao || '').replace(/"/g, '&quot;')}" oninput="estEdit('${t.id}','codigo_devolucao',this.value)" style="width:130px;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:4px;white-space:nowrap">${t.data || ''}</td>
      <td style="padding:4px"><input value="${(t.motivo || '').replace(/"/g, '&quot;')}" oninput="estEdit('${t.id}','motivo',this.value)" style="width:140px;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:5px"></td>
      <td style="padding:4px;text-align:center"><button onclick="estDel('${t.id}')" title="excluir" style="background:none;border:none;cursor:pointer;color:var(--text-ter);font-size:15px">×</button></td>
    </tr>`).join('');
  document.getElementById('atd-est-tbody').innerHTML = rows ||
    '<tr><td colspan="7" style="text-align:center;color:var(--text-ter);font-size:12px;padding:12px">Nenhum registro de devolução.</td></tr>';
  const total = cfg.itens.reduce((s, t) => s + (t.valor || 0), 0);
  const totalEl = document.getElementById('atd-est-total-valor');
  if (totalEl) totalEl.textContent = 'R$ ' + total.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex === FIN_HASH) {
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
  return loadLocal('vc:precificacao') || { global: { custoMetro: 28, taxa: 2.6, plataforma: 1.05, imposto: 0, marketing: 26.73, fixos: 9.55, logistica: 2.09, margem: 25 }, modelos: {} };
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
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex === FIN_HASH) {
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
  const g = cfg.global || { custoMetro: 28, taxa: 2.6, imposto: 0, margem: 25 };
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
    if (estEditado || prodEditado || cfgEditado) salvarModelo(); // salva enquanto o DOM ainda é do modelo correto
    estEditado  = false;
    prodEditado = false;
    esconderBtnSalvar();
  }

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  el.classList.add('active');
  document.body.classList.remove('precos-mode');
  modeloAtual = key;
  location.hash = key; // persiste na URL para sobreviver ao refresh
  document.getElementById('tabs-modelo').style.display = '';
  document.getElementById('topbar-actions').style.display = '';
  renderModelo(key); // localStorage já foi sincronizado no startup — renderiza direto
  showTab('producao');
  closeSidebar();
}

function confirmarStatus(key, novoStatus) {
  const saved = loadLocal('vc:' + key) || {};
  saved.status     = novoStatus;
  saved.status_at  = ['Em corte', 'Em costura'].includes(novoStatus) ? new Date().toISOString() : null;
  saved.updated_at = new Date().toISOString();
  saveLocal('vc:' + key, saved);
  salvarNuvem(key, saved);
  buildSidebar();
  verificarAvisosStatus();
  if (modeloAtual === key) {
    const sel = document.getElementById('prod-status');
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

  const avisos = []; // { regra, nome, horas, key }

  for (const [key, def] of Object.entries(MODELOS)) {
    const saved    = loadLocal('vc:' + key) || {};
    const statusAt = saved.status_at ? new Date(saved.status_at).getTime() : null;
    if (!statusAt) continue;
    const horas = Math.floor((Date.now() - statusAt) / 3600000);

    // Pega a regra mais severa que se aplica (urgente tem prioridade)
    const regrasAplicaveis = REGRAS.filter(r => r.status === saved.status && horas >= r.horasMin);
    if (regrasAplicaveis.length === 0) continue;
    const regra = regrasAplicaveis[regrasAplicaveis.length - 1]; // última = mais severa
    avisos.push({ regra, nome: saved.nome || def.nome, horas, key });
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
              <button onclick="confirmarStatus('${v.key}', '${r.proxStatus}')"
                style="background:${r.cor};color:${r.cor === '#f59e0b' ? '#111' : '#fff'};border:none;border-radius:4px;padding:5px 14px;font-size:11px;font-weight:800;cursor:pointer;letter-spacing:0.04em;white-space:nowrap">
                ${r.emoji} ${r.label}
              </button>
            </div>`).join('')}
        </div>
      </div>`;
  }).join('');
}

function renderDashboard() {
  document.getElementById('model-title').innerHTML = '';
  document.getElementById('model-sub').textContent = '';
  document.getElementById('topbar-actions').style.display = 'none';
  document.getElementById('tabs-modelo').style.display = 'none';

  const modelData = [];
  for (const [key, def] of Object.entries(MODELOS)) {
    if (CONJUNTO_PECAS[key]) continue; // Conjuntos excluídos — peças já contadas individualmente
    const saved = loadLocal('vc:' + key) || {};
    const cores = saved.cores || def.cores;
    const tuMD = !!def.tamanhoUnico;
    let pedidos = 0, estoque = 0, produzir = 0;
    cores.forEach(cor => {
      const ab = def.aberto && def.aberto[cor] || [0,0,0,0,0];
      const ev = saved.est && saved.est[cor] || [0,0,0,0,0];
      const pv = saved.prod && saved.prod[cor] || null;
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
      const cores      = [...new Set([...def.cores, ...(saved.cores || [])])];
      const tu         = !!def.tamanhoUnico || !!def.tamanhos; // tamanhos customizados (ex: sapatos) → exibe só total
      const statusNorm = STATUS_VALIDOS.includes(saved.status) ? saved.status : '';
      // Cálculo: Pedidos − Estoque − Em Produção (líquido que realmente falta produzir).
      // O que já está coberto pela produção zera e some; o que sobrou aparece,
      // mesmo que o modelo já tenha algo em produção (status na coluna ao lado).
      const sizes = [0,0,0,0,0];
      let total   = 0;
      cores.forEach(cor => {
        const szLen = def.tamanhos?.length || 5;
        const ab = (def.aberto[cor] || []).concat(new Array(szLen).fill(0)).slice(0, szLen);
        const ev = ((saved.est && saved.est[cor]) || []).concat(new Array(szLen).fill(0)).slice(0, szLen);
        const pv = ((saved.prod && saved.prod[cor]) || []).concat(new Array(szLen).fill(0)).slice(0, szLen);
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
            <th>PP</th><th>P</th><th>M</th><th>G</th><th>GG</th>
            <th>Total</th>
          </tr></thead>
          <tbody>
            ${urgList.map(u => `
              <tr style="cursor:pointer" onclick="(function(){const ni=Array.from(document.querySelectorAll('.nav-item')).find(el=>el.textContent.trim()==='${u.nome.replace(/'/g,"\\'")}');if(ni)ni.click();})()">
                <td style="font-weight:600">${u.nome}</td>
                <td style="font-size:11px;color:var(--text-sec)">${u.status || '—'}</td>
                ${u.tu
                  ? `<td colspan="5" style="text-align:center;color:var(--text-ter)">${MODELOS[u.key]?.tamanhos ? 'Numeração' : 'Tam. único'}</td>`
                  : u.sizes.map(v => `<td class="${v>0?'saldo-falta':''}">${v||'—'}</td>`).join('')
                }
                <td style="font-weight:700;color:#dc2626">${u.total}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    }
  }
  // ───────────────────────────────────────────────────────────────────────────

  // ── Card Em Produção ─────────────────────────────────────────────────────────
  const producaoEl    = document.getElementById('dash-producao');
  const producaoTotEl = document.getElementById('dash-producao-total');
  if (producaoEl) {
    const prodList = [];
    for (const [key, def] of Object.entries(MODELOS)) {
      if (CONJUNTO_PECAS[key]) continue;
      const saved = loadLocal('vc:' + key) || {};
      if (!['Comprando tecido', 'Em corte', 'Em costura'].includes(saved.status)) continue;
      const cores  = [...new Set([...def.cores, ...(saved.cores || [])])];
      const tuP    = !!def.tamanhoUnico;
      let totalProd = 0;
      cores.forEach(cor => {
        const pv = saved.prod && saved.prod[cor];
        if (pv) totalProd += pv.reduce((a,b) => (a||0)+(b||0), 0);
      });
      if (totalProd > 0) prodList.push({ key, nome: def.nome, status: saved.status, total: totalProd });
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
              <tr style="cursor:pointer" onclick="(function(){const ni=Array.from(document.querySelectorAll('.nav-item')).find(el=>el.textContent.trim()==='${p.nome.replace(/'/g,"\\'")}');if(ni)ni.click();})()">
                <td style="font-weight:600">${p.nome}</td>
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
      if (saved.status !== 'Comprando tecido') continue;
      const consumo  = saved.consumo || def.consumo;
      const preco    = saved.preco   || def.preco || 0;
      const tecido   = saved.tecido  || def.tecido;
      const cores    = [...new Set([...def.cores, ...(saved.cores || [])])];
      // Usa Em Produção para calcular metros; se vazio usa Pedidos − Estoque
      const tuC = !!def.tamanhoUnico;
      let totalPecas = 0;
      cores.forEach(cor => {
        const pv = saved.prod && saved.prod[cor];
        if (pv) {
          totalPecas += pv.reduce((a,b) => a+b, 0);
        } else {
          const ab = def.aberto[cor] || [0,0,0,0,0];
          const ev = saved.est && saved.est[cor] || [0,0,0,0,0];
          if (tuC) {
            totalPecas += Math.max(0, ab.reduce((a,b) => a+b, 0) - (ev[0]||0));
          } else {
            ab.forEach((a,i) => { totalPecas += Math.max(0, a - (ev[i]||0)); });
          }
        }
      });
      const metros = totalPecas * consumo;
      const custo  = metros * preco;
      if (metros > 0) compraList.push({ key, nome: def.nome, tecido, metros, custo, preco });
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
              <tr style="cursor:pointer" onclick="(function(){const ni=Array.from(document.querySelectorAll('.nav-item')).find(el=>el.textContent.trim()==='${c.nome.replace(/'/g,"\\'")}');if(ni)ni.click();})()">
                <td style="font-weight:600">${c.nome}</td>
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
      if (saved.status !== 'Comprando tecido') continue;
      const cores = [...new Set([...def.cores, ...(saved.cores || [])])];
      const tuCst = !!def.tamanhoUnico;
      let tot = 0;
      cores.forEach(cor => {
        const pv = saved.prod && saved.prod[cor];
        if (pv) { tot += pv.reduce((a,b) => a+b, 0); }
        else {
          const ab = def.aberto[cor] || [0,0,0,0,0];
          const ev = saved.est && saved.est[cor] || [0,0,0,0,0];
          tot += calcFalta(ab, ev, tuCst);
        }
      });
      if (tot > 0) { totalModelos++; totalPecas += tot; }
    }
    if (totalModelos === 0) {
      costuraEl.innerHTML = '<div style="font-size:12px;color:var(--text-ter);padding:4px 0">Nenhum modelo comprando tecido no momento.</div>';
    } else {
      costuraEl.innerHTML = `<div style="font-size:12px;color:var(--text-sec);padding:4px 0">${totalModelos} modelo${totalModelos>1?'s':''} · <strong>${totalPecas} peças</strong> a produzir</div>`;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // Exclui conjuntos do total de pedidos (suas peças já são contadas individualmente após distribuição)
  const totalPedidos  = modelData.filter(m => !CONJUNTO_PECAS[m.key]).reduce((s,m) => s + m.pedidos, 0);
  const comPedidos    = modelData.filter(m => m.pedidos > 0 && !CONJUNTO_PECAS[m.key]).length;
  const totalProduzir = modelData.filter(m => !CONJUNTO_PECAS[m.key]).reduce((s,m) => s + m.produzir, 0);
  const urgentes      = modelData.filter(m => m.produzir > 0 && !CONJUNTO_PECAS[m.key]).length;

  document.getElementById('dash-m-pedidos').textContent  = totalPedidos;
  document.getElementById('dash-m-produzir').textContent = totalProduzir;
  document.getElementById('dash-m-alertas').textContent  = urgentes;
  const ign = (window._shopifyIgnorados || []).length;
  const ignEl = document.getElementById('dash-m-ignorados');
  if (ignEl) { ignEl.textContent = ign; ignEl.style.color = ign > 0 ? '#dc2626' : '#16a34a'; }
  verificarAvisosStatus();

  // Mais vendidos (top 5)
  const top5 = [...modelData].sort((a,b) => b.pedidos - a.pedidos).filter(m => m.pedidos > 0).slice(0, 5);
  const mvEl = document.getElementById('dash-mais-vendidos');
  if (top5.length === 0) {
    mvEl.innerHTML = '<div style="font-size:12px;color:var(--text-ter);padding:8px">Nenhum pedido em aberto.</div>';
  } else {
    const max = top5[0].pedidos;
    mvEl.innerHTML = top5.map((m, i) => `
      <div class="dash-mv-card" onclick="document.querySelector('[data-key=\\'${m.key}\\']')?.click()">
        <div class="dash-mv-rank">#${i+1}</div>
        <div class="dash-mv-nome">${m.nome}</div>
        <div class="dash-mv-bar-wrap"><div class="dash-mv-bar" style="width:${Math.round(m.pedidos/max*100)}%"></div></div>
        <div class="dash-mv-val">${m.pedidos} <span>pedidos</span></div>
      </div>`).join('');
    // Adiciona data-key para clique
    top5.forEach(m => {
      const navItem = Array.from(document.querySelectorAll('.nav-item')).find(el => {
        return el.textContent.trim() === MODELOS[m.key]?.nome;
      });
      const card = mvEl.querySelector(`[onclick*="${m.key}"]`);
      if (card && navItem) card.onclick = () => navItem.click();
    });
  }

  // Saldo de estoque (estoque disponível além dos pedidos)
  const saldoRows = [];
  for (const [key, def] of Object.entries(MODELOS)) {
    const saved = loadLocal('vc:' + key) || {};
    const cores = saved.cores || def.cores;
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
      return `<tr class="dash-row" style="cursor:pointer" onclick="(function(){
        const ni = Array.from(document.querySelectorAll('.nav-item')).find(el => el.textContent.trim()==='${r.nome.replace(/'/g,"\\'")}');
        if(ni) ni.click();
      })()">
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
    <tr class="dash-row" style="cursor:pointer" onclick="(function(){
      const ni = Array.from(document.querySelectorAll('.nav-item')).find(el => el.textContent.trim()==='${m.nome.replace(/'/g,"\\'")}');
      if(ni) ni.click();
    })()">
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
    if (saved.status !== 'Em corte' && saved.status !== 'Em costura') continue;
    const cores = [...new Set([...def.cores, ...(saved.cores || [])])];
    let totalProd = 0;
    cores.forEach(cor => {
      const pv = saved.prod && saved.prod[cor];
      if (pv) totalProd += pv.reduce((a, b) => (a || 0) + (b || 0), 0);
    });
    if (totalProd <= 0) continue;
    if (saved.status === 'Em corte') { corte += totalProd; corteMods++; corteList.push({ key, nome: def.nome, total: totalProd }); }
    else                             { costura += totalProd; costuraMods++; costuraList.push({ key, nome: def.nome, total: totalProd }); }
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
            <tr style="cursor:pointer;border-top:1px solid rgba(0,0,0,0.06)" onclick="(function(){const ni=Array.from(document.querySelectorAll('.nav-item')).find(el=>el.textContent.trim()==='${p.nome.replace(/'/g, "\\'")}');if(ni)ni.click();})()">
              <td style="padding:5px 2px;font-size:13px;font-weight:600">${p.nome}</td>
              <td style="padding:5px 2px;text-align:right;font-size:13px;font-weight:700;color:${cor}">${p.total}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  if (corteListaEl)   corteListaEl.innerHTML   = listaHTML(corteList, '#7C3AED');
  if (costuraListaEl) costuraListaEl.innerHTML = listaHTML(costuraList, '#0891b2');
}

// ─── CARD: PEDIDOS PRONTOS PARA ENVIO ────────────────────────────────────────
// Lista os pedidos da Shopify cujos itens TODOS têm estoque disponível.
// Aloca o estoque do pedido mais antigo para o mais recente, então a lista
// reflete o que pode realmente ser enviado em sequência (sem disputar a mesma peça).
function renderProntosParaEnvio() {
  const el    = document.getElementById('dash-prontos');
  const totEl = document.getElementById('dash-prontos-total');
  if (!el) return;

  const COR_ALIASES_DIST = { 'Branca': 'Off White', 'Branco': 'Off White' };

  // Estoque de trabalho: cópia do estoque atual (será decrementado conforme aloca)
  const stock = {};
  for (const key of Object.keys(MODELOS)) {
    const saved = loadLocal('vc:' + key) || {};
    const cores = [...new Set([...MODELOS[key].cores, ...(saved.cores || [])])];
    stock[key] = {};
    cores.forEach(cor => {
      const ev = (saved.est && saved.est[cor]) || [];
      stock[key][cor] = ev.map(v => v || 0);
    });
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

  // Expande um item do pedido em requisitos de estoque (conjuntos → peças individuais)
  const reqsDoItem = (item) => {
    const reqs = [];
    const { modelKey, cor, tam, qtd } = item;
    if (CONJUNTO_PECAS[modelKey]) {
      for (const peca of CONJUNTO_PECAS[modelKey]) {
        const pecaKey = typeof peca === 'string' ? peca : peca.key;
        if (!MODELOS[pecaKey]) continue;
        let pecaCor;
        if (typeof peca === 'string') {
          const corAlias = COR_ALIASES_DIST[cor] || cor;
          pecaCor = MODELOS[pecaKey].aberto.hasOwnProperty(corAlias) ? corAlias : cor;
        } else {
          pecaCor = peca.cor;
        }
        reqs.push({ key: pecaKey, cor: pecaCor, tam, qtd });
      }
    } else if (MODELOS[modelKey]) {
      reqs.push({ key: modelKey, cor, tam, qtd });
    }
    return reqs;
  };

  // Só pedidos PAGOS entram (exclui pendentes, autorizados, expirados, estornados, etc.)
  // 'paid' = pago integral | 'partially_refunded' = pago e com reembolso parcial (ainda enviável)
  const STATUS_PAGO = new Set(['paid', 'partially_refunded']);

  // Prioridade de liberação (alocação de estoque E exibição):
  //   1º PARCIAIS (já começaram a ser enviados)
  //   2º GRANDES (acima de 4 peças — senão ficam pra trás)
  //   3º demais
  //   → dentro de cada faixa, do mais antigo para o mais recente.
  const GRANDE_MIN = 5; // "acima de 4 itens"
  const totPecas = p => (p.itens || []).reduce((s, it) => s + (it.qtd || 0), 0);
  const prioridade = p => (p.parcial ? 2 : 0) + (totPecas(p) >= GRANDE_MIN ? 1 : 0);
  const detalhados = (window._shopifyDetalhados || [])
    .filter(p => STATUS_PAGO.has(p.financial_status))
    .sort((a, b) => (prioridade(b) - prioridade(a)) || (new Date(a.data || 0) - new Date(b.data || 0)));

  const prontos = [];
  for (const ped of detalhados) {
    let reqs = [];
    for (const item of ped.itens) reqs = reqs.concat(reqsDoItem(item));
    if (reqs.length === 0) continue; // pedido sem itens mapeáveis

    const disponivel = reqs.every(r => estGet(r.key, r.cor, r.tam) >= r.qtd);
    if (!disponivel) continue;

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
    });
  }

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
          const pedidoCell = (p.url
            ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="font-weight:700;color:#16a34a;text-decoration:none" title="Abrir pedido na Shopify">${esc(p.numero)} <i class="ti ti-external-link" style="font-size:11px;vertical-align:-1px"></i></a>`
            : `<span style="font-weight:700;color:#16a34a">${esc(p.numero)}</span>`) + badgeParcial + badgeGrande;
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

    // Recarrega pedidos da Shopify (o pedido cumprido sai do filtro "unshipped") e re-renderiza
    await carregarPedidosShopify();
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
    tr.onclick = () => {
      const ni = Array.from(document.querySelectorAll('.nav-item')).find(el => el.textContent.trim() === m.nome);
      if (ni) ni.click();
    };
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
    tr.onclick = () => {
      const ni = Array.from(document.querySelectorAll('.nav-item')).find(el => el.textContent.trim() === r.nome);
      if (ni) ni.click();
    };
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
  // (modelos com tamanhos customizados como sapatos ignoram cores obsoletas do localStorage)
  const coresExtras = def.tamanhos ? [] : (d.cores || []);
  const cores = [...new Set([...def.cores, ...coresExtras])];

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
  document.getElementById('cfg-nome').value = nome;
  document.getElementById('cfg-tecido').value = tecido;
  document.getElementById('cfg-consumo').value = consumo;
  document.getElementById('cfg-componentes').value = d.componentes || def.componentes;
  document.getElementById('cfg-obs').value = d.obs || def.obs;

  renderCoresTags(cores);

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

    if (tu) {
      // Pedidos: soma total
      abt.innerHTML += `<tr><td>${cor}</td><td class="${abTot > 0 ? 'val-areia' : ''}">${abTot || '—'}</td></tr>`;
      // Estoque: 1 input — total armazenado em ev[0]
      const etot = ev[0] || 0;
      const minTU = Math.max(0, abTot - etot);
      const pvTU  = d.prod && d.prod[cor] ? (d.prod[cor][0] || 0) : minTU;
      est.innerHTML  += `<tr data-cor="${cor}"><td>${cor}</td><td><input class="ci${etot > 0 ? ' ci-val' : ''}" type="number" min="0" value="${etot || ''}" placeholder="—" oninput="marcarEstEditado()"></td></tr>`;
      prod.innerHTML += `<tr data-cor="${cor}" data-min="${minTU}"><td>${cor}</td><td><input class="ci${pvTU > 0 ? (pvTU > minTU ? ' acima' : ' ci-val') : ''}" type="number" min="0" value="${pvTU || ''}" placeholder="—" oninput="marcarProdEditado();calcProdTU(this);autoSave()"></td></tr>`;
    } else {
      const mins = ab.map((a, i) => Math.max(0, a - ev[i]));
      const pv   = d.prod && d.prod[cor] || mins;
      abt.innerHTML  += `<tr><td>${cor}</td>${ab.map(v => `<td class="${v > 0 ? 'val-areia' : ''}">${v || '—'}</td>`).join('')}<td class="${abTot > 0 ? 'val-areia' : ''}">${abTot || '0'}</td></tr>`;
      const etot = ev.reduce((a, b) => a + b, 0);
      est.innerHTML  += `<tr data-cor="${cor}"><td>${cor}</td>${ev.map(v => `<td><input class="ci${v > 0 ? ' ci-val' : ''}" type="number" min="0" value="${v || ''}" placeholder="—" oninput="marcarEstEditado()"></td>`).join('')}<td class="re ${etot > 0 ? 'val-grafite' : ''}">${etot || '—'}</td></tr>`;
      const ptot = pv.reduce((a, b) => a + b, 0);
      prod.innerHTML += `<tr data-cor="${cor}" data-min="${mins.join(',')}"><td>${cor}</td>${pv.map((v, i) => `<td><input class="ci${v > 0 ? (v > mins[i] ? ' acima' : ' ci-val') : ''}" type="number" min="0" value="${v || ''}" placeholder="—" oninput="marcarProdEditado();calcProd(this);autoSave()"></td>`).join('')}<td class="rp ${ptot > 0 ? 'val-escuro' : ''}">${ptot || '—'}</td></tr>`;
    }
  });

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
  const cores = [...new Set([...def.cores, ...(d.cores || [])])];
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

  const totAp = tu ? [0] : [0,0,0,0,0];
  const totSl = tu ? [0] : [0,0,0,0,0];
  let sumAp = 0, sumSl = 0;

  cores.forEach(cor => {
    const ab = def.aberto[cor] || [0,0,0,0,0];
    const ev = d.est  && d.est[cor]  || [0,0,0,0,0];
    const pv = d.prod && d.prod[cor] || [0,0,0,0,0];

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
}

function renderCoresTags(cores) {
  const container = document.getElementById('cores-tags');
  container.innerHTML = '';
  cores.forEach(cor => {
    const tag = document.createElement('div');
    tag.className = 'cor-tag';
    tag.innerHTML = `<span>${cor}</span><button onclick="removerCor(this)" title="Remover">×</button>`;
    container.appendChild(tag);
  });
}

function addCor() {
  const inp = document.getElementById('nova-cor');
  const val = inp.value.trim();
  if (!val) return;
  const tag = document.createElement('div');
  tag.className = 'cor-tag';
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

// Preenche a tabela de produção com max(0, aberto − estoque) para cada cor/tamanho
function recalcularProducao() {
  const def = MODELOS[modeloAtual];
  if (!def) return;
  const saved = loadLocal('vc:' + modeloAtual) || {};
  const tu = !!def.tamanhoUnico;

  document.querySelectorAll('#prod-tbody tr').forEach(row => {
    const cor = row.dataset.cor;
    const ab  = def.aberto[cor]  || [0, 0, 0, 0, 0];
    const ev  = saved.est && saved.est[cor] || [0, 0, 0, 0, 0];
    const inputs = Array.from(row.querySelectorAll('input'));

    if (tu) {
      // tamanhoUnico: 1 input = total. estoque salvo em ev[0], aberto = soma total
      const abTot  = ab.reduce((a, b) => a + b, 0);
      const estTot = ev[0] || 0;
      const minTU  = Math.max(0, abTot - estTot);
      inputs[0].value = minTU || '';
      calcProdTU(inputs[0]);
    } else {
      const mins = ab.map((a, i) => Math.max(0, a - ev[i]));
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
  const cores = [...new Set([...def.cores, ...(saved.cores || [])])];

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
  const tots = [0, 0, 0, 0, 0];
  const dados = [];
  document.querySelectorAll('#prod-tbody tr').forEach(row => {
    const cor = row.dataset.cor;
    const vals = Array.from(row.querySelectorAll('input')).map(i => parseInt(i.value) || 0);
    vals.forEach((v, i) => tots[i] += v);
    const pecas = vals.reduce((a, b) => a + b, 0);
    if (pecas > 0) dados.push({ cor, pecas, metros: pecas * consumo, custo: pecas * consumo * preco });
  });
  ['PP', 'P', 'M', 'G', 'GG'].forEach((s, i) => { const el = document.getElementById('p-' + s); if (el) el.textContent = tots[i]; });
  const sum = tots.reduce((a, b) => a + b, 0);
  const pt = document.getElementById('p-tot'); if (pt) { pt.textContent = sum; pt.className = sum > 0 ? 'val-escuro' : ''; }
  document.getElementById('m-produzir').textContent = sum;
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

async function gerarFicha() {
  const def = MODELOS[modeloAtual];
  const tu = !!def.tamanhoUnico;
  const saved = loadLocal('vc:' + modeloAtual) || {};
  const nome = saved.nome || def.nome;
  const tecido = saved.tecido || def.tecido;
  const consumo = saved.consumo || def.consumo;
  const status = document.getElementById('prod-status').value;
  const prazo = document.getElementById('prod-prazo').value;
  const componentes = saved.componentes || def.componentes || '—';
  const obs = saved.obs || def.obs || '';
  const cores = saved.cores || def.cores;
  // prioridade: upload manual → legado → caminho padrão do modelo
  const croquiFrenteRaw = loadLocal('vc:croqui-frente:' + modeloAtual) || loadLocal('vc:croqui:' + modeloAtual) || def.croquiFrente || null;
  const croquiCostasRaw = loadLocal('vc:croqui-costas:' + modeloAtual) || def.croquiCostas || null;

  // Converte caminhos de URL para base64 (garante impressão offline)
  const [croquiFrente, croquiCostas] = await Promise.all([
    urlToBase64(croquiFrenteRaw),
    urlToBase64(croquiCostasRaw)
  ]);

  // Coleta dados de produção
  const prodRows = [];
  document.querySelectorAll('#prod-tbody tr').forEach(row => {
    const cor = row.dataset.cor;
    const vals = Array.from(row.querySelectorAll('input')).map(i => parseInt(i.value) || 0);
    const tot = vals.reduce((a, b) => a + b, 0);
    prodRows.push({ cor, vals, tot });
  });
  const prodTots = [0,0,0,0,0];
  prodRows.forEach(r => r.vals.forEach((v,i) => prodTots[i] += v));
  const prodTotal = prodTots.reduce((a,b) => a+b, 0);

  const hoje = new Date().toLocaleDateString('pt-BR');
  const prazoFmt = prazo ? new Date(prazo + 'T12:00:00').toLocaleDateString('pt-BR') : '—';

  const colSpan = tu ? 2 : 7;
  const colorRowsHtml = prodRows.map((r, idx) => {
    const bg = idx % 2 === 1 ? '#faf8f5' : '#fff';
    const sizeCells = tu ? '' : r.vals.map(v => `<td style="text-align:center;padding:7px 8px;border:1px solid #ddd;background:${bg};color:${v ? '#111' : '#ccc'};">${v || '—'}</td>`).join('');
    return `
    <tr>
      <td style="text-align:left;font-weight:600;padding:7px 12px;border:1px solid #ddd;background:${bg};">${r.cor}</td>
      ${sizeCells}
      <td style="text-align:center;padding:7px 8px;border:1px solid #ddd;background:${bg};font-weight:700;">${r.tot || '—'}</td>
    </tr>`;
  }).join('');

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
          ${tu ? '' : '<th>PP</th><th>P</th><th>M</th><th>G</th><th>GG</th>'}
          <th style="background:#C4A882;">Total</th>
        </tr>
      </thead>
      <tbody>
        <tr><td colspan="${colSpan}" class="section-hd">Total de peças a produzir</td></tr>
        ${colorRowsHtml || `<tr><td colspan="${colSpan}" style="text-align:center;color:#bbb;padding:12px;">Nenhuma peça em produção</td></tr>`}
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

  // Coleta todos os modelos com status "Comprando tecido"
  const modelos = [];
  for (const [key, def] of Object.entries(MODELOS)) {
    if (CONJUNTO_PECAS[key]) continue;
    const saved = loadLocal('vc:' + key) || {};
    if (saved.status !== 'Comprando tecido') continue;
    const consumo = saved.consumo || def.consumo;
    const preco   = saved.preco   || def.preco || 0;
    const tecido  = (saved.tecido || def.tecido || '').trim();
    const cores   = [...new Set([...def.cores, ...(saved.cores || [])])];
    const tuFC = !!def.tamanhoUnico;
    let totalPecas = 0;
    cores.forEach(cor => {
      const pv = saved.prod && saved.prod[cor];
      if (pv) {
        totalPecas += pv.reduce((a,b) => a+b, 0);
      } else {
        const ab = def.aberto[cor] || [0,0,0,0,0];
        const ev = saved.est && saved.est[cor] || [0,0,0,0,0];
        totalPecas += calcFalta(ab, ev, tuFC);
      }
    });
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
    if (saved.status !== 'Comprando tecido') continue;
    const consumo = saved.consumo || def.consumo;
    const preco   = saved.preco   || def.preco || 0;
    const tecido  = (saved.tecido || def.tecido || 'Não especificado').trim();
    const cores   = [...new Set([...def.cores, ...(saved.cores || [])])];
    const chave = normalizarTecido(tecido);
    if (!grupos[chave])      grupos[chave]      = {};
    if (!gruposLabel[chave]) gruposLabel[chave] = labelTecido(tecido);
    const tuG = !!def.tamanhoUnico;
    cores.forEach(cor => {
      const pv = saved.prod && saved.prod[cor];
      let pecas = 0;
      if (pv) {
        pecas = pv.reduce((a,b) => a+b, 0);
      } else {
        const ab = def.aberto[cor] || [0,0,0,0,0];
        const ev = saved.est && saved.est[cor] || [0,0,0,0,0];
        if (tuG) {
          pecas = Math.max(0, ab.reduce((a,b) => a+b, 0) - (ev[0]||0));
        } else {
          pecas = calcFalta(ab, ev, tuG);
        }
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

  // Mesma lógica do card "EM PRODUÇÃO" do dashboard
  const prodList = [];
  for (const [key, def] of Object.entries(MODELOS)) {
    if (CONJUNTO_PECAS[key]) continue;
    const saved = loadLocal('vc:' + key) || {};
    if (!['Comprando tecido', 'Em corte', 'Em costura'].includes(saved.status)) continue;
    const cores = [...new Set([...def.cores, ...(saved.cores || [])])];
    let total = 0;
    cores.forEach(cor => {
      const pv = saved.prod && saved.prod[cor];
      if (pv) total += pv.reduce((a,b) => (a||0)+(b||0), 0);
    });
    if (total > 0) prodList.push({ nome: def.nome, status: saved.status, total });
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

  // Coleta modelos com status "Comprando tecido"
  const lista = [];
  for (const [key, def] of Object.entries(MODELOS)) {
    if (CONJUNTO_PECAS[key]) continue;
    const saved = loadLocal('vc:' + key) || {};
    if (saved.status !== 'Comprando tecido') continue;
    const tu    = !!def.tamanhoUnico;
    const cores = [...new Set([...def.cores, ...(saved.cores || [])])];
    const linhas = [];
    let totalModelo = 0;
    cores.forEach(cor => {
      const pv = saved.prod && saved.prod[cor];
      let vals;
      if (pv) {
        vals = [...pv];
      } else {
        const ab = def.aberto[cor] || [0,0,0,0,0];
        const ev = saved.est && saved.est[cor] || [0,0,0,0,0];
        if (tu) {
          // tamanhoUnico: 1 valor total
          vals = [calcFalta(ab, ev, true), 0, 0, 0, 0];
        } else {
          vals = ab.map((a,i) => Math.max(0, a - (ev[i]||0)));
        }
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

  // Coleta dados de produção (mesma lógica de atualizarTecido)
  const dados = [];
  document.querySelectorAll('#prod-tbody tr').forEach(row => {
    const cor   = row.dataset.cor;
    const vals  = Array.from(row.querySelectorAll('input')).map(i => parseInt(i.value) || 0);
    const pecas = vals.reduce((a, b) => a + b, 0);
    if (pecas > 0) {
      const metros = pecas * consumo;
      const custo  = metros * preco;
      dados.push({ cor, pecas, metros, custo });
    }
  });

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
  try {
    const res = await fetch('/api/shopify-orders');
    if (!res.ok) return;
    const resp = await res.json();
    const data = resp.pedidos || resp; // API retorna { pedidos:{...}, ignorados:[...] }
    // Guarda ignorados para diagnóstico
    window._shopifyIgnorados = resp.ignorados || [];
    window._shopifyTotalPedidos = resp.total_pedidos || 0;
    // Guarda detalhe por pedido (número, cliente, data, itens) p/ card "Prontos para envio"
    window._shopifyDetalhados = resp.detalhados || [];

    // Zera aberto de todos os modelos antes de preencher
    for (const key of Object.keys(MODELOS)) {
      for (const cor of Object.keys(MODELOS[key].aberto)) {
        MODELOS[key].aberto[cor] = Array(MODELOS[key].tamanhos?.length || 5).fill(0);
      }
    }

    for (const [modelKey, coresDados] of Object.entries(data)) {
      if (!MODELOS[modelKey]) continue;
      const sz = MODELOS[modelKey].tamanhos?.length || 5;
      for (const [cor, qtds] of Object.entries(coresDados)) {
        // Garante array denso (sem undefined) no tamanho correto do modelo
        MODELOS[modelKey].aberto[cor] = Array(sz).fill(0).map((_, i) => qtds[i] || 0);
      }
    }

    // Distribui pedidos de conjuntos para as peças individuais (usa constante global CONJUNTO_PECAS)
    // Aliases de cor: alguns conjuntos usam nome diferente do modelo de peça individual
    const COR_ALIASES_DIST = { 'Branca': 'Off White', 'Branco': 'Off White' };

    for (const [conjuntoKey, pecas] of Object.entries(CONJUNTO_PECAS)) {
      if (!MODELOS[conjuntoKey]) continue;
      for (const [cor, qtds] of Object.entries(MODELOS[conjuntoKey].aberto)) {
        const total = qtds.reduce((a, b) => (a || 0) + (b || 0), 0);
        if (total === 0) continue;
        for (const peca of pecas) {
          const pecaKey = typeof peca === 'string' ? peca : peca.key;
          if (!MODELOS[pecaKey]) continue;
          // Para peças com cor fixa, usa a cor definida. Para peças dinâmicas, resolve alias se necessário
          let pecaCor;
          if (typeof peca === 'string') {
            const corAlias = COR_ALIASES_DIST[cor] || cor;
            // Prefere a cor aliasada se o modelo a tiver, senão usa a cor original
            pecaCor = MODELOS[pecaKey].aberto.hasOwnProperty(corAlias) ? corAlias : cor;
          } else {
            pecaCor = peca.cor;
          }
          const pecaSz = MODELOS[pecaKey].tamanhos?.length || 5;
          if (!MODELOS[pecaKey].aberto[pecaCor]) {
            MODELOS[pecaKey].aberto[pecaCor] = Array(pecaSz).fill(0);
          }
          // Usa || 0 para proteger contra undefined em arrays esparsos
          MODELOS[pecaKey].aberto[pecaCor] = MODELOS[pecaKey].aberto[pecaCor].map((v, i) => (v || 0) + (qtds[i] || 0));
        }
      }
    }

  } catch (_) {}
}

// ─── DETECÇÃO DE ENVIOS E BAIXA AUTOMÁTICA DE ESTOQUE ────────────────────────

let _enviosPendentes = []; // guarda envios detectados aguardando confirmação

// Mapa de conjuntos → peças individuais (usado em pedidos E baixa de estoque)
const CONJUNTO_PECAS = {
  'conjunto-calca-pantalona-moletom': ['calca-pantalona', 'moletom-gola-alta'],
  'conjunto-calca-pantalona-cropped': ['calca-pantalona', 'cropped-moletom'],
  'conjunto-cozy':                    ['calca-pantalona', 'moletom-ziper-bolsos'],
  'conjunto-mood':                    ['calca-basica-moletom', 'moletom-ziper-bolsos'],
  'conjunto-wide':                    ['calca-pantalona', 'moletom-gola-alta'],
  'conjunto-canelado':                ['blusa-canelada', 'calca-flare'],
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

function salvarSnapshotAberto() {
  const snapshot = {};
  for (const [key, def] of Object.entries(MODELOS)) {
    snapshot[key] = {};
    for (const [cor, qtds] of Object.entries(def.aberto)) {
      snapshot[key][cor] = [...qtds];
    }
  }
  saveLocal('vc:aberto-snapshot', snapshot);
}

async function verificarEnvios() {
  const snapshot = loadLocal('vc:aberto-snapshot');
  await carregarPedidosShopify();

  if (!snapshot) {
    // Primeira vez — salva o snapshot e não mostra nada
    salvarSnapshotAberto();
    return;
  }

  const envios = [];
  for (const [key, def] of Object.entries(MODELOS)) {
    // Conjuntos têm baixa distribuída nas peças individuais — ignora o modelo de conjunto
    if (CONJUNTO_PECAS[key]) continue;
    for (const [cor, newQtds] of Object.entries(def.aberto)) {
      const oldQtds = snapshot[key] && snapshot[key][cor] || [0, 0, 0, 0, 0];
      const delta = oldQtds.map((old, i) => Math.max(0, old - (newQtds[i] || 0)));
      const total = delta.reduce((a, b) => a + b, 0);
      if (total > 0) envios.push({ key, nome: def.nome, cor, delta, total });
    }
  }

  if (envios.length === 0) {
    // Nenhum envio detectado — só atualiza snapshot
    salvarSnapshotAberto();
    return;
  }

  // Mostra modal de confirmação
  _enviosPendentes = envios;
  const tbody = document.getElementById('modal-envios-tbody');
  tbody.innerHTML = envios.map(e => `
    <tr style="border-top:1px solid var(--border)">
      <td style="padding:7px 4px;font-weight:500">${e.nome}</td>
      <td style="padding:7px 4px">${e.cor}</td>
      ${e.delta.map(v => `<td style="text-align:center;padding:7px 4px;color:${v > 0 ? '#dc2626' : 'var(--text-ter)'}">${v > 0 ? '-' + v : '—'}</td>`).join('')}
      <td style="text-align:center;font-weight:700;color:#dc2626;padding:7px 4px">-${e.total}</td>
    </tr>`).join('');
  document.getElementById('modal-envios').style.display = 'flex';
}

function confirmarBaixaEstoque() {
  for (const e of _enviosPendentes) {
    const saved = loadLocal('vc:' + e.key);
    // Só aplica baixa se o modelo tiver estoque cadastrado para esta cor
    // (evita criar entrada zerada para modelos sem estoque definido)
    if (!saved || !saved.est || !saved.est[e.cor]) continue;
    saved.est[e.cor] = saved.est[e.cor].map((v, i) => Math.max(0, v - (e.delta[i] || 0)));
    saved.est_at = new Date().toISOString();
    saved.updated_at = new Date().toISOString();
    saveLocal('vc:' + e.key, saved);
    salvarNuvem(e.key, saved);
  }
  salvarSnapshotAberto();
  _enviosPendentes = [];
  document.getElementById('modal-envios').style.display = 'none';
  if (modeloAtual === '__dashboard__') renderDashboard();
  else renderModelo(modeloAtual);
}

function ignorarEnvios() {
  // Descarta sem atualizar estoque, mas salva novo snapshot
  salvarSnapshotAberto();
  _enviosPendentes = [];
  document.getElementById('modal-envios').style.display = 'none';
}

function agendarVerificacaoEnvios() {
  const agora = new Date();
  const proximas16 = new Date();
  proximas16.setHours(16, 0, 0, 0);
  if (agora >= proximas16) proximas16.setDate(proximas16.getDate() + 1);
  const msAte16 = proximas16 - agora;
  setTimeout(async () => {
    await verificarEnvios();
    // Reagenda para o próximo dia
    agendarVerificacaoEnvios();
  }, msAte16);
}

// ─────────────────────────────────────────────────────────────────────────────

// 1. Monta sidebar e restaura tela pelo hash da URL (ou abre dashboard)
const _hashKey = location.hash.replace('#', '');
const _ESPECIAIS = { precos: '__precos__', financeiro: '__financeiro__', trafego: '__trafego__', fluxo: '__fluxo__', atendimento: '__atendimento__' };
modeloAtual = _ESPECIAIS[_hashKey] || ((_hashKey && MODELOS[_hashKey]) ? _hashKey : '__dashboard__');
buildSidebar();

if (modeloAtual === '__precos__') {
  abrirPrecos(null); // restaura a aba Precificação após F5 (mantém o gate de senha)
} else if (modeloAtual === '__financeiro__') {
  abrirFinanceiro(null); // restaura a aba Financeiro após F5
} else if (modeloAtual === '__trafego__') {
  abrirTrafego(null); // restaura a aba Tráfego após F5
} else if (modeloAtual === '__fluxo__') {
  abrirFluxo(null); // restaura a aba Fluxo de Caixa após F5
} else if (modeloAtual === '__atendimento__') {
  abrirAtendimento(null); // restaura a aba Atendimento após F5
} else if (modeloAtual === '__dashboard__') {
  document.getElementById('tabs-modelo').style.display = 'none';
} else {
  document.getElementById('tabs-modelo').style.display = '';
  document.getElementById('topbar-actions').style.display = '';
  showTab('producao');
}

// 2. Sincroniza todos os modelos da nuvem → depois carrega Shopify e renderiza
const _renderInicial = () => {
  if (modeloAtual === '__dashboard__') renderDashboard();
  else if (modeloAtual === '__precos__') { if (sessionStorage.getItem('fin-ok') === '1') renderPrecos(); }
  else if (modeloAtual === '__financeiro__') { if (sessionStorage.getItem('fin-ok') === '1') renderFinanceiro(); }
  else if (modeloAtual === '__trafego__') { if (sessionStorage.getItem('fin-ok') === '1') trafCarregarFrame(); }
  else if (modeloAtual === '__fluxo__') { if (sessionStorage.getItem('fin-ok') === '1') renderFluxo(); }
  else if (modeloAtual === '__atendimento__') { if (sessionStorage.getItem('fin-ok') === '1') atdShowSub('sac'); }
  else renderModelo(modeloAtual);
};
carregarTodosNuvem().then(() => carregarPedidosShopify()).then(() => {
  // Na primeira carga do dia, salva snapshot se não existir
  if (!loadLocal('vc:aberto-snapshot')) salvarSnapshotAberto();
  _renderInicial();
  verificarAvisosStatus();
}).catch(() => {
  _renderInicial();
  verificarAvisosStatus();
});

// 3. Atualiza pedidos Shopify automaticamente a cada 1 minuto
setInterval(() => {
  carregarPedidosShopify().then(() => {
    if (modeloAtual === '__dashboard__') renderDashboard();
    else if (!estEditado && !prodEditado && MODELOS[modeloAtual]) renderModelo(modeloAtual); // só modelos reais; pula precos/financeiro
  }).catch(() => {});
}, 1 * 60 * 1000);

// 3b. Sincroniza estoque/produção entre dispositivos a cada 15 segundos (rede de segurança do realtime)
setInterval(() => { sincronizarNuvem(); }, 15 * 1000);

// 3c. Sincroniza IMEDIATAMENTE ao voltar para o app/aba (celular: ao desbloquear/voltar pra aba).
// Navegadores móveis pausam os timers em segundo plano, então isto garante dados frescos na volta.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sincronizarNuvem();
});
window.addEventListener('focus', () => sincronizarNuvem());
window.addEventListener('pageshow', () => sincronizarNuvem());

// 4. Agendamento da verificação de envios às 16h
agendarVerificacaoEnvios();

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
