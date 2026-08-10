/**
 * Inventory Scanner — Google Apps Script backend.
 *
 * This one file is the entire backend. Paste it into the Apps Script editor
 * that is bound to the inventory Google Sheet (Extensions → Apps Script),
 * then deploy it as a Web App with:
 *
 *   Execute as:      Me
 *   Who has access:  Anyone
 *
 * The frontend holds no credentials — the Web App URL is the only thing it
 * knows. Any change to this file requires a NEW deployment version before
 * it is served (the editor code is not what runs at the deployment URL).
 *
 * The same file also runs unmodified under Node for unit tests: the pure
 * helpers are exported behind the `typeof module` guard at the bottom, and
 * nothing outside the entry points touches Google services.
 */

/* ============================== Configuration ============================= */

// Leave '' to use the spreadsheet this script is bound to. To point the
// script at a different spreadsheet, paste that spreadsheet's ID (the long
// token in its URL) between the quotes, save, and create a new deployment
// version.
const SHEET_ID = '';

const APP_ID = 'inventory-scanner';

const INVENTORY_SHEET_NAME = 'Inventory';
const AUDIT_SHEET_NAME = 'Audit';
// Optional per-user PINs live in the Users tab (never in this file or the
// repo): one row per person, Name in column A, PIN in column B. With no
// user rows, no PIN is required. Rows are read at request time, so adding,
// changing, or removing users takes effect immediately — no redeployment.
const USERS_SHEET_NAME = 'Users';
const INVENTORY_HEADERS = ['Barcode', 'Part Name', 'Quantity', 'Last Updated'];
const AUDIT_HEADERS = ['Timestamp', 'Barcode', 'Part Name', 'Action', 'Qty Change', 'Resulting Quantity', 'User'];
const USERS_HEADERS = ['Name', 'PIN'];

const MAX_BARCODE_LENGTH = 128;
const MAX_NAME_LENGTH = 200;
const MAX_ABS_DELTA = 1000;
const MAX_START_QTY = 100000;
const LOCK_WAIT_MS = 10000;

/* ============================ Pure helper logic ===========================
   Everything in this section is side-effect free and unit-tested in Node. */

// Barcodes are compared as normalized strings so a numeric Sheet cell
// (12345678) matches the scan "12345678", while "042…" and "42…" stay
// distinct codes.
function normalizeBarcode(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function barcodesMatch(a, b) {
  const na = normalizeBarcode(a);
  const nb = normalizeBarcode(b);
  return na !== '' && na === nb;
}

// A blank or garbage Quantity cell reads as 0; anything numeric truncates
// to an integer.
function coerceQty(value) {
  const n = Number(value);
  if (!isFinite(n)) return 0;
  return Math.trunc(n);
}

function badRequest(message) {
  return { ok: false, error: 'bad_request', message: message };
}

function validateAdjust(body) {
  const barcode = normalizeBarcode(body && body.barcode);
  if (!barcode) return badRequest('Missing barcode.');
  if (barcode.length > MAX_BARCODE_LENGTH) {
    return badRequest('Barcode is longer than ' + MAX_BARCODE_LENGTH + ' characters.');
  }
  const delta = body.delta;
  if (!Number.isInteger(delta)) return badRequest('delta must be an integer.');
  if (delta === 0) return badRequest('delta must not be zero.');
  if (Math.abs(delta) > MAX_ABS_DELTA) {
    return badRequest('delta must be between -' + MAX_ABS_DELTA + ' and ' + MAX_ABS_DELTA + '.');
  }
  return { ok: true, barcode: barcode, delta: delta };
}

function validateCreate(body) {
  const barcode = normalizeBarcode(body && body.barcode);
  if (!barcode) return badRequest('Missing barcode.');
  if (barcode.length > MAX_BARCODE_LENGTH) {
    return badRequest('Barcode is longer than ' + MAX_BARCODE_LENGTH + ' characters.');
  }
  const name = body && body.name !== null && body.name !== undefined ? String(body.name).trim() : '';
  if (!name) return badRequest('Part name is required.');
  if (name.length > MAX_NAME_LENGTH) {
    return badRequest('Part name is longer than ' + MAX_NAME_LENGTH + ' characters.');
  }
  let startQty = 1;
  if (body.startQty !== undefined && body.startQty !== null) {
    if (!Number.isInteger(body.startQty)) return badRequest('startQty must be a whole number.');
    if (body.startQty < 0 || body.startQty > MAX_START_QTY) {
      return badRequest('startQty must be between 0 and ' + MAX_START_QTY + '.');
    }
    startQty = body.startQty;
  }
  return { ok: true, barcode: barcode, name: name, startQty: startQty };
}

function applyDelta(currentQty, delta) {
  const next = currentQty + delta;
  if (next < 0) return { ok: false, error: 'below_zero', qty: currentQty };
  return { ok: true, qty: next };
}

// The audit Action column is explicit, never derived from the sign of the
// change downstream — a part created with starting qty 0 still logs 'add'.
function actionForDelta(delta) {
  return delta < 0 ? 'remove' : 'add';
}

// Column order: Timestamp, Barcode, Part Name, Action, Qty Change,
// Resulting Quantity, User (blank when PINs are not configured).
function buildAuditRow(timestamp, barcode, name, action, qtyChange, resultingQty, user) {
  return [timestamp, barcode, name, action, qtyChange, resultingQty, user || ''];
}

// Raw Inventory rows ([Barcode, Part Name, Quantity]) → list items sorted
// by name (case-insensitive). Rows with a blank barcode are skipped.
function buildInventoryList(values) {
  const items = [];
  for (let i = 0; i < values.length; i++) {
    const barcode = normalizeBarcode(values[i][0]);
    if (!barcode) continue;
    items.push({
      barcode: barcode,
      name: String(values[i][1] === null || values[i][1] === undefined ? '' : values[i][1]),
      qty: coerceQty(values[i][2])
    });
  }
  items.sort(function (a, b) {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  });
  return items;
}

// Raw Audit rows ([Timestamp, Barcode, Part Name, Action, Qty Change,
// Resulting Quantity, User]) → the most recent `limit` movements, newest
// first, with values coerced for the client.
function buildHistory(values, limit) {
  const start = Math.max(0, values.length - limit);
  const items = [];
  for (let i = values.length - 1; i >= start; i--) {
    const r = values[i];
    items.push({
      ts: r[0] instanceof Date ? r[0].toISOString() : String(r[0] === null || r[0] === undefined ? '' : r[0]),
      barcode: normalizeBarcode(r[1]),
      name: String(r[2] === null || r[2] === undefined ? '' : r[2]),
      action: String(r[3] === null || r[3] === undefined ? '' : r[3]),
      change: coerceQty(r[4]),
      qty: coerceQty(r[5]),
      user: String(r[6] === null || r[6] === undefined ? '' : r[6])
    });
  }
  return items;
}

// A POST body is only usable if it parses to a plain JSON object.
function parseBody(text) {
  if (typeof text !== 'string' || text === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

function normalizePin(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

// Rows from the Users tab (A=Name, B=PIN) → [{name, pin}]. Rows missing
// either value are ignored, so half-filled rows can't lock anyone out.
function parseUserRows(values) {
  const users = [];
  for (let i = 0; i < values.length; i++) {
    const name = values[i][0] === null || values[i][0] === undefined ? '' : String(values[i][0]).trim();
    const pin = normalizePin(values[i][1]);
    if (name && pin) users.push({ name: name, pin: pin });
  }
  return users;
}

// Per-user PIN auth. No configured users = auth disabled. A PIN shared by
// two users is refused outright — otherwise the audit trail would silently
// attribute their actions to whoever happens to be listed first.
function authenticatePin(users, providedPin) {
  if (!users || users.length === 0) return { required: false, ok: true, user: null };
  const pin = normalizePin(providedPin);
  if (pin === '') return { required: true, ok: false, user: null };
  const matches = users.filter(function (u) { return u.pin === pin; });
  if (matches.length === 1) return { required: true, ok: true, user: matches[0].name };
  if (matches.length > 1) {
    return {
      required: true, ok: false, user: null,
      message: 'This PIN is assigned to more than one user — fix the Users tab.'
    };
  }
  return { required: true, ok: false, user: null };
}

/* ========================= Apps Script entry points ======================= */

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const sheets = getSheets();
    const auth = authenticatePin(readUsers(sheets.users), params.pin);
    if (params.action === 'ping') {
      const out = { ok: true, app: APP_ID, pinRequired: auth.required };
      // Only report a verdict when a PIN was actually offered, so ping
      // stays usable for URL verification without leaking anything.
      if (auth.required && params.pin !== undefined) {
        out.pinOk = auth.ok;
        if (auth.ok) out.user = auth.user;
        if (auth.message) out.message = auth.message;
      }
      return jsonResponse(out);
    }
    if (params.action === 'list') {
      if (!auth.ok) return jsonResponse(unauthorized(auth.message));
      const inv = sheets.inventory;
      const lastRow = inv.getLastRow();
      const values = lastRow < 2 ? [] : inv.getRange(2, 1, lastRow - 1, 3).getValues();
      const items = buildInventoryList(values);
      return jsonResponse({ ok: true, items: items, count: items.length });
    }
    if (params.action === 'history') {
      if (!auth.ok) return jsonResponse(unauthorized(auth.message));
      const audit = sheets.audit;
      const lastRow = audit.getLastRow();
      const values = lastRow < 2 ? [] : audit.getRange(2, 1, lastRow - 1, 7).getValues();
      return jsonResponse({ ok: true, items: buildHistory(values, 50) });
    }
    if (params.action === 'lookup') {
      if (!auth.ok) return jsonResponse(unauthorized(auth.message));
      const barcode = normalizeBarcode(params.barcode);
      if (!barcode) return jsonResponse(badRequest('Missing barcode.'));
      const row = findInventoryRow(sheets.inventory, barcode);
      if (!row) return jsonResponse({ ok: true, found: false, barcode: barcode });
      return jsonResponse({ ok: true, found: true, barcode: row.barcode, name: row.name, qty: row.qty });
    }
    return jsonResponse(badRequest('Unknown or missing action.'));
  } catch (err) {
    return jsonResponse(serverError(err));
  }
}

function doPost(e) {
  try {
    const body = parseBody(e && e.postData && e.postData.contents);
    if (!body) return jsonResponse(badRequest('Request body must be a JSON object.'));
    const auth = authenticatePin(readUsers(getSheets().users), body.pin);
    if (!auth.ok) return jsonResponse(unauthorized(auth.message));
    if (body.action === 'adjust') return jsonResponse(handleAdjust(body, auth.user));
    if (body.action === 'create') return jsonResponse(handleCreate(body, auth.user));
    return jsonResponse(badRequest('Unknown or missing action.'));
  } catch (err) {
    return jsonResponse(serverError(err));
  }
}

/* ============================= Write handlers ============================= */

function handleAdjust(body, userName) {
  const v = validateAdjust(body);
  if (!v.ok) return v;
  return withScriptLock(function () {
    const sheets = getSheets();
    const row = findInventoryRow(sheets.inventory, v.barcode);
    if (!row) return { ok: false, error: 'unknown_barcode', barcode: v.barcode };
    const applied = applyDelta(row.qty, v.delta);
    if (!applied.ok) {
      return {
        ok: false,
        error: 'below_zero',
        qty: row.qty,
        name: row.name,
        message: 'Only ' + row.qty + ' in stock — cannot remove ' + Math.abs(v.delta) + '.'
      };
    }
    const now = new Date();
    sheets.inventory.getRange(row.rowIndex, 3, 1, 2).setValues([[applied.qty, now]]);
    const action = actionForDelta(v.delta);
    const result = { ok: true, barcode: row.barcode, name: row.name, qty: applied.qty, action: action };
    appendAuditGuarded(sheets.audit, buildAuditRow(now, row.barcode, row.name, action, v.delta, applied.qty, userName), result);
    SpreadsheetApp.flush();
    return result;
  });
}

function handleCreate(body, userName) {
  const v = validateCreate(body);
  if (!v.ok) return v;
  return withScriptLock(function () {
    const sheets = getSheets();
    const existing = findInventoryRow(sheets.inventory, v.barcode);
    if (existing) {
      return {
        ok: false,
        error: 'exists',
        barcode: existing.barcode,
        name: existing.name,
        qty: existing.qty,
        message: '"' + existing.name + '" already exists with ' + existing.qty + ' in stock.'
      };
    }
    const now = new Date();
    const rowIndex = sheets.inventory.getLastRow() + 1;
    // Force the barcode cell to plain text BEFORE writing so numeric codes
    // keep their leading zeros (e.g. UPC 042100005264).
    sheets.inventory.getRange(rowIndex, 1).setNumberFormat('@');
    sheets.inventory.getRange(rowIndex, 1, 1, 4).setValues([[v.barcode, v.name, v.startQty, now]]);
    const result = { ok: true, created: true, barcode: v.barcode, name: v.name, qty: v.startQty, action: 'add' };
    appendAuditGuarded(sheets.audit, buildAuditRow(now, v.barcode, v.name, 'add', v.startQty, v.startQty, userName), result);
    SpreadsheetApp.flush();
    return result;
  });
}

/* ============================ Sheet access layer ========================== */

function withScriptLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    return { ok: false, error: 'busy', message: 'Another update is in progress — try again in a moment.' };
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function getSpreadsheet() {
  return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function getSheets() {
  const ss = getSpreadsheet();
  return {
    inventory: getOrCreateSheet(ss, INVENTORY_SHEET_NAME, INVENTORY_HEADERS),
    audit: getOrCreateSheet(ss, AUDIT_SHEET_NAME, AUDIT_HEADERS),
    users: getOrCreateSheet(ss, USERS_SHEET_NAME, USERS_HEADERS)
  };
}

function readUsers(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return parseUserRows(sheet.getRange(2, 1, lastRow - 1, 2).getValues());
}

function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

function findInventoryRow(sheet, barcode) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const values = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  for (let i = 0; i < values.length; i++) {
    if (barcodesMatch(values[i][0], barcode)) {
      return {
        rowIndex: i + 2,
        barcode: normalizeBarcode(values[i][0]),
        name: String(values[i][1]),
        qty: coerceQty(values[i][2])
      };
    }
  }
  return null;
}

// If the stock write succeeded but the audit append fails, the operation
// still reports success — with a warning the UI must surface. The stock
// change is never rolled back invisibly and never fails silently.
function appendAuditGuarded(auditSheet, rowValues, result) {
  try {
    const rowIndex = auditSheet.getLastRow() + 1;
    // Same plain-text rule as Inventory for the barcode column.
    auditSheet.getRange(rowIndex, 2).setNumberFormat('@');
    auditSheet.getRange(rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
  } catch (err) {
    result.warning = 'audit_failed';
    result.message = 'Stock was updated, but writing the audit log failed (' +
      ((err && err.message) || err) + '). Check the Audit tab.';
  }
}

function unauthorized(message) {
  return { ok: false, error: 'unauthorized', message: message || 'Wrong or missing PIN.' };
}

function serverError(err) {
  return { ok: false, error: 'server_error', message: String((err && err.message) || err) };
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ==================== Node test exports (no-op in GAS) ==================== */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeBarcode: normalizeBarcode,
    barcodesMatch: barcodesMatch,
    coerceQty: coerceQty,
    validateAdjust: validateAdjust,
    validateCreate: validateCreate,
    applyDelta: applyDelta,
    actionForDelta: actionForDelta,
    buildAuditRow: buildAuditRow,
    buildInventoryList: buildInventoryList,
    buildHistory: buildHistory,
    parseBody: parseBody,
    normalizePin: normalizePin,
    parseUserRows: parseUserRows,
    authenticatePin: authenticatePin,
    MAX_BARCODE_LENGTH: MAX_BARCODE_LENGTH,
    MAX_NAME_LENGTH: MAX_NAME_LENGTH,
    MAX_ABS_DELTA: MAX_ABS_DELTA,
    MAX_START_QTY: MAX_START_QTY
  };
}
