// Met l'icône et les informations de version sur le .exe sans Wine (bibliothèque resedit).
const path = require('path');
const fs = require('fs');
exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  // Fichier lu par les mises à jour automatiques : electron-builder ne l'écrit pas pour une cible « dir ».
  const pub = (ctx.packager.config.publish || [])[0] || {};
  fs.writeFileSync(path.join(ctx.appOutDir, 'resources', 'app-update.yml'),
    'owner: ' + pub.owner + '\nrepo: ' + pub.repo + '\nprovider: github\nupdaterCacheDirName: air-france-virtuel-tracker-updater\n');
  console.log('  • app-update.yml écrit (mises à jour automatiques)');
  const ResEdit = await import('resedit');
  const pe = await import('pe-library');
  const { productFilename } = ctx.packager.appInfo;
  const exe = path.join(ctx.appOutDir, productFilename + '.exe');
  const version = ctx.packager.appInfo.version;
  const data = fs.readFileSync(exe);
  const exeFile = pe.NtExecutable.from(data, { ignoreCert: true });
  const res = pe.NtExecutableResource.from(exeFile);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map((i) => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  const num = version.split('-')[0].split('.').map(Number);
  vi.setFileVersion(num[0], num[1], num[2], 0, 1033);
  vi.setProductVersion(num[0], num[1], num[2], 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: 'Les Ailes Tricolores – Tracker', ProductName: 'Les Ailes Tricolores – Tracker',
    CompanyName: 'Les Ailes Tricolores', LegalCopyright: 'Les Ailes Tricolores – projet de loisir non officiel, sans lien avec Air France',
    OriginalFilename: productFilename + '.exe', InternalName: 'AirFranceVirtuelTracker', FileVersion: version, ProductVersion: version
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exeFile);
  fs.writeFileSync(exe, Buffer.from(exeFile.generate()));
  console.log('  • icône et version appliquées à', path.basename(exe));
};
