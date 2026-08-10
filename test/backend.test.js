'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeBarcode,
  barcodesMatch,
  coerceQty,
  validateAdjust,
  validateCreate,
  applyDelta,
  actionForDelta,
  buildAuditRow,
  buildInventoryList,
  buildHistory,
  parseBody,
  parseUserRows,
  authenticatePin,
  MAX_ABS_DELTA,
  MAX_START_QTY,
} = require('../apps-script/Code.js');

test('barcode normalization trims and preserves leading zeros', () => {
  assert.equal(normalizeBarcode('  042100005264 '), '042100005264');
  assert.equal(normalizeBarcode(42), '42');
  assert.equal(normalizeBarcode(null), '');
  assert.equal(normalizeBarcode(undefined), '');
});

test('numeric sheet cell matches the string scan of the same digits', () => {
  assert.equal(barcodesMatch(12345678, '12345678'), true);
  assert.equal(barcodesMatch('ABC-001', ' ABC-001 '), true);
});

test('leading-zero codes never cross-match their unpadded twin', () => {
  assert.equal(barcodesMatch('042100005264', '42100005264'), false);
  assert.equal(barcodesMatch(42, '042'), false);
  assert.equal(barcodesMatch('', ''), false);
});

test('quantity coercion: blank and garbage read as 0, numbers truncate', () => {
  assert.equal(coerceQty(''), 0);
  assert.equal(coerceQty('n/a'), 0);
  assert.equal(coerceQty(undefined), 0);
  assert.equal(coerceQty(7), 7);
  assert.equal(coerceQty('12'), 12);
  assert.equal(coerceQty(3.9), 3);
  assert.equal(coerceQty(-1.2), -1);
});

test('adjust validation enforces the delta contract', () => {
  const ok = validateAdjust({ barcode: 'A1', delta: MAX_ABS_DELTA });
  assert.equal(ok.ok, true);
  assert.equal(ok.delta, MAX_ABS_DELTA);
  assert.equal(validateAdjust({ barcode: 'A1', delta: -MAX_ABS_DELTA }).ok, true);
  for (const delta of [0, MAX_ABS_DELTA + 1, -(MAX_ABS_DELTA + 1), 1.5, '1', undefined]) {
    const r = validateAdjust({ barcode: 'A1', delta });
    assert.equal(r.ok, false, `delta ${JSON.stringify(delta)} must be rejected`);
    assert.equal(r.error, 'bad_request');
  }
});

test('adjust validation requires a usable barcode', () => {
  assert.equal(validateAdjust({ delta: 1 }).error, 'bad_request');
  assert.equal(validateAdjust({ barcode: '   ', delta: 1 }).error, 'bad_request');
  assert.equal(validateAdjust({ barcode: 'x'.repeat(129), delta: 1 }).error, 'bad_request');
  assert.equal(validateAdjust({ barcode: 'x'.repeat(128), delta: 1 }).ok, true);
});

test('delta application rejects going below zero', () => {
  assert.deepEqual(applyDelta(5, -5), { ok: true, qty: 0 });
  assert.deepEqual(applyDelta(0, 1), { ok: true, qty: 1 });
  const rejected = applyDelta(0, -1);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'below_zero');
  assert.equal(rejected.qty, 0);
  assert.equal(applyDelta(2, -3).error, 'below_zero');
});

test('action is explicit: add for positive, remove for negative', () => {
  assert.equal(actionForDelta(1), 'add');
  assert.equal(actionForDelta(5), 'add');
  assert.equal(actionForDelta(-1), 'remove');
});

test('create validation applies defaults and trimming', () => {
  const v = validateCreate({ barcode: ' B1 ', name: '  Oil filter ' });
  assert.equal(v.ok, true);
  assert.equal(v.barcode, 'B1');
  assert.equal(v.name, 'Oil filter');
  assert.equal(v.startQty, 1);
});

test('create validation rejects bad input', () => {
  assert.equal(validateCreate({ barcode: 'B1' }).error, 'bad_request');
  assert.equal(validateCreate({ barcode: 'B1', name: '   ' }).error, 'bad_request');
  assert.equal(validateCreate({ barcode: 'B1', name: 'x'.repeat(201) }).error, 'bad_request');
  assert.equal(validateCreate({ barcode: 'B1', name: 'x'.repeat(200) }).ok, true);
  assert.equal(validateCreate({ name: 'Bolt' }).error, 'bad_request');
  assert.equal(validateCreate({ barcode: 'B1', name: 'Bolt', startQty: -1 }).error, 'bad_request');
  assert.equal(validateCreate({ barcode: 'B1', name: 'Bolt', startQty: MAX_START_QTY + 1 }).error, 'bad_request');
  assert.equal(validateCreate({ barcode: 'B1', name: 'Bolt', startQty: 2.5 }).error, 'bad_request');
  assert.equal(validateCreate({ barcode: 'B1', name: 'Bolt', startQty: MAX_START_QTY }).ok, true);
});

test('creating with starting quantity 0 is allowed and still logs an add', () => {
  const v = validateCreate({ barcode: 'B2', name: 'Gasket', startQty: 0 });
  assert.equal(v.ok, true);
  assert.equal(v.startQty, 0);
  const ts = new Date('2026-07-19T12:00:00Z');
  const row = buildAuditRow(ts, 'B2', 'Gasket', 'add', 0, 0, 'Marko');
  assert.equal(row[3], 'add');
  assert.equal(row[4], 0);
  assert.equal(row[5], 0);
});

test('audit rows have the exact column order, user last and blank without auth', () => {
  const ts = new Date('2026-07-19T12:00:00Z');
  assert.deepEqual(
    buildAuditRow(ts, '0421', 'Brake pad', 'remove', -1, 4, 'Marko'),
    [ts, '0421', 'Brake pad', 'remove', -1, 4, 'Marko']
  );
  assert.deepEqual(
    buildAuditRow(ts, '0421', 'Brake pad', 'remove', -1, 4, null),
    [ts, '0421', 'Brake pad', 'remove', -1, 4, '']
  );
});

test('user rows: half-filled or blank rows are ignored, values trimmed', () => {
  const users = parseUserRows([
    ['Marko', '2468'],
    ['', '9999'],
    ['No Pin', ''],
    [' Ana ', 1357],
    [null, null],
  ]);
  assert.deepEqual(users, [
    { name: 'Marko', pin: '2468' },
    { name: 'Ana', pin: '1357' },
  ]);
});

test('per-user PIN auth: disabled with no users, unique match required', () => {
  assert.deepEqual(authenticatePin([], 'anything'), { required: false, ok: true, user: null });
  const users = [
    { name: 'Marko', pin: '2468' },
    { name: 'Ana', pin: '1357' },
  ];
  assert.deepEqual(authenticatePin(users, '2468'), { required: true, ok: true, user: 'Marko' });
  assert.deepEqual(authenticatePin(users, ' 1357 '), { required: true, ok: true, user: 'Ana' });
  assert.equal(authenticatePin(users, '0000').ok, false);
  assert.equal(authenticatePin(users, '').ok, false);
  assert.equal(authenticatePin(users, undefined).ok, false);
  const dup = authenticatePin(
    [{ name: 'A', pin: '1111' }, { name: 'B', pin: '1111' }], '1111');
  assert.equal(dup.ok, false);
  assert.match(dup.message, /more than one user/);
});

test('inventory list: blank-barcode rows skipped, sorted by name, values coerced', () => {
  const items = buildInventoryList([
    ['B2', 'washer', ''],
    ['', 'ghost row', 5],
    ['042', 'Brake pad', '7.9'],
    [12345, 'oil Filter', 3],
  ]);
  assert.deepEqual(items, [
    { barcode: '042', name: 'Brake pad', qty: 7 },
    { barcode: '12345', name: 'oil Filter', qty: 3 },
    { barcode: 'B2', name: 'washer', qty: 0 },
  ]);
  assert.deepEqual(buildInventoryList([]), []);
});

test('history: newest first, limited, values coerced', () => {
  const rows = [];
  for (let i = 1; i <= 60; i++) {
    rows.push([new Date(Date.UTC(2026, 0, 1, 0, i)), 'B' + i, 'Part ' + i, 'add', 1, i, 'Marko']);
  }
  const items = buildHistory(rows, 50);
  assert.equal(items.length, 50);
  assert.equal(items[0].barcode, 'B60');
  assert.equal(items[0].ts, '2026-01-01T01:00:00.000Z');
  assert.equal(items[49].barcode, 'B11');
  const one = buildHistory([['2026-07-20T10:00:00Z', 42, null, 'remove', '-1', '3.9', null]], 50)[0];
  assert.deepEqual(one, {
    ts: '2026-07-20T10:00:00Z', barcode: '42', name: '', action: 'remove',
    change: -1, qty: 3, user: '',
  });
  assert.deepEqual(buildHistory([], 50), []);
});

test('POST body parsing accepts only a JSON object', () => {
  const parsed = parseBody('{"action":"adjust","barcode":"1","delta":1}');
  assert.equal(parsed.action, 'adjust');
  for (const bad of ['not json', '"hi"', '[1,2]', '', 'null', '42', undefined]) {
    assert.equal(parseBody(bad), null, `body ${JSON.stringify(bad)} must be rejected`);
  }
});
