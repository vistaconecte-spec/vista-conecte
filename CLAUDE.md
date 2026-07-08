# Vista Conecte — sistema de gestão (Cloudflare Pages + Supabase + Shopify)

Dashboard de gestão da confecção: produção, estoque, Financeiro (DRE), Fluxo de Caixa,
Precificação. Produção: https://vistaconecte.pages.dev — publicada automaticamente
pelo GitHub Actions a cada push na `main`.

## Fluxo de trabalho Git (OBRIGATÓRIO — vale para qualquer agente/pessoa)

1. **ANTES de editar qualquer arquivo:** `git pull --rebase origin main`
   (outra pessoa pode ter publicado — puxar primeiro evita conflito e retrabalho).
2. Fazer as mudanças e testar.
3. **AO CONCLUIR a mudança (sem pedir confirmação ao usuário):**
   ```
   git add <arquivos>
   git commit -m "descrição clara do que mudou"
   git push origin main
   ```
   O deploy é automático (GitHub Actions, ~30s). NÃO usar `wrangler pages deploy` manualmente.
4. **Se o push for rejeitado** (non-fast-forward): é normal — a outra pessoa publicou antes.
   `git pull --rebase origin main` e push de novo. Nunca usar `--force`.
5. **Nunca deixar trabalho commitado sem push** ao encerrar — trabalho não-pushado não
   existe para o resto do time e não vai ao ar.

O usuário (Álvaro/Bárbara) NÃO precisa autorizar commit/push de mudanças que ele pediu —
o pedido da mudança JÁ é a autorização de publicá-la. Só pergunte antes de: mudanças
destrutivas (apagar dados/arquivos), mudanças que ele não pediu, ou rotação de credenciais.

## Regras do projeto

- **Cache-bust:** toda mudança em `main.js`/`data.js` exige bump do `?v=` no `index.html`
  (formato `AAAAMMDDnn`). Sem isso, o navegador serve a versão velha.
- **SEGREDOS: NUNCA commitar** tokens/senhas. O `.gitignore` protege os padrões conhecidos
  (`*token*.json/.txt`, `02_CREDENCIAIS.md`, scripts OAuth `get-shopify-token*.js`,
  `troca-codigo.js`, `theme-api.js`). Antes de todo commit, confira o `git status` —
  se aparecer qualquer arquivo com credencial, PARE e ajuste o `.gitignore`.
- Secrets de runtime ficam no Cloudflare Pages (projeto `vistaconecte` → env vars):
  `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_STORE_DOMAIN`, `MP_ACCESS_TOKEN`, `PAGARME_SECRET_KEY` etc.
- **Dados** ficam no Supabase (tabela `vc_modelos`, id + JSON) — o deploy não toca em dados.
- Functions em `functions/api/*.js` (Cloudflare Pages Functions). Padrão Shopify do projeto:
  env `SHOPIFY_STORE_DOMAIN` + API `2024-04`.
- **Financeiro/Fluxo:** regra do negócio — só pedidos PAGOS contam (excluir cancelados e
  expirados). Mercado Pago via `release_report` (ver comentários em `functions/api/mp-*.js`).
- Testes locais NUNCA devem escrever no Supabase de produção (neutralizar `salvarNuvem`).
