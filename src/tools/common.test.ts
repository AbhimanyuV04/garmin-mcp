import assert from 'node:assert/strict';
import { compact, firstDeviceEntry, hms, km, kmh, localFromEpoch, num, paceMinPerKm } from './common';

// Garmin sends sleep timestamps as epoch millis, not strings. No trailing "Z":
// the value is local wall time, so claiming UTC would misreport the bedtime.
assert.equal(localFromEpoch(1785532200000), '2026-07-31 21:10');
assert.equal(localFromEpoch(0), undefined, 'epoch 0 means "not recorded"');
assert.equal(localFromEpoch(null), undefined);

// Binary noise straight out of real payloads.
assert.equal(num(3.0999999046325684), 3.1);
assert.equal(num(165.015625, 0), 165);
assert.equal(num(null), undefined);
assert.equal(num(0), 0, 'zero is a real reading, not a missing one');

assert.equal(km(5432), 5.43);
assert.equal(km(null), undefined);
assert.equal(kmh(5), 18);

// 3.333 m/s is 5:00/km exactly; the seconds must not round to ":60".
assert.equal(paceMinPerKm(1000 / 300), '5:00');
assert.equal(paceMinPerKm(1000 / 305), '5:05');
// 4:59.6 rounds up and has to carry into the minute rather than print 4:60.
assert.equal(paceMinPerKm(1000 / 299.6), '5:00');
assert.equal(paceMinPerKm(0), undefined, 'a stopped athlete has no pace');
assert.equal(paceMinPerKm(undefined), undefined);

assert.equal(hms(45), '0:45');
assert.equal(hms(605), '10:05');
assert.equal(hms(3661), '1:01:01');
assert.equal(hms(undefined), undefined);

assert.deepEqual(compact({ a: 1, b: null, c: undefined, d: 0 }), { a: 1, d: 0 }, 'keeps zero');
assert.deepEqual(firstDeviceEntry({ '3412': { v: 1 } }), { v: 1 });
assert.equal(firstDeviceEntry(undefined), undefined);
assert.equal(firstDeviceEntry({}), undefined);

console.log('✓ formatters ok');
