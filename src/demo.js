'use strict';
// Vol de démonstration Paris CDG -> Nice, pour essayer le tracker sans simulateur.

const { distanceNm, bearingDeg, destinationPoint } = require('./geo');

const ORIGIN = { icao: 'LFPG', name: 'Paris Charles-de-Gaulle', lat: 49.0097, lon: 2.5479, elev: 392, rwy: '08L' };
const DEST = { icao: 'LFMN', name: 'Nice Côte d’Azur', lat: 43.6584, lon: 7.2159, elev: 12, rwy: '04R' };
const CRUISE = 35000;

function demoPlan() {
  const total = distanceNm(ORIGIN.lat, ORIGIN.lon, DEST.lat, DEST.lon);
  const brg = bearingDeg(ORIGIN.lat, ORIGIN.lon, DEST.lat, DEST.lon);
  const toc = destinationPoint(ORIGIN.lat, ORIGIN.lon, brg, 95);
  const tod = destinationPoint(ORIGIN.lat, ORIGIN.lon, brg, total - 112);
  const mid = destinationPoint(ORIGIN.lat, ORIGIN.lon, brg, (95 + total - 112) / 2);
  return {
    callsign: 'AFV123', flightNumber: 'AFV123', aircraft: 'A320', registration: '',
    origin: ORIGIN, destination: DEST, cruiseAlt: CRUISE, stepString: '', route: 'Vol de démonstration',
    distanceNm: Math.round(total), eteSec: 80 * 60, fuelPlanKg: 6800,
    metarDep: 'LFPG 191030Z 07008KT CAVOK 09/03 Q1024 NOSIG',
    metarArr: 'LFMN 191030Z 05006KT CAVOK 15/08 Q1021 NOSIG',
    route_points: [
      { ident: 'LFPG', lat: ORIGIN.lat, lon: ORIGIN.lon, alt: 392, fuelKg: 6650 },
      { ident: 'TOC', lat: toc.lat, lon: toc.lon, alt: CRUISE, fuelKg: 5750 },
      { ident: 'DEMO1', lat: mid.lat, lon: mid.lon, alt: CRUISE, fuelKg: 5000 },
      { ident: 'TOD', lat: tod.lat, lon: tod.lon, alt: CRUISE, fuelKg: 4350 },
      { ident: 'LFMN', lat: DEST.lat, lon: DEST.lon, alt: 12, fuelKg: 3950 }],
    toc: { ident: 'TOC', lat: toc.lat, lon: toc.lon, alt: CRUISE },
    tod: { ident: 'TOD', lat: tod.lat, lon: tod.lon, alt: CRUISE },
    steps: [],
    demo: true
  };
}

// Simulation simple : une seconde de vol par appel à step().
class DemoFlight {
  constructor(opts = {}) {
    this.hard = !!opts.hardLanding;
    this.t = 0;
    this.lat = ORIGIN.lat;
    this.lon = ORIGIN.lon;
    this.alt = ORIGIN.elev;
    this.gs = 0;
    this.vs = 0;
    this.fuel = 6800;
    this.stage = 'board';
    this.stageT = 0;
    this.onGround = true;
    this.done = false;
  }

  step() {
    const dt = 1;
    this.t += dt;
    this.stageT += dt;
    const toDest = distanceNm(this.lat, this.lon, DEST.lat, DEST.lon);
    const brg = bearingDeg(this.lat, this.lon, DEST.lat, DEST.lon);
    let eng = true;
    let brake = false;
    let gear = true;
    const go = (st) => { this.stage = st; this.stageT = 0; };
    const ease = (cur, target, rate) => (cur < target ? Math.min(target, cur + rate) : Math.max(target, cur - rate));

    switch (this.stage) {
      case 'board':
        eng = this.stageT > 70; brake = this.stageT < 80; this.gs = 0; this.vs = 0;
        if (this.stageT >= 90) go('taxi');
        break;
      case 'taxi':
        this.gs = ease(this.gs, 15, 2);
        if (this.stageT >= 240) go('roll');
        break;
      case 'roll':
        this.gs = ease(this.gs, 160, 4.5);
        if (this.gs >= 150) { go('climb'); this.onGround = false; }
        break;
      case 'climb': {
        gear = this.alt - ORIGIN.elev < 800;
        const tgtGs = this.alt < 10000 ? 250 : 450;
        this.gs = ease(this.gs, tgtGs, 2);
        this.vs = this.alt < 10000 ? 2500 : 1800;
        if (this.alt >= CRUISE) { this.alt = CRUISE; this.vs = 0; go('cruise'); }
        break;
      }
      case 'cruise':
        gear = false; this.vs = 0; this.gs = ease(this.gs, 460, 1);
        if (toDest <= 108) go('descent');
        break;
      case 'descent': {
        gear = false;
        this.vs = -2200;
        const tgt = this.alt < 16000 ? 240 : 420;
        this.gs = ease(this.gs, tgt, 2);
        if (this.alt - DEST.elev < 3000) go('approach');
        break;
      }
      case 'approach': {
        const agl = this.alt - DEST.elev;
        gear = agl < 2500;
        this.gs = ease(this.gs, 140, 1.5);
        const remaining = Math.max(0.3, toDest);
        this.vs = -Math.max(600, Math.min(1500, (agl / (remaining / this.gs * 60))));
        if (agl < 60) this.vs = this.hard ? -780 : -170;
        if (agl + this.vs / 60 <= 0) { this.alt = DEST.elev; this.onGround = true; this.vsAtTouch = this.vs; go('rollout'); }
        break;
      }
      case 'rollout':
        this.vs = 0;
        this.gs = ease(this.gs, 14, 3.5);
        if (this.gs <= 14) go('taxiin');
        break;
      case 'taxiin':
        this.gs = this.stageT < 150 ? 14 : ease(this.gs, 0, 3);
        if (this.stageT > 150 && this.gs === 0) go('park');
        break;
      case 'park':
        this.gs = 0; brake = true; eng = this.stageT < 20;
        if (this.stageT > 40) this.done = true;
        break;
      default:
        break;
    }

    if (this.stage === 'park') brake = true;
    if (!this.onGround) this.alt = Math.max(DEST.elev, this.alt + this.vs / 60 * dt);
    if (this.gs > 0 && toDest > 0.05) {
      const p = destinationPoint(this.lat, this.lon, brg, Math.min(this.gs * dt / 3600, toDest));
      this.lat = p.lat; this.lon = p.lon;
    }
    if (eng) this.fuel -= this.onGround ? 0.25 : 0.75;
    const elev = toDest < 150 ? DEST.elev : ORIGIN.elev;
    const agl = this.onGround ? 0 : this.alt - elev;
    return {
      lat: this.lat, lon: this.lon, alt: this.alt, agl, ias: this.alt > 25000 ? this.gs * 0.62 : this.gs * 0.92, gs: this.gs,
      vs: this.vs, hdg: brg, onGround: this.onGround, fuelKg: this.fuel, engOn: eng, parkBrake: brake, gearDown: gear, windDir: 310, windKt: this.alt > 10000 ? 22 : 8,
      tdVel: this.stage === 'rollout' && this.stageT <= 1 && this.vsAtTouch ? -this.vsAtTouch / 60 : 0,
      title: 'Démonstration A320', time: this.t
    };
  }
}

module.exports = { DemoFlight, demoPlan };
