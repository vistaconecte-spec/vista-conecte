// Roda no fim do `npm run deploy`.
//
// POR QUE EXISTE: quem manda na produção NÃO é só o wrangler daqui. O repositório tem um
// GitHub Actions (.github/workflows/deploy.yml) que publica o que está no GitHub sempre
// que alguém dá push ou dispara o workflow à mão. Em 18/08/2026 isso derrubou três
// publicações seguidas: o site voltava para o commit de 15/08 poucos minutos depois de
// cada deploy local, porque as mudanças estavam só no disco.
//
// Então: publicar sem commitar+empurrar é publicação com prazo de validade. Este script
// não impede o deploy (ele já aconteceu) — ele grita antes que alguém feche o terminal.
import { execSync } from 'node:child_process';

let sujo = '';
try { sujo = execSync('git status --porcelain', { encoding: 'utf8' }).trim(); } catch { process.exit(0); }
if (!sujo) {
  try {
    const frente = execSync('git log --oneline @{u}..HEAD', { encoding: 'utf8' }).trim();
    if (!frente) { console.log('\n✅ Publicado e igual ao GitHub — nada pode voltar atrás.\n'); process.exit(0); }
    console.log(`\n⚠️  COMMIT SEM PUSH — o GitHub ainda tem a versão velha:\n${frente}\n`
      + '   Rode:  git push origin main\n');
  } catch { /* sem upstream: o aviso de árvore suja abaixo já basta */ }
  process.exit(1);
}
console.log('\n⚠️  ATENÇÃO: o que acabou de ir ao ar NÃO está no GitHub.\n'
  + sujo.split('\n').map(l => '   ' + l).join('\n')
  + '\n\n   O Actions publica o que está no GitHub. No próximo push (ou disparo manual\n'
  + '   do workflow por outra pessoa) a produção volta para a versão de lá e isto some.\n'
  + '   Rode:  git add -A && git commit -m "..." && git push origin main\n');
process.exit(1);
