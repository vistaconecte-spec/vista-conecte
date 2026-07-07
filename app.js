let modeloAtual = 'macacao-amplo';
let saveTimer = null;

// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPABASE_URL  = 'https://hckzsblwyabmhzbjdjgx.supabase.co';
const SUPABASE_KEY  = 'sb_publishable_eZdTVMN40vPwZRcISKWYlA_wuK67fyr';
let   supabase      = null;

function initSupabase() {
  try {
    if (window.supabase && SUPABASE_KEY !== '__SUPABASE_ANON_KEY__') {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      iniciarRealtime();
    }
  } catch(e) { console.warn('Supabase não disponível:', e.message); }
}

async function salvarNuvem(key, dados) {
  if (!supabase) return;
  try {
    await supabase.from('vc_modelos').upsert({ id: key, dados }, { onConflict: 'id' });
  } catch(e) { console.warn('Erro ao salvar na nuvem:', e.message); }
}

async function carregarNuvem(key) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.from('vc_modelos').select('dados').eq('id', key).single();
    if (error || !data) return null;
    return data.dados;
  } catch(e) { return null; }
}

function iniciarRealtime() {
  if (!supabase) return;
  supabase
    .channel('vc_modelos_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'vc_modelos' }, payload => {
      // Só re-renderiza se for o modelo que está aberto e a mudança veio de outro dispositivo
      if (payload.new && payload.new.id === modeloAtual) {
        const dados = payload.new.dados;
        saveLocal('vc:' + modeloAtual, dados);
        renderModelo(modeloAtual);
        showSaved();
      }
    })
    .subscribe();
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
  i.classList.add('show');
  setTimeout(() => i.classList.remove('show'), 2000);
}

function autoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(salvarModelo, 800);
}

function salvarModelo() {
  const est = {}, prod = {};
  document.querySelectorAll('#est-tbody tr').forEach(r => {
    est[r.dataset.cor] = Array.from(r.querySelectorAll('input')).map(i => parseInt(i.value) || 0);
  });
  document.querySelectorAll('#prod-tbody tr').forEach(r => {
    prod[r.dataset.cor] = Array.from(r.querySelectorAll('input')).map(i => parseInt(i.value) || 0);
  });
  const data = {
    est, prod,
    preco: parseFloat(document.getElementById('preco-m').value) || 0,
    status: document.getElementById('prod-status').value,
    prazo: document.getElementById('prod-prazo').value,
    nome: document.getElementById('cfg-nome').value,
    tecido: document.getElementById('cfg-tecido').value,
    consumo: parseFloat(document.getElementById('cfg-consumo').value) || 0,
    componentes: document.getElementById('cfg-componentes').value,
    obs: document.getElementById('cfg-obs').value,
    cores: getCoresTags(),
  };
  saveLocal('vc:' + modeloAtual, data);
  salvarNuvem(modeloAtual, data);
  showSaved();
}

function getCoresTags() {
  return Array.from(document.querySelectorAll('#cores-tags .cor-tag span')).map(s => s.textContent);
}

function buildSidebar() {
  const nav = document.getElementById('sidebar-nav');
  nav.innerHTML = '';
  SIDEBAR_ESTRUTURA.forEach(grupo => {
    const title = document.createElement('div');
    title.className = 'sidebar-title';
    title.textContent = grupo.titulo;
    nav.appendChild(title);
    grupo.modelos.forEach(key => {
      const def = MODELOS[key];
      if (!def) return;
      const item = document.createElement('div');
      item.className = 'nav-item' + (key === modeloAtual ? ' active' : '');
      item.textContent = def.nome;
      item.onclick = () => selectModel(item, key);
      nav.appendChild(item);
    });
  });
}

function selectModel(el, key) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  el.classList.add('active');
  modeloAtual = key;
  renderModeloNuvem(key);
  showTab('producao');
}

async function renderModeloNuvem(key) {
  const dadosNuvem = await carregarNuvem(key);
  if (dadosNuvem) saveLocal('vc:' + key, dadosNuvem);
  renderModelo(key);
}

function renderModelo(key) {
  const def = MODELOS[key];
  const saved = loadLocal('vc:' + key);
  const d = saved || {};
  const nome = d.nome || def.nome;
  const tecido = d.tecido || def.tecido;
  const consumo = d.consumo || def.consumo;
  const preco = d.preco || def.preco;
  const cores = d.cores || def.cores;

  document.getElementById('model-title').textContent = nome;
  document.getElementById('model-sub').textContent = `TECIDO: ${tecido.toUpperCase()} • CONSUMO: ${consumo}M/PEÇA`;
  document.getElementById('preco-m').value = preco.toFixed(2);
  document.getElementById('prod-status').value = d.status || 'Aguardando corte';
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

  const abTots = [0, 0, 0, 0, 0];
  cores.forEach(cor => {
    const ab = def.aberto[cor] || [0, 0, 0, 0, 0];
    const ev = d.est && d.est[cor] || [0, 0, 0, 0, 0];
    const mins = ab.map((a, i) => Math.max(0, a - ev[i]));
    const pv = d.prod && d.prod[cor] || mins;
    const abTot = ab.reduce((a, b) => a + b, 0);
    ab.forEach((v, i) => abTots[i] += v);

    abt.innerHTML += `<tr><td>${cor}</td>${ab.map(v => `<td class="${v > 0 ? 'val-areia' : ''}">${v || '—'}</td>`).join('')}<td class="${abTot > 0 ? 'val-areia' : ''}">${abTot || '0'}</td></tr>`;

    const etot = ev.reduce((a, b) => a + b, 0);
    est.innerHTML += `<tr data-cor="${cor}"><td>${cor}</td>${ev.map(v => `<td><input class="ci" type="number" min="0" value="${v}" oninput="recalc();autoSave()"></td>`).join('')}<td class="re ${etot > 0 ? 'val-grafite' : ''}">${etot}</td></tr>`;

    const ptot = pv.reduce((a, b) => a + b, 0);
    prod.innerHTML += `<tr data-cor="${cor}" data-min="${mins.join(',')}"><td>${cor}</td>${pv.map((v, i) => `<td><input class="ci ${v > mins[i] ? 'acima' : ''}" type="number" min="0" value="${v}" oninput="calcProd(this);autoSave()"></td>`).join('')}<td class="rp ${ptot > 0 ? 'val-escuro' : ''}">${ptot}</td></tr>`;
  });

  const abTotal = abTots.reduce((a, b) => a + b, 0);
  ['PP', 'P', 'M', 'G', 'GG'].forEach((s, i) => { const el = document.getElementById('ab-' + s); if (el) el.textContent = abTots[i]; });
  const at = document.getElementById('ab-tot'); if (at) { at.textContent = abTotal; at.className = abTotal > 0 ? 'val-areia' : ''; }
  document.getElementById('m-aberto').textContent = abTotal;

  recalc();
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

function recalc() {
  const tots = [0, 0, 0, 0, 0];
  document.querySelectorAll('#est-tbody tr').forEach(row => {
    const vals = Array.from(row.querySelectorAll('input')).map(i => parseInt(i.value) || 0);
    const sum = vals.reduce((a, b) => a + b, 0);
    const t = row.querySelector('.re');
    if (t) { t.textContent = sum; t.className = 're ' + (sum > 0 ? 'val-grafite' : ''); }
    vals.forEach((v, i) => tots[i] += v);
  });
  ['PP', 'P', 'M', 'G', 'GG'].forEach((s, i) => { const el = document.getElementById('e-' + s); if (el) el.textContent = tots[i]; });
  const es = tots.reduce((a, b) => a + b, 0);
  const et = document.getElementById('e-tot'); if (et) { et.textContent = es; et.className = es > 0 ? 'val-grafite' : ''; }
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

  const colorRowsHtml = prodRows.map((r, idx) => `
    <tr>
      <td style="text-align:left;font-weight:600;padding:7px 12px;border:1px solid #ddd;background:${idx % 2 === 1 ? '#faf8f5' : '#fff'};">${r.cor}</td>
      ${r.vals.map(v => `<td style="text-align:center;padding:7px 8px;border:1px solid #ddd;background:${idx % 2 === 1 ? '#faf8f5' : '#fff'};color:${v ? '#111' : '#ccc'};">${v || '—'}</td>`).join('')}
      <td style="text-align:center;padding:7px 8px;border:1px solid #ddd;background:${idx % 2 === 1 ? '#faf8f5' : '#fff'};font-weight:700;">${r.tot || '—'}</td>
    </tr>`).join('');

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
          <th>PP</th><th>P</th><th>M</th><th>G</th><th>GG</th>
          <th style="background:#C4A882;">Total</th>
        </tr>
      </thead>
      <tbody>
        <tr><td colspan="7" class="section-hd">Total de peças a produzir</td></tr>
        ${colorRowsHtml || `<tr><td colspan="7" style="text-align:center;color:#bbb;padding:12px;">Nenhuma peça em produção</td></tr>`}
      </tbody>
      <tfoot>
        <tr class="total-row">
          <td>TOTAL GERAL</td>
          ${prodTots.map(v => `<td>${v}</td>`).join('')}
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

async function carregarPedidosShopify() {
  try {
    const res = await fetch('/api/shopify-orders');
    if (!res.ok) return;
    const data = await res.json();
    for (const [modelKey, coresDados] of Object.entries(data)) {
      if (!MODELOS[modelKey]) continue;
      for (const [cor, qtds] of Object.entries(coresDados)) {
        if (MODELOS[modelKey].aberto[cor] !== undefined) {
          MODELOS[modelKey].aberto[cor] = qtds;
        }
      }
    }
  } catch (_) {}
}

// Inicializa Supabase (chamado aqui para evitar problemas de cache)
initSupabase();

// Renderiza imediatamente com dados locais/Supabase
buildSidebar();
renderModeloNuvem(modeloAtual);

// Carrega pedidos Shopify em segundo plano e atualiza
carregarPedidosShopify().then(() => {
  renderModelo(modeloAtual);
}).catch(() => {});
