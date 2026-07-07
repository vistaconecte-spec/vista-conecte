/**
 * Cloudflare Pages Function: /api/shopify-home-casacos
 * Transforma a seção Casacos da home (featured_collections_RjCbtD) em CARROSSEL com setas,
 * injeta um banner GRANDE no centro (estilo Maniah) com produtos nas laterais.
 *   ?theme=ID&apply=1            → aplica
 *   ?theme=ID&remove=1&apply=1   → reverte
 */
const API_VERSION = '2024-04';
const CASACOS_SEC = 'featured_collections_RjCbtD';
const BANNER_KEY = 'casacos_banner';
const COLLECTION = 'casacos-2026';

const BANNER_LIQUID = `<style>
.casacos-banner{grid-column:span 2;aspect-ratio:2/3;align-self:center;overflow:hidden;border-radius:4px;display:block}
.casacos-banner img{width:100%;height:100%;object-fit:cover;display:block}
.product-list__inner:has(.casacos-banner){align-items:center}
.product-list__prev-next{display:flex !important;top:42% !important;z-index:3;pointer-events:none}
.product-list__arrow{pointer-events:auto;background:#fff !important;border-radius:50% !important;width:46px !important;height:46px !important;box-shadow:0 2px 12px rgba(0,0,0,.18)}
.product-list__arrow:not([disabled]){opacity:1 !important;visibility:visible !important;transform:scale(1) !important}
</style>
<script>
(function(){
  var my=document.currentScript?document.currentScript.closest('.shopify-section'):null;
  function run(){
    var sec=my?my.previousElementSibling:null;
    while(sec&&!(sec.querySelector&&sec.querySelector('.product-list__inner'))){sec=sec.previousElementSibling;}
    if(!sec){
      var secs=document.querySelectorAll('.shopify-section');
      for(var i=0;i<secs.length;i++){if(secs[i].querySelector('.product-list__inner')&&/casaco/i.test(secs[i].textContent||'')){sec=secs[i];break;}}
    }
    if(!sec){return;}
    var grid=sec.querySelector('.product-list__inner'); if(!grid){return;}
    if(grid.querySelector('.casacos-banner')){return;}
    var a=document.createElement('a'); a.className='casacos-banner'; a.href='/collections/${COLLECTION}'; a.setAttribute('aria-label','Casacos');
    a.innerHTML='<img src="{{ "banner-casacos.jpg" | asset_url }}" alt="Casacos">';
    var isMobile=(window.matchMedia&&window.matchMedia('(max-width:740px)').matches)||window.innerWidth<=740;
    var items=grid.children, idx=isMobile?0:Math.min(2, items.length);
    if(items[idx]){grid.insertBefore(a, items[idx]);}else{grid.appendChild(a);}
    setTimeout(function(){
      var scroller=sec.querySelector('.product-list__inner--scroller')||grid;
      try{ if(isMobile){scroller.scrollLeft=0;} else {scroller.scrollLeft=a.offsetLeft-(scroller.clientWidth-a.offsetWidth)/2;} }catch(e){}
    },150);
  }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',run);}else{run();}
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
    const cas = data.sections[CASACOS_SEC];
    if (!cas) return new Response(JSON.stringify({ erro: `seção ${CASACOS_SEC} não existe` }), { status: 400, headers: H });

    const setBlocoColecao = (handle) => { for (const bk of Object.keys(cas.blocks || {})) { if (cas.blocks[bk].type === 'collection') cas.blocks[bk].settings.collection = handle; } };

    if (remove) {
      cas.settings.stack_products = true;
      cas.settings.products_count = 48;
      cas.settings.title = 'Casacos';
      setBlocoColecao('casacos-2026');
      delete data.sections[BANNER_KEY];
      data.order = data.order.filter(x => x !== BANNER_KEY);
    } else {
      cas.settings.stack_products = false; // carrossel (setas)
      cas.settings.products_count = 12;
      cas.settings.title = ''; // o banner já tem "CASACOS"
      setBlocoColecao('casacos-2026'); // coleção curada da usuária
      data.sections[BANNER_KEY] = { type: 'custom-liquid', settings: { liquid: BANNER_LIQUID, add_vertical_spacing: false, subheading: '', title: '' } };
      data.order = data.order.filter(x => x !== BANNER_KEY);
      const i = data.order.indexOf(CASACOS_SEC);
      data.order.splice(i >= 0 ? i + 1 : data.order.length, 0, BANNER_KEY);
    }

    let resultado = 'dry-run';
    if (apply) {
      const put = await fetch(base, { method: 'PUT', headers: { ...sh, 'Content-Type': 'application/json' }, body: JSON.stringify({ asset: { key: 'templates/index.json', value: JSON.stringify(data) } }) });
      resultado = put.ok ? (remove ? 'removido' : 'aplicado') : `falha ${put.status}: ${(await put.text()).slice(0, 200)}`;
    }
    return new Response(JSON.stringify({ acao: remove ? 'remover' : 'adicionar', modo: apply ? 'APLICAR' : 'dry-run', resultado, ordem: data.order }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
