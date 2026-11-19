// Construit le Setup.exe avec NSIS (sans Wine) puis les fichiers de mise à jour (latest.yml / beta.yml).
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const v = pkg.version;
const v4 = v.split('-')[0] + '.0';
function findMakensis() {
  if (process.env.MAKENSIS) return { bin: process.env.MAKENSIS, dir: null };
  if (process.platform === 'win32') {
    for (const d of ['C:\\Program Files (x86)\\NSIS', 'C:\\Program Files\\NSIS']) if (fs.existsSync(path.join(d, 'makensis.exe'))) return { bin: path.join(d, 'makensis.exe'), dir: null };
  }
  const base = path.join(process.env.HOME || '', '.cache/electron-builder/nsis-3.0.4.1');
  const d = fs.readdirSync(base).map((x) => path.join(base, x)).find((x) => fs.existsSync(path.join(x, 'linux/makensis')));
  return { bin: path.join(d, 'linux/makensis'), dir: d };
}
const nsis = findMakensis();
const out = path.join(root, 'dist');
const name = 'AirFranceVirtuel-Tracker-Setup-' + v + '.exe';
execFileSync(nsis.bin, [
  '-V2', '-INPUTCHARSET', 'UTF8',
  '-DVERSION=' + v, '-DVERSION4=' + v4, '-DOUTFILE=' + path.join(out, name),
  '-DSRC=' + path.join(out, 'win-unpacked'), '-DRES=' + __dirname,
  path.join(__dirname, 'installer.nsi')
], { stdio: 'inherit', env: nsis.dir ? Object.assign({}, process.env, { NSISDIR: nsis.dir }) : process.env });
const buf = fs.readFileSync(path.join(out, name));
const sha512 = crypto.createHash('sha512').update(buf).digest('base64');
const yml = 'version: ' + v + '\nfiles:\n  - url: ' + name + '\n    sha512: ' + sha512 + '\n    size: ' + buf.length + '\npath: ' + name + '\nsha512: ' + sha512 + "\nreleaseDate: '" + new Date().toISOString() + "'\n";
fs.writeFileSync(path.join(out, 'latest.yml'), yml);
fs.writeFileSync(path.join(out, 'beta.yml'), yml);
console.log('OK :', name, (buf.length / 1048576).toFixed(1) + ' Mo');
