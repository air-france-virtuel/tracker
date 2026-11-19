// Écrit les nouveautés de la version (Ajouté / Retiré / Corrigé) pour la page GitHub.
const v = require('../package.json').version;
const c = require('../src/changelog.json').find((x) => x.version === v) || { added: [], removed: [], fixed: [] };
const part = (t, a) => (a && a.length ? '### ' + t + '\n' + a.map((x) => '- ' + x).join('\n') + '\n\n' : '');
process.stdout.write(part('Ajouté', c.added) + part('Retiré', c.removed) + part('Corrigé', c.fixed) +
  '### Installation\nTélécharge **AirFranceVirtuel-Tracker-Setup-' + v + '.exe** ci-dessous et lance-le.\n' +
  'Si Windows affiche « Windows a protégé votre ordinateur » : « Informations complémentaires » puis « Exécuter quand même ».\n');
