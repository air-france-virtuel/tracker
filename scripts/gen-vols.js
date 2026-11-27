// Génère le programme fixe des vols Les Ailes Tricolores (src/data/vols.json) et le SQL d'amorçage (supabase/vols-programme.sql).
// Horaires en UTC, tous les jours. A320 : France, Europe, Afrique du Nord (allers-retours) ; 777-300ER : long-courrier au départ de CDG.
const fs = require('fs'); const path = require('path');
const AP = {
  LFPG: ['Paris-Charles de Gaulle', 'Paris', 49.0097, 2.5479], LFPO: ['Paris-Orly', 'Paris', 48.7262, 2.3652],
  LFMN: ['Nice-Côte d’Azur', 'Nice', 43.6584, 7.2159], LFBO: ['Toulouse-Blagnac', 'Toulouse', 43.6293, 1.3638], LFML: ['Marseille-Provence', 'Marseille', 43.4393, 5.2214],
  LFBD: ['Bordeaux-Mérignac', 'Bordeaux', 44.8283, -0.7156], LFMT: ['Montpellier-Méditerranée', 'Montpellier', 43.5762, 3.963], LFBZ: ['Biarritz-Pays basque', 'Biarritz', 43.4684, -1.5233],
  LFKJ: ['Ajaccio-Napoléon Bonaparte', 'Ajaccio', 41.9236, 8.8029], LFKB: ['Bastia-Poretta', 'Bastia', 42.5527, 9.4837], LFBP: ['Pau-Pyrénées', 'Pau', 43.38, -0.4186],
  LFLL: ['Lyon-Saint Exupéry', 'Lyon', 45.7256, 5.0811], LFRS: ['Nantes Atlantique', 'Nantes', 47.1532, -1.6107], LFRB: ['Brest Bretagne', 'Brest', 48.4479, -4.4185], LFST: ['Strasbourg-Entzheim', 'Strasbourg', 48.5383, 7.6282],
  EGLL: ['Londres-Heathrow', 'Londres', 51.47, -0.4543], EHAM: ['Amsterdam-Schiphol', 'Amsterdam', 52.3105, 4.7683], EDDF: ['Francfort', 'Francfort', 50.0379, 8.5622], EDDM: ['Munich', 'Munich', 48.3538, 11.7861],
  LEMD: ['Madrid-Barajas', 'Madrid', 40.4983, -3.5676], LEBL: ['Barcelone-El Prat', 'Barcelone', 41.2974, 2.0833], LIRF: ['Rome-Fiumicino', 'Rome', 41.8003, 12.2389], LIMC: ['Milan-Malpensa', 'Milan', 45.6306, 8.7281],
  LSGG: ['Genève', 'Genève', 46.2381, 6.109], LSZH: ['Zurich', 'Zurich', 47.4582, 8.5555], EBBR: ['Bruxelles', 'Bruxelles', 50.901, 4.4844], LPPT: ['Lisbonne', 'Lisbonne', 38.7742, -9.1342],
  LOWW: ['Vienne', 'Vienne', 48.1103, 16.5697], EKCH: ['Copenhague', 'Copenhague', 55.618, 12.656], ENGM: ['Oslo-Gardermoen', 'Oslo', 60.1976, 11.1004], ESSA: ['Stockholm-Arlanda', 'Stockholm', 59.6519, 17.9186],
  EPWA: ['Varsovie-Chopin', 'Varsovie', 52.1657, 20.9671], LGAV: ['Athènes', 'Athènes', 37.9364, 23.9445], LEPA: ['Palma de Majorque', 'Palma', 39.5517, 2.7388], LMML: ['Malte', 'Malte', 35.8575, 14.4775],
  GMMN: ['Casablanca-Mohammed V', 'Casablanca', 33.3675, -7.5899], GMMX: ['Marrakech-Ménara', 'Marrakech', 31.6069, -8.0363], DTTA: ['Tunis-Carthage', 'Tunis', 36.851, 10.2272], DAAG: ['Alger', 'Alger', 36.691, 3.2154],
  KJFK: ['New York-JFK', 'New York', 40.6413, -73.7781], KLAX: ['Los Angeles', 'Los Angeles', 33.9416, -118.4085], KMIA: ['Miami', 'Miami', 25.7959, -80.287], CYUL: ['Montréal-Trudeau', 'Montréal', 45.4706, -73.7408],
  TFFR: ['Pointe-à-Pitre', 'Pointe-à-Pitre', 16.2653, -61.5318], TFFF: ['Fort-de-France', 'Fort-de-France', 14.591, -61.0032], FMEE: ['La Réunion-Roland Garros', 'Saint-Denis', -20.8871, 55.5103],
  RJTT: ['Tokyo-Haneda', 'Tokyo', 35.5494, 139.7798], FAOR: ['Johannesburg', 'Johannesburg', -26.1392, 28.246], SBGR: ['São Paulo-Guarulhos', 'São Paulo', -23.4356, -46.4731],
  OMDB: ['Dubaï', 'Dubaï', 25.2532, 55.3657], VTBS: ['Bangkok-Suvarnabhumi', 'Bangkok', 13.69, 100.7501], MMMX: ['Mexico', 'Mexico', 19.4361, -99.0719], KSFO: ['San Francisco', 'San Francisco', 37.6213, -122.379]
};
// [hub, destination, durée aller (min), durée retour (min), heures de départ du hub (UTC)]
const A320 = [
  ['LFPO', 'LFMN', 85, 90, ['05:40', '09:10', '13:20', '17:30']], ['LFPO', 'LFBO', 75, 80, ['05:50', '10:00', '15:10', '18:40']], ['LFPO', 'LFML', 80, 85, ['06:10', '11:30', '16:20']],
  ['LFPO', 'LFBD', 65, 70, ['06:00', '12:10', '17:00']], ['LFPO', 'LFMT', 75, 80, ['06:30', '14:10']], ['LFPO', 'LFBZ', 75, 80, ['07:00', '15:40']], ['LFPO', 'LFKJ', 95, 95, ['07:20', '14:30']],
  ['LFPO', 'LFKB', 95, 95, ['08:00', '15:00']], ['LFPO', 'LFBP', 75, 75, ['06:45', '16:30']], ['LFPO', 'LEPA', 120, 115, ['08:30']], ['LFPO', 'GMMX', 190, 185, ['09:30']], ['LFPO', 'DAAG', 140, 140, ['10:20']],
  ['LFPG', 'LFMN', 95, 95, ['06:20', '12:40', '18:10']], ['LFPG', 'LFLL', 65, 65, ['06:05', '10:40', '16:50']], ['LFPG', 'LFBO', 80, 80, ['07:10', '16:00']], ['LFPG', 'LFML', 85, 85, ['07:40', '17:20']],
  ['LFPG', 'LFRS', 65, 65, ['06:35', '15:30']], ['LFPG', 'LFRB', 75, 75, ['07:50']], ['LFPG', 'LFST', 70, 70, ['06:50', '15:20']],
  ['LFPG', 'EGLL', 75, 75, ['06:15', '09:50', '14:00', '18:20']], ['LFPG', 'EHAM', 75, 75, ['06:25', '11:10', '17:40']], ['LFPG', 'EDDF', 70, 70, ['06:40', '12:20', '17:50']], ['LFPG', 'EDDM', 90, 90, ['07:05', '15:50']],
  ['LFPG', 'LEMD', 125, 120, ['07:15', '13:30', '18:00']], ['LFPG', 'LEBL', 110, 110, ['06:55', '12:50', '17:10']], ['LFPG', 'LIRF', 125, 130, ['07:30', '15:40']], ['LFPG', 'LIMC', 90, 95, ['06:45', '16:10']],
  ['LFPG', 'LSGG', 65, 70, ['06:10', '11:40', '17:30']], ['LFPG', 'LSZH', 75, 75, ['07:25', '16:40']], ['LFPG', 'EBBR', 55, 55, ['06:30', '16:20']], ['LFPG', 'LPPT', 150, 140, ['08:10', '14:50']],
  ['LFPG', 'LOWW', 115, 120, ['07:35', '15:10']], ['LFPG', 'EKCH', 115, 120, ['08:20']], ['LFPG', 'ENGM', 135, 140, ['08:40']], ['LFPG', 'ESSA', 145, 150, ['09:00']], ['LFPG', 'EPWA', 140, 140, ['08:50']],
  ['LFPG', 'LGAV', 195, 205, ['09:20']], ['LFPG', 'LMML', 160, 170, ['09:40']], ['LFPG', 'GMMN', 185, 175, ['10:10']], ['LFPG', 'DTTA', 145, 150, ['10:50']]
];
// long-courrier : [destination, durée aller, durée retour, départ CDG, départ retour]
const B77W = [
  ['KJFK', 515, 445, '09:30', '22:40'], ['KLAX', 695, 665, '10:15', '19:30'], ['KMIA', 590, 540, '10:40', '21:20'], ['CYUL', 460, 415, '12:20', '21:50'],
  ['TFFR', 525, 495, '09:50', '20:10'], ['TFFF', 525, 500, '10:30', '20:50'], ['FMEE', 665, 690, '18:30', '19:40'], ['RJTT', 820, 870, '10:00', '02:30'],
  ['FAOR', 645, 660, '20:00', '19:20'], ['SBGR', 700, 670, '21:30', '23:15'], ['OMDB', 400, 440, '13:15', '03:10'], ['VTBS', 690, 750, '12:00', '00:40'],
  ['MMMX', 720, 650, '09:10', '18:20'], ['KSFO', 690, 650, '11:00', '19:40']
];
const add = (t, min) => { const [h, m] = t.split(':').map(Number); const x = (h * 60 + m + min) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
const flights = [];
let n1 = 1000, n2 = 2000;
for (const [hub, dest, out, back, deps] of A320) {
  const intl = !/^LF/.test(dest);
  for (const d of deps) {
    const num = intl ? (n2 += 2) : (n1 += 2);
    flights.push({ number: 'LAT' + num, from: hub, to: dest, dep: d, block: out, type: 'A320' });
    flights.push({ number: 'LAT' + (num + 1), from: dest, to: hub, dep: add(d, out + 50), block: back, type: 'A320' });
  }
}
let n3 = 10;
for (const [dest, out, back, dep, ret] of B77W) {
  n3 += 2;
  flights.push({ number: 'LAT' + String(n3).padStart(3, '0'), from: 'LFPG', to: dest, dep, block: out, type: 'B77W' });
  flights.push({ number: 'LAT' + String(n3 + 1).padStart(3, '0'), from: dest, to: 'LFPG', dep: ret, block: back, type: 'B77W' });
}
const airports = Object.fromEntries(Object.entries(AP).map(([k, [name, city, lat, lon]]) => [k, { name, city, lat, lon }]));
const root = path.join(__dirname, '..');
fs.writeFileSync(path.join(root, 'src/data/vols.json'), JSON.stringify({ version: 1, airports, flights }, null, 1) + '\n');
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const sql = '-- Programme fixe des vols Les Ailes Tricolores (généré par scripts/gen-vols.js)\n' +
  'insert into public.company_flights (number, dep_airport, arr_airport, dep_utc, block_min, aircraft_type) values\n' +
  flights.map((f) => '(' + [q(f.number), q(f.from), q(f.to), q(f.dep), f.block, q(f.type)].join(', ') + ')').join(',\n') +
  '\non conflict (number) do nothing;\n';
fs.writeFileSync(path.join(root, 'supabase/vols-programme.sql'), sql);
console.log(flights.length + ' vols, ' + Object.keys(airports).length + ' aéroports');
