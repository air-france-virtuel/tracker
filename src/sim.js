'use strict';
// Connexion à Microsoft Flight Simulator (2020 / 2024) par SimConnect.
// Se reconnecte tout seul si le simulateur est fermé ou pas encore lancé.

const { EventEmitter } = require('events');
const { open, Protocol, SimConnectDataType, SimConnectPeriod, SimConnectConstants } = require('node-simconnect');

const DEF = 1;
const REQ = 1;

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
      const { recvOpen, handle } = await open('Les Ailes Francaises Tracker', Protocol.KittyHawk);
      this.handle = handle;
      this.setConnected(true, recvOpen.applicationName);
      VARS.forEach(([name, unit]) => handle.addToDataDefinition(DEF, name, unit, SimConnectDataType.FLOAT64));
      handle.addToDataDefinition(DEF, 'TITLE', null, SimConnectDataType.STRING256);
      // Toutes les 6 images du simulateur : assez fin pour mesurer le taux d'atterrissage.
      handle.requestDataOnSimObject(REQ, DEF, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SIM_FRAME, 0, 0, 5, 0);
      handle.on('simObjectData', (r) => {
        if (r.requestID !== REQ) return;
        const d = r.data;
        const v = VARS.map(() => d.readFloat64());
        const title = d.readString256();
        this.emit('data', {
          lat: v[0], lon: v[1], alt: v[2], agl: v[3], ias: v[4], gs: v[5], vs: v[6], hdg: v[7],
          onGround: v[8] > 0.5, fuelKg: v[9] * 0.4536, engOn: v[10] > 0.5 || v[11] > 0.5,
          parkBrake: v[12] > 0.5, gearDown: v[13] > 0.5, tdVel: v[14], simRate: v[15], windDir: v[16], windKt: v[17], title,
          time: Date.now() / 1000
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
