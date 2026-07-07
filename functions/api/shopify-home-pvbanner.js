/**
 * Cloudflare Pages Function: /api/shopify-home-pvbanner
 * Adiciona na home, abaixo da Combo: uma fileira "Primavera/Verão" (featured-collections)
 * + um banner clicável (asset do tema) ocupando 2 colunas na 1ª posição (estilo eliefe).
 *   ?theme=ID&apply=1            → aplica
 *   ?theme=ID&remove=1&apply=1   → remove (rollback)
 */
const API_VERSION = '2024-04';
const ANCHOR = 'lm_combo'; // insere logo após o "carregar mais" da Combo
const ROW_KEY = 'pv_row';
const BANNER_KEY = 'pv_banner';
const COLLECTION = 'primavera-verao';

const ROW_SECTION = {
  type: 'featured-collections',
  blocks: { col: { type: 'collection', settings: { collection: COLLECTION, label: '', button_text: '', button_url: '' } } },
  block_order: ['col'],
  settings: {
    subheading: '', title: '', content: '',
    products_count: 4, mobile_products_per_row: '2', products_per_row: 4,
    stack_products: true, show_cta: false,
    background: 'rgba(0,0,0,0)', text_color: 'rgba(0,0,0,0)',
    button_background: 'rgba(0,0,0,0)', button_text_color: 'rgba(0,0,0,0)',
  },
};

const BANNER_LIQUID = `<style>
.pv-banner{grid-column:span 2;grid-row:span 2;align-self:stretch;overflow:hidden;border-radius:4px;display:block;background:#bb8f6c}
.pv-banner img{width:100%;height:100%;object-fit:cover;display:block}
.product-list__inner:has(.pv-banner){align-items:stretch}
@media(max-width:740px){.pv-banner{grid-row:auto !important;aspect-ratio:4/7 !important;align-self:start !important;background:none !important}}
</style>
<script>
(function(){
  var my=document.currentScript?document.currentScript.closest('.shopify-section'):null;
  function run(){
    var sec=my?my.previousElementSibling:null;
    while(sec&&!(sec.querySelector&&sec.querySelector('.product-list__inner'))){sec=sec.previousElementSibling;}
    if(!sec){
      var secs=document.querySelectorAll('.shopify-section');
      for(var i=0;i<secs.length;i++){if(secs[i].querySelector('.product-list__inner')&&/primavera/i.test(secs[i].textContent||'')){sec=secs[i];break;}}
    }
    if(!sec){return;}
    var grid=sec.querySelector('.product-list__inner'); if(!grid){return;}
    if(grid.querySelector('.pv-banner')){return;}
    var a=document.createElement('a'); a.className='pv-banner'; a.href='/collections/${COLLECTION}'; a.setAttribute('aria-label','Primavera Verao');
    a.innerHTML='<img src="{{ "banner-combo-pv.jpg" | asset_url }}" alt="Primavera Verao Combo">';
    grid.insertBefore(a, grid.firstChild);
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

    if (remove) {
      delete data.sections[ROW_KEY]; delete data.sections[BANNER_KEY];
      data.order = data.order.filter(x => x !== ROW_KEY && x !== BANNER_KEY);
    } else {
      data.sections[ROW_KEY] = ROW_SECTION;
      data.sections[BANNER_KEY] = { type: 'custom-liquid', settings: { liquid: BANNER_LIQUID, add_vertical_spacing: false, subheading: '', title: '' } };
      // zera o título padrão "YOUR TITLE" da seção do "Carregar mais" (custom-liquid)
      if (data.sections.lm_combo && data.sections.lm_combo.settings) {
        data.sections.lm_combo.settings.subheading = '';
        data.sections.lm_combo.settings.title = '';
      }
      data.order = data.order.filter(x => x !== ROW_KEY && x !== BANNER_KEY);
      const i = data.order.indexOf(ANCHOR);
      const at = i >= 0 ? i + 1 : data.order.length;
      data.order.splice(at, 0, ROW_KEY, BANNER_KEY);
    }

    let resultado = 'dry-run (nada escrito)';
    if (apply) {
      const put = await fetch(base, { method: 'PUT', headers: { ...sh, 'Content-Type': 'application/json' }, body: JSON.stringify({ asset: { key: 'templates/index.json', value: JSON.stringify(data) } }) });
      resultado = put.ok ? (remove ? 'removido' : 'aplicado') : `falha ${put.status}: ${(await put.text()).slice(0, 200)}`;
    }
    return new Response(JSON.stringify({ acao: remove ? 'remover' : 'adicionar', nova_ordem: data.order, modo: apply ? 'APLICAR' : 'dry-run', resultado }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
