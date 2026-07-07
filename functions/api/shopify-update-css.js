/**
 * Cloudflare Pages Function: /api/shopify-update-css
 * GET  → dry-run: mostra tema ativo e arquivos CSS disponíveis
 * POST → aplica CSS customizado no menu de navegação
 */
const API_VERSION = '2024-04';
// build: 2026-06-24e — estrelas com caractere literal (corrige erro de build)

const MARKER_START = '/* === Estilo menu nav - atualizado via API === */';
const MARKER_END = '/* === fim estilo menu nav === */';

const CUSTOM_CSS = `
${MARKER_START}
/* Fonte global - Manrope em todo o site */
body, h1, h2, h3, h4, h5, h6, p, a, span, li, button, input, select, textarea, label {
  font-family: 'Manrope', sans-serif !important;
}

/* Featured collections hero - tamanhos harmonizados */
.section__header--tight .heading.h2,
.section__header--tight .heading {
  font-size: 32px !important;
  font-weight: 700 !important;
  line-height: 1.2 !important;
}

.section__header--tight .heading.heading--small {
  font-size: 16px !important;
  font-weight: 600 !important;
  letter-spacing: 0.12em !important;
}

.section__header--tight .text-container p {
  font-size: 18px !important;
  font-weight: 400 !important;
  color: #000000 !important;
}

/* Menu nav */
.header__linklist .header__linklist-link,
.header__linklist a.header__linklist-link {
  color: #000000 !important;
  text-transform: uppercase !important;
  letter-spacing: 0.69px !important;
  font-size: 14px !important;
  font-weight: 400 !important;
  text-decoration: none !important;
}

.header__linklist .header__linklist-link:hover,
.header__linklist .header__linklist-item--active .header__linklist-link {
  color: #000000 !important;
  font-weight: 700 !important;
}

/* Tarja de desconto (.label--highlight) — pílula no canto, vermelho escuro, menor e fonte mais leve */
.label--highlight {
  background-color: #d61f1f !important; /* vermelho vivo */
  color: #ffffff !important;
  border-radius: 999px !important;
  padding: 2px 8px !important;
  font-size: 11px !important;
  font-weight: 600 !important;
  letter-spacing: 0.01em !important;
  line-height: 1.2 !important;
  box-shadow: 0 1px 2px rgba(0,0,0,0.12) !important;
}

/* Move a tarja pro canto superior DIREITO */
.product-item__label-list {
  left: auto !important;
  right: 10px !important;
  top: 10px !important;
  text-align: right !important;
}

/* Parcelamento "ou 3x de R$ X sem juros" embaixo do preço */
.conecte-parcela { font-size: 12px; color: #666; margin-top: 3px; line-height: 1.25; }
.conecte-parcela b { color: #111; font-weight: 600; }
.conecte-parcela--center { text-align: center; }
.conecte-parcela--pdp { font-size: 13.5px; margin-top: 6px; }

/* Bloco de avaliações (curadas do Google) — rotativo, na home */
.conecte-reviews { max-width: 720px; margin: 54px auto; padding: 24px 18px; text-align: center; }
.conecte-reviews__titulo { font-size: 26px; font-weight: 700; color: #1a2b4a; margin-bottom: 16px; }
.conecte-reviews__stars { color: #e6a817; font-size: 16px; letter-spacing: 3px; margin-bottom: 14px; }
.conecte-reviews__quote { font-size: 20px; line-height: 1.5; font-weight: 600; color: #1f2937; min-height: 110px; }
.conecte-reviews__nome { margin-top: 14px; font-size: 13px; color: #8a8a8a; }
.conecte-reviews__dots { margin-top: 18px; line-height: 0; }
.conecte-reviews__dots i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #d8d8d8; margin: 0 4px; cursor: pointer; }
.conecte-reviews__dots i.on { background: #1a2b4a; }
@media (max-width: 600px) {
  .conecte-reviews { margin: 36px auto; }
  .conecte-reviews__titulo { font-size: 21px; }
  .conecte-reviews__quote { font-size: 17px; min-height: 130px; }
}

/* Carrossel (featured-collections): setas sempre visíveis pro cliente ver que dá pra passar */
.product-list__prev-next { opacity: 1 !important; visibility: visible !important; }
.product-list__arrow.prev-next-button {
  opacity: 1 !important;
  visibility: visible !important;
  background: #ffffff !important;
  border-radius: 50% !important;
  box-shadow: 0 1px 6px rgba(0,0,0,0.18) !important;
}
.product-list__arrow.prev-next-button[disabled] { opacity: 0.35 !important; }

/* Depoimentos: reduzir a fonte gigante e tirar o caixa-alta (legível) */
.testimonial__content, .testimonial__content split-lines {
  font-size: 19px !important;
  line-height: 1.55 !important;
  font-weight: 400 !important;
  text-transform: none !important;
  letter-spacing: 0 !important;
}
.testimonial__author { font-size: 13px !important; letter-spacing: 0.04em !important; }
/* Tira a aspa decorativa gigante */
.testimonial__content::before, .testimonial .blockquote::before,
.testimonial__quotation-mark, .testimonial svg.icon--quote { content: none !important; display: none !important; }
/* 5 estrelas douradas no topo de cada depoimento */
.testimonial::before {
  content: "★★★★★";
  display: block;
  text-align: center;
  color: #fbbc04;
  font-size: 17px;
  letter-spacing: 3px;
  margin: 0 auto 14px;
}
/* Logo do Google ao lado do nome (avaliação realista) */
.testimonial__author::before {
  content: "";
  display: inline-block;
  width: 16px; height: 16px;
  margin-right: 7px;
  vertical-align: -3px;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Cpath fill='%23FFC107' d='M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z'/%3E%3Cpath fill='%23FF3D00' d='M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z'/%3E%3Cpath fill='%234CAF50' d='M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z'/%3E%3Cpath fill='%231976D2' d='M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z'/%3E%3C/svg%3E") no-repeat center / contain;
}
.section:has(.testimonial-list) .section__header .heading {
  font-size: 26px !important;
  text-transform: none !important;
  letter-spacing: 0.02em !important;
}
@media (max-width: 600px) {
  .testimonial__content, .testimonial__content split-lines { font-size: 16px !important; }
  .section:has(.testimonial-list) .section__header .heading { font-size: 21px !important; }
}

/* Banner "Como funciona o Combo" injetado no topo da coleção — centralizado */
.conecte-combo-aviso {
  background: #fff6f6;
  border: 1px solid #f1c9c9;
  border-radius: 12px;
  padding: 12px 20px;
  margin: 0 auto 18px;
  max-width: 760px;
  text-align: center;
  font-size: 13.5px;
  line-height: 1.35;
  color: #2a2a2a;
}
.conecte-combo-aviso p { margin: 1px 0; }
.conecte-combo-aviso .cca-titulo { font-size: 15px; font-weight: 700; color: #111; margin-bottom: 2px; }
.conecte-combo-aviso .cca-como { margin-top: 7px; font-weight: 700; color: #111; }
.conecte-combo-aviso b { color: #b01616; }
${MARKER_END}
`;

export async function onRequest({ request, env }) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (request.method === 'OPTIONS') return new Response(null, { headers });

  const token = env.SHOPIFY_PRODUCTS_TOKEN || env.SHOPIFY_ADMIN_TOKEN;
  const shop = env.SHOPIFY_STORE_DOMAIN;
  if (!token || !shop) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers });

  const sh = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  try {
    // Busca tema ativo
    const themeRes = await fetch(`https://${shop}/admin/api/${API_VERSION}/themes.json`, { headers: sh });
    if (!themeRes.ok) return new Response(JSON.stringify({ erro: `Shopify themes ${themeRes.status}` }), { status: 502, headers });
    const { themes } = await themeRes.json();
    const activeTheme = themes.find(t => t.role === 'main');
    if (!activeTheme) return new Response(JSON.stringify({ erro: 'Nenhum tema ativo', themes }), { status: 404, headers });

    // Lista assets CSS
    const assetsRes = await fetch(`https://${shop}/admin/api/${API_VERSION}/themes/${activeTheme.id}/assets.json`, { headers: sh });
    if (!assetsRes.ok) return new Response(JSON.stringify({ erro: `Shopify assets ${assetsRes.status}` }), { status: 502, headers });
    const { assets } = await assetsRes.json();
    const cssAssets = assets.filter(a => a.key.endsWith('.css')).map(a => a.key);

    if (request.method === 'GET') {
      return new Response(JSON.stringify({
        tema_ativo: { id: activeTheme.id, name: activeTheme.name },
        arquivos_css: cssAssets,
        instrucao: 'Faça POST neste endpoint para aplicar o CSS no menu'
      }, null, 2), { headers });
    }

    // POST → injeta <style> inline no layout/theme.liquid (bypassa cache do CDN)
    const liquidKey = 'layout/theme.liquid';
    const assetRes = await fetch(
      `https://${shop}/admin/api/${API_VERSION}/themes/${activeTheme.id}/assets.json?asset[key]=${liquidKey}`,
      { headers: sh }
    );
    if (!assetRes.ok) return new Response(JSON.stringify({ erro: `Shopify liquid read ${assetRes.status}` }), { status: 502, headers });
    const assetData = await assetRes.json();
    let liquid = assetData.asset?.value || '';

    const HEAD_START = '<!-- custom-head-start -->';
    const HEAD_END = '<!-- custom-head-end -->';
    const styleBlock = `${HEAD_START}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;700&display=swap" rel="stylesheet">
<style id="custom-nav-css">
${CUSTOM_CSS}
</style>
<script id="custom-nav-js">
(function(){
  function fixNav(){
    document.querySelectorAll('.header__linklist-link').forEach(function(el){
      if (el.textContent.trim().toLowerCase().startsWith('combo de inverno')) {
        el.textContent = 'Combo de Inverno'; el.style.fontWeight = '700';
      }
    });
  }
  // Tarja: "Economize R$ 50,00" -> "- R$ 50" (tira "Economize" e o ,00)
  function fixBadge(el){
    var t = (el.textContent || '').trim();
    if (/economize/i.test(t)) el.textContent = t.replace(/economize\s*/i, '- ').replace(/,00(?!\d)/, '');
  }
  function fixBadges(root){ (root||document).querySelectorAll('.label--highlight').forEach(fixBadge); }
  // Banner "como funciona" no topo das coleções de combo
  var PASSOS = '<p class="cca-como">Como funciona:</p><p>1) Adicione suas peças ao carrinho ·</p><p>2) Quando aparecer o aviso do combo, toque em <b>“Eu quero!”</b> ·</p><p>3) O desconto entra na hora no carrinho</p>';
  var COMBO = {
    'como-inverno-2026': '<p class="cca-titulo">COMBO DE INVERNO</p><p>Escolha até <b>6 peças</b> desta coleção por <b>R$ 699</b>.</p><p>Atenção: cada conjunto conta como <b>2 peças</b> (parte de cima + calça), então <b>3 conjuntos já fecham o combo</b>.</p><p>Pode misturar conjuntos e peças avulsas, até somar 6.</p>' + PASSOS,
    'combo-2026-r-399-00': '<p class="cca-titulo">COMBO 3 PEÇAS</p><p>Escolha <b>3 peças</b> desta coleção por <b>R$ 399</b>.</p><p>Atenção: cada conjunto conta como <b>2 peças</b> (parte de cima + calça), então <b>1 conjunto + 1 peça avulsa</b> já fecham (ou 3 peças avulsas).</p>' + PASSOS
  };
  function addComboAviso(){
    var handle = Object.keys(COMBO).find(function(h){ return location.pathname.indexOf('/collections/' + h) !== -1; });
    if (!handle || document.querySelector('.conecte-combo-aviso')) return;
    var sec = document.querySelector('.shopify-section--main-collection') || document.querySelector('.product-list__inner') || document.querySelector('main');
    if (!sec) return;
    var box = document.createElement('div');
    box.className = 'conecte-combo-aviso';
    box.innerHTML = COMBO[handle];
    sec.insertBefore(box, sec.firstChild);
  }
  // Parcelamento: "ou 3x de R$ X sem juros" embaixo do preço (3x sem juros)
  var PARCELAS = 3;
  function addParcelamento(root){
    try {
      (root || document).querySelectorAll('.price-list').forEach(function(pl){
        try {
          if (pl.getAttribute('data-parcela')) return;
          if (pl.closest('.price-range') || pl.closest('.facets')) { pl.setAttribute('data-parcela','skip'); return; }
          // evita duplicar se já existe um aviso logo após
          if (pl.nextElementSibling && pl.nextElementSibling.classList && pl.nextElementSibling.classList.contains('conecte-parcela')) { pl.setAttribute('data-parcela','1'); return; }
          var precos = Array.prototype.slice.call(pl.querySelectorAll('.price'));
          var cur = pl.querySelector('.price--highlight') || precos.filter(function(p){ return !p.classList.contains('price--compare'); })[0];
          if (!cur) return;
          var raw = (cur.textContent || '').replace(/[^0-9.,]/g, '');
          if (!raw) return;
          var val = parseFloat(raw.replace(/\./g, '').replace(',', '.'));
          if (!val || val < 30) { pl.setAttribute('data-parcela','skip'); return; }
          var p = (val / PARCELAS).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          var ehPdp = !!pl.closest('.product-meta, .product-sticky-form, .product__info, .product');
          var el = document.createElement('div');
          el.className = 'conecte-parcela' + (pl.classList.contains('price-list--centered') ? ' conecte-parcela--center' : '') + (ehPdp ? ' conecte-parcela--pdp' : '');
          el.innerHTML = 'ou <b>' + PARCELAS + 'x de R$ ' + p + '</b> sem juros';
          pl.parentNode.insertBefore(el, pl.nextSibling);
          pl.setAttribute('data-parcela','1');
        } catch (e) {}
      });
    } catch (e) {}
  }
  function run(){ fixNav(); fixBadges(document); addComboAviso(); }
  if (document.readyState !== 'loading') run(); else document.addEventListener('DOMContentLoaded', run);
  // Pega cards carregados via filtro/paginação (Focal AJAX) e garante banner/parcelamento
  document.addEventListener('DOMContentLoaded', function(){
    new MutationObserver(function(muts){
      muts.forEach(function(m){
        (m.addedNodes || []).forEach(function(n){
          if (n.nodeType !== 1) return;
          if (n.classList && n.classList.contains('label--highlight')) fixBadge(n);
          else if (n.querySelectorAll) fixBadges(n);
        });
      });
      addComboAviso();
    }).observe(document.body, { childList: true, subtree: true });
  });
})();
</script>
${HEAD_END}`;

    // Remove bloco anterior INTEIRO (idempotente — não acumula link/script a cada POST)
    liquid = liquid.replace(new RegExp(HEAD_START + '[\\s\\S]*?' + HEAD_END, 'm'), '');
    // Compat: remove versões antigas sem marcador (só o <style> avulso)
    liquid = liquid.replace(/<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\s*/g, '');
    liquid = liquid.replace(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Manrope[^>]*>\s*/g, '');
    liquid = liquid.replace(/<style id="custom-nav-css">[\s\S]*?<\/style>\s*/m, '');
    liquid = liquid.replace(/<script id="custom-nav-js">[\s\S]*?<\/script>\s*/m, '');

    // Injeta antes de </head>
    if (!liquid.includes('</head>')) {
      return new Response(JSON.stringify({ erro: '</head> não encontrado no theme.liquid' }), { status: 500, headers });
    }
    liquid = liquid.replace('</head>', styleBlock + '\n</head>');

    const saveRes = await fetch(
      `https://${shop}/admin/api/${API_VERSION}/themes/${activeTheme.id}/assets.json`,
      { method: 'PUT', headers: sh, body: JSON.stringify({ asset: { key: liquidKey, value: liquid } }) }
    );
    const saveData = await saveRes.json();
    if (!saveRes.ok) return new Response(JSON.stringify({ erro: 'Falha ao salvar liquid', detalhes: saveData }), { status: saveRes.status, headers });

    return new Response(JSON.stringify({
      sucesso: true,
      tema: activeTheme.name,
      arquivo: liquidKey,
      msg: 'CSS injetado inline no theme.liquid — sem cache!'
    }, null, 2), { headers });

  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message, stack: e.stack }), { status: 500, headers });
  }
}
