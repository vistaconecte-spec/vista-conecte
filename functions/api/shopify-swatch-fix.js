/**
 * Cloudflare Pages Function: /api/shopify-swatch-fix
 * Preenche o `color_swatch_config` do tema (mapa nome PT-BR → hex) para os swatches
 * de cor renderizarem corretamente. Edita config/settings_data.json (current).
 *   ?theme=ID            → dry-run (mostra atual + o que ficaria)
 *   ?theme=ID&apply=1    → grava
 * Opcional ?cfg=... (URL-encoded, linhas "Nome:#hex") sobrescreve o padrão abaixo.
 */
const API_VERSION = '2024-04';

// Mapa padrão (aproximações — ajustáveis depois no customizador do tema)
const MAPA_PADRAO = [
  'Cinza:#9e9e9e',
  'Telha:#c1502e',
  'Militar:#4b5320',
  'Preto:#111111',
  'Nude:#e3c4a8',
  'Marsala:#7b3b3f',
  'Off White:#f3efe6',
  'Vermelho:#c0392b',
  'Marrom:#6b4a2b',
  'Azul:#2e5b8a',
].join('\n');

export async function onRequest(context) {
  const { request, env } = context;
  const store = env.SHOPIFY_STORE_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (!store || !token) return new Response(JSON.stringify({ erro: 'env não configurado' }), { status: 500, headers: H });
  const qs = new URL(request.url).searchParams;
  const theme = qs.get('theme');
  const apply = qs.get('apply') === '1';
  const novoCfg = qs.get('cfg') || MAPA_PADRAO;
  if (!theme) return new Response(JSON.stringify({ erro: 'informe ?theme=' }), { status: 400, headers: H });
  const sh = { 'X-Shopify-Access-Token': token };
  const base = `https://${store}/admin/api/${API_VERSION}/themes/${theme}/assets.json`;

  try {
    const get = await fetch(base + '?asset[key]=config/settings_data.json', { headers: sh });
    if (!get.ok) return new Response(JSON.stringify({ erro: `Shopify ${get.status}`, detalhe: (await get.text()).slice(0, 200) }), { status: 502, headers: H });
    const raw = (await get.json()).asset.value;
    const data = JSON.parse(raw);
    const antes = (data.current && data.current.color_swatch_config) || null;

    let resultado = 'dry-run (nada escrito)';
    if (apply) {
      if (!data.current || typeof data.current !== 'object') {
        return new Response(JSON.stringify({ erro: 'settings_data.json sem objeto current' }), { status: 500, headers: H });
      }
      data.current.color_swatch_config = novoCfg;
      const put = await fetch(base, {
        method: 'PUT', headers: { ...sh, 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset: { key: 'config/settings_data.json', value: JSON.stringify(data) } }),
      });
      resultado = put.ok ? 'aplicado' : `falha ${put.status}: ${(await put.text()).slice(0, 300)}`;
    }

    return new Response(JSON.stringify({
      theme, modo: apply ? 'APLICAR' : 'dry-run',
      color_swatch_config_antes: antes,
      color_swatch_config_novo: novoCfg.split('\n'),
      resultado,
    }, null, 2), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: H });
  }
}
