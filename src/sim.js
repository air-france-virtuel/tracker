'use strict';
// Connexion à Microsoft Flight Simulator (2020 / 2024) par SimConnect.
// Se reconnecte tout seul si le simulateur est fermé ou pas encore lancé.

const { EventEmitter } = require('events');
const { open, Protocol, SimConnectDataType, SimConnectPeriod, SimConnectConstants } = require('node-simconnect');

const DEF = 1;
const REQ = 1;
// Données des check-lists de Max (volets, feux, altimètre…) : demande à part, une fois par seconde,
// pour qu'un souci sur l'une d'elles ne gêne jamais le suivi du vol.
const DEF2 = 2;
const REQ2 = 2;
const XVARS = [
  ['FLAPS HANDLE INDEX', 'number'],
  ['LIGHT LANDING', 'bool'],
  ['LIGHT BEACON', 'bool'],
  ['LIGHT STROBE', 'bool'],
  ['KOHLSMAN SETTING MB', 'millibars'],
  ['SPOILERS HANDLE POSITION', 'percent'],
  ['AUTOPILOT MASTER', 'bool'],
  // altitude comme sur l'écran de vol : barométrique (calage de l'altimètre) et niveau de vol standard
  ['PLANE ALTITUDE', 'feet'],
  ['INDICATED ALTITUDE', 'feet'],
  ['PRESSURE ALTITUDE', 'feet']
];

const VARS = [
  ['PLANE LATITUDE', 'degrees'],
  ['PLANE LONGITUDE', 'degrees'],
  ['PLANE ALTITUDE', 'feet'],
  ['PLANE ALT ABOVE GROUND', 'feet'],
  ['AIRSPEED INDICATED', 'knots'],
  ['GROUND VELOCITY', 'knots'],
  ['VERTICAL SPEED', 'feet per minute'],
  ['PLANE HEADING DEGREES MAGNETIC', 'degrees'],
  ['SIM ON GROUND', 'bool'],
  ['FUEL TOTAL QUANTITY WEIGHT', 'pounds'],
  ['GENERAL ENG COMBUSTION:1', 'bool'],
  ['GENERAL ENG COMBUSTION:2', 'bool'],
  ['BRAKE PARKING POSITION', 'bool'],
  ['GEAR HANDLE POSITION', 'bool'],
  ['PLANE TOUCHDOWN NORMAL VELOCITY', 'feet per second'],
  ['SIM RATE', 'number'],
  ['AMBIENT WIND DIRECTION', 'degrees'],
  ['AMBIENT WIND VELOCITY', 'knots']
];

class SimLink extends EventEmitter {
  constructor() {
    super();
    this.handle = null;
    this.connected = false;
    this.stopped = false;
    this.title = '';
    this.timer = null;
  }

  start() {
    this.stopped = false;
    this.tryConnect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.handle) { try { this.handle.close(); } catch (e) { /* déjà fermé */ } }
    this.handle = null;
    this.setConnected(false);
  }

  setConnected(v, name) {
    if (this.connected === v) return;
    this.connected = v;
    this.emit('status', { connected: v, simulator: name || '' });
  }

  retryLater() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tryConnect(), 5000);
  }

  async tryConnect() {
    if (this.stopped || this.handle) return;
    try {
      const { recvOpen, handle } = await open('Les Ailes Tricolores Tracker', Protocol.KittyHawk);
      this.handle = handle;
      this.setConnected(true, recvOpen.applicationName);
      VARS.forEach(([name, unit]) => handle.addToDataDefinition(DEF, name, unit, SimConnectDataType.FLOAT64));
      handle.addToDataDefinition(DEF, 'TITLE', null, SimConnectDataType.STRING256);
      // Toutes les 6 images du simulateur : assez fin pour mesurer le taux d'atterrissage.
      handle.requestDataOnSimObject(REQ, DEF, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SIM_FRAME, 0, 0, 5, 0);
      try {
        XVARS.forEach(([name, unit]) => handle.addToDataDefinition(DEF2, name, unit, SimConnectDataType.FLOAT64));
        handle.requestDataOnSimObject(REQ2, DEF2, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SECOND, 0, 0, 0, 0);
      } catch (e) { /* les check-lists resteront à cocher à la main */ }
      handle.on('simObjectData', (r) => {
        if (r.requestID === REQ2) {
          try {
            const d = r.data; const v = XVARS.map(() => d.readFloat64());
            if (v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
              this.extra = { flapsIdx: Math.round(v[0]), landLt: v[1] > 0.5, beacon: v[2] > 0.5, strobe: v[3] > 0.5, baroMb: v[4], spoilers: v[5], ap: v[6] > 0.5 };
              // Écart entre l'altitude affichée par l'avion et l'altitude géométrique : au-dessus de 18 000 ft on montre
              // le niveau de vol (altitude pression, 1013), en dessous l'altitude indiquée (calage du pilote).
              const shown = v[9] >= 18000 ? v[9] : v[8];
              this.altCorr = Math.abs(shown - v[7]) < 5000 ? shown - v[7] : 0;
            }
          } catch (e) { /* paquet incomplet : on garde les valeurs précédentes */ }
          return;
        }
        if (r.requestID !== REQ) return;
        // Un paquet incomplet du simulateur (fréquent pendant le chargement d'un vol avec MSFS 2024)
        // ne doit jamais faire planter le tracker : on l'ignore et on attend le suivant.
        let v, title;
        try {
          const d = r.data;
          v = VARS.map(() => d.readFloat64());
          try { title = d.readString256(); this.title = title; } catch (e) { title = this.title; } // nom de l'avion tronqué : on garde le précédent
        } catch (e) { return; }
        if (v.some((x) => typeof x !== 'number' || Number.isNaN(x))) return;
        this.emit('data', {
          lat: v[0], lon: v[1], alt: v[2] + (this.altCorr || 0), altTrue: v[2], agl: v[3], ias: v[4], gs: v[5], vs: v[6], hdg: v[7],
          onGround: v[8] > 0.5, fuelKg: v[9] * 0.4536, engOn: v[10] > 0.5 || v[11] > 0.5,
          parkBrake: v[12] > 0.5, gearDown: v[13] > 0.5, tdVel: v[14], simRate: v[15], windDir: v[16], windKt: v[17], title,
          time: Date.now() / 1000, ...(this.extra || {})
        });
      });
      handle.on('exception', (e) => this.emit('log', 'SimConnect : exception ' + JSON.stringify(e)));
      const lost = () => {
        this.handle = null;
        this.setConnected(false);
        this.retryLater();
      };
      handle.on('quit', lost);
      handle.on('close', lost);
      handle.on('error', lost);
    } catch (err) {
      this.handle = null;
      this.setConnected(false);
      this.retryLater();
    }
  }
}

module.exports = { SimLink };
