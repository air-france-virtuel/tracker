'use strict';
// Essai : un paquet incomplet du simulateur ne doit pas faire planter le tracker.
const assert = require('assert');
const Module = require('module');
const { EventEmitter } = require('events');
const handle = new EventEmitter();
handle.addToDataDefinition = () => {}; handle.requestDataOnSimObject = () => {}; handle.close = () => {};
const fake = { open: async () => ({ recvOpen: { applicationName: 'MSFS 2024' }, handle }), Protocol: {}, SimConnectDataType: {}, SimConnectPeriod: {}, SimConnectConstants: {} };
const orig = Module._load;
Module._load = function (req, ...rest) { return req === 'node-simconnect' ? fake : orig.call(this, req, ...rest); };
const { SimLink } = require('../src/sim');
Module._load = orig;
// faux tampon qui imite node-simconnect : 18 nombres puis un texte de 256 octets
function buf(n, bytes) {
  let off = 0; const b = Buffer.alloc(bytes);
  return { readFloat64() { if (off + 8 > bytes) throw new RangeError('Illegal offset'); off += 8; return n; },
    readString256() { if (off + 256 > bytes) throw new RangeError('Illegal offset: 0 <= ' + off + ' (+256) <= ' + bytes); off += 256; return 'Fenix A320'; } };
}
(async () => {
  const s = new SimLink(); const got = [];
  s.on('data', (d) => got.push(d));
  await s.tryConnect();
  assert.strictEqual(s.connected, true);
  handle.emit('simObjectData', { requestID: 1, data: buf(1, 144 + 256) });          // paquet normal
  assert.strictEqual(got.length, 1); assert.strictEqual(got[0].title, 'Fenix A320');
  assert.doesNotThrow(() => handle.emit('simObjectData', { requestID: 1, data: buf(2, 144 + 248) })); // texte tronqué (le cas de l'erreur)
  assert.strictEqual(got.length, 2); assert.strictEqual(got[1].title, 'Fenix A320', 'on garde le nom précédent');
  assert.doesNotThrow(() => handle.emit('simObjectData', { requestID: 1, data: buf(3, 100) }));      // paquet très court : ignoré
  assert.strictEqual(got.length, 2);
  // données des check-lists (demande à part) : ajoutées au paquet suivant
  handle.emit('simObjectData', { requestID: 2, data: buf(1, 56) });
  handle.emit('simObjectData', { requestID: 1, data: buf(1, 144 + 256) });
  assert.strictEqual(got[got.length - 1].flapsIdx, 1); assert.strictEqual(got[got.length - 1].landLt, true);
  assert.doesNotThrow(() => handle.emit('simObjectData', { requestID: 2, data: buf(1, 20) })); // paquet incomplet : ignoré
  s.stop();
  console.log('connexion simulateur : OK');
})().catch((e) => { console.error(e); process.exit(1); });
