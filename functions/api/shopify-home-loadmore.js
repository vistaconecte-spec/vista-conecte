/**
 * Cloudflare Pages Function: /api/shopify-home-loadmore
 * Injeta uma seção "custom-liquid" na home que limita a coleção Combo de Inverno a 8 itens
 * + botão "Carregar mais" (revela de 8 em 8, inline, sem AJAX). Mira só a seção da Combo.
 *   ?theme=ID            → dry-run
 *   ?theme=ID&apply=1    → grava em templates/index.json
 *   ?theme=ID&remove=1&apply=1 → remove (rollback)
 */
const API_VERSION = '2024-04';
const SECTION_KEY = 'lm_combo';
const TARGET_SECTION = 'featured_collections_cMafFV'; // seção da Combo de Inverno na home
const ANCHOR = 'featured_collections_cMafFV';
const COLLECTION_HANDLE = 'como-inverno-2026';

const LIQUID = `<style>.lm-more{display:flex;justify-content:center;margin-top:28px;width:100%}
.section__header--tight h2:not(.heading){font-size:24px !important;line-height:1.3 !important}.section__header--tight h4{font-size:14px !important}
@media(max-width:740px){.section__header--tight h2:not(.heading){font-size:18px !important;line-height:1.25 !important}.section__header--tight h4{font-size:12px !important}}</style>
<script>
(function(){
  var cs=document.currentScript;
  function findSec(){
    if(cs){var my=cs.closest('.shopify-section'); if(my){var p=my.previousElementSibling; while(p){ if(p.classList&&p.classList.contains('shopify-section')&&p.querySelector('.product-list__inner')){return p;} p=p.previousElementSibling; }}}
    var secs=document.querySelectorAll('.shopify-section');
    for(var i=0;i<secs.length;i++){ if(secs[i].querySelector('.product-list__inner')&&/combo de inverno/i.test(secs[i].textContent||'')){return secs[i];} }
    return null;
  }
  function run(){
    var sec=findSec(); if(!sec){return;}
    var grid=sec.querySelector('.product-list__inner'); if(!grid){return;}
    if(grid.getAttribute('data-lm')){return;}
    var items=grid.children, total=items.length, INITIAL=8, STEP=8;
    if(total<=INITIAL){return;}
    grid.setAttribute('data-lm','1');
    var shown=INITIAL;
    function apply(){ for(var i=0;i<total;i++){ items[i].style.display=(i<shown)?'':'none'; } }
    apply();
    var wrap=document.createElement('div'); wrap.className='lm-more';
    var btn=document.createElement('button'); btn.type='button'; btn.className='button button--primary'; btn.textContent='Carregar mais';
    wrap.appendChild(btn);
    var pl=sec.querySelector('product-list')||grid;
    pl.parentNode.insertBefore(wrap, pl.nextSibling);
    btn.addEventListener('click',function(){ shown+=STEP; apply(); if(shown>=total){ wrap.style.display='none'; } });
  }
  run();
  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', run); }
})();
</script>`;

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });
  const qs = new URL(request.url).searchParams;
  const theme = qs.get('theme'), apply = qs.get('apply') === '1', remove = qs.get('remove') === '1';
  if (!theme) return new Response(JSON.stringify({ erro: 'informe ?theme=' }), { status: 400, headers: H });
  const sh = { 'X-Shopify-Access-Token': token };
  const base = `https://${store}/admin/api/${API_VERSION}/themes/${theme}/assets.json`;

  try {
    const get = await fetch(base + '?asset[key]=templates/index.json', { headers: sh });
    if (!get.ok) return new Response(JSON.stringify({ erro: `Shopify ${get.status}` }), { status: 502, headers: H });
    const data = JSON.parse((await get.json()).asset.value);
    const jaExiste = !!(data.sections && data.sections[SECTION_KEY]);

    if (remove) {
      if (data.sections) delete data.sections[SECTION_KEY];
      data.order = (data.order || []).filter(x => x !== SECTION_KEY);
    } else {
      data.sections[SECTION_KEY] = { type: 'custom-liquid', settings: { liquid: LIQUID, add_vertical_spacing: false } };
      if (!data.order.includes(SECTION_KEY)) {
        const i = data.order.indexOf(ANCHOR);
        if (i >= 0) data.order.splice(i + 1, 0, SECTION_KEY);
        else data.order.push(SECTION_KEY);
      }
      // opcional: ajustar produtos por linha da seção da Combo
      const ppr = qs.get('ppr');
      if (ppr && data.sections[TARGET_SECTION]) {
        data.sections[TARGET_SECTION].settings.products_per_row = parseInt(ppr, 10);
      }
    }

    let resultado = 'dry-run (nada escrito)';
    if (apply) {
      const put = await fetch(base, {
        method: 'PUT', headers: { ...sh, 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset: { key: 'templates/index.json', value: JSON.stringify(data) } }),
      });
      resultado = put.ok ? (remove ? 'removido' : 'aplicado') : `falha ${put.status}: ${(await put.text()).slice(0, 200)}`;
    }
    return new Response(JSON.stringify({
      acao: remove ? 'remover' : 'adicionar', ja_existia: jaExiste,
      target_section: TARGET_SECTION, collection: COLLECTION_HANDLE,
      nova_ordem: data.order, modo: apply ? 'APLICAR' : 'dry-run', resultado,
    }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
