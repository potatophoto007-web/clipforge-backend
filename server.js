const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// ── Static files (serve HTML, CSS, JS) ──────────────────────────────────────
app.use(express.static(path.join(__dirname)));

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// ── Credentials ─────────────────────────────────────────────────────────────
function parseCredentials() {
  const raw = process.env.GOOGLE_CREDENTIALS;
  if (!raw) throw new Error('GOOGLE_CREDENTIALS env var is not set');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('GOOGLE_CREDENTIALS is not valid JSON: ' + e.message);
  }
}

function getAuth() {
  const creds = parseCredentials();
  if (!creds.client_email) throw new Error('GOOGLE_CREDENTIALS missing client_email');
  if (!creds.private_key)  throw new Error('GOOGLE_CREDENTIALS missing private_key');

  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

// ── Error classification ─────────────────────────────────────────────────────
function classifySheetError(err) {
  const status  = err.code || err.status;
  const msg     = err.message || '';
  const details = err.errors?.[0]?.message || msg;

  if (status === 403) {
    if (details.includes('disabled') || details.includes('SERVICE_DISABLED')) {
      return '403 SERVICE_DISABLED — Enable "Google Sheets API" at console.cloud.google.com/apis';
    }
    let email = 'unknown';
    try { email = JSON.parse(process.env.GOOGLE_CREDENTIALS).client_email; } catch {}
    return `403 PERMISSION_DENIED — Share the Sheet (Viewer) with service account: ${email}`;
  }
  if (status === 404) return `404 NOT_FOUND — Wrong GOOGLE_SHEET_ID or sheet tab name. Raw: ${details}`;
  if (status === 401) return `401 UNAUTHENTICATED — private_key malformed or expired. Raw: ${details}`;
  if (status === 400) return `400 BAD_REQUEST — ${details}`;
  return `Error ${status ?? 'unknown'}: ${details}`;
}

// ── Sheets helpers ───────────────────────────────────────────────────────────
function getSheetsClient() {
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID env var is not set');
  const auth = getAuth();
  return { sheets: google.sheets({ version: 'v4', auth }), auth };
}

async function fetchSheet(range) {
  const { sheets } = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  return res.data.values || [];
}

function rowsToObjects(values) {
  if (!values || values.length < 2) return [];
  const [headers, ...rows] = values;
  return rows
    .filter(row => row.some(cell => cell !== ''))
    .map(row =>
      Object.fromEntries(
        headers.map((h, i) => [h.trim().toLowerCase().replace(/\s+/g, '_'), row[i] ?? ''])
      )
    );
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  let credsStatus = '✗ MISSING';
  let emailStatus = '—';
  let keyStatus   = '—';

  try {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS || '');
    credsStatus = '✓ valid JSON';
    emailStatus = creds.client_email ? `✓ ${creds.client_email}` : '✗ missing client_email';
    keyStatus   = creds.private_key
      ? `✓ ${creds.private_key.length} chars, begins correctly: ${creds.private_key.startsWith('-----BEGIN') ? 'yes' : 'NO'}`
      : '✗ missing private_key';
  } catch {
    credsStatus = '✗ invalid JSON or not set';
  }

  res.json({
    status: 'ok',
    timestamp: new Date(),
    env: {
      GOOGLE_CREDENTIALS: credsStatus,
      client_email:       emailStatus,
      private_key:        keyStatus,
      GOOGLE_SHEET_ID:    SHEET_ID ? `✓ …${SHEET_ID.slice(-6)}` : '✗ MISSING',
    },
  });
});

app.get('/api/sheet-info', async (req, res) => {
  try {
    const { sheets } = getSheetsClient();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      fields: 'spreadsheetId,properties.title,sheets.properties',
    });

    const tabs = (meta.data.sheets || []).map(s => ({
      id:    s.properties.sheetId,
      title: s.properties.title,
      index: s.properties.index,
      rows:  s.properties.gridProperties?.rowCount,
      cols:  s.properties.gridProperties?.columnCount,
    }));

    console.log('[sheet-info] tabs:', tabs.map(t => t.title).join(', '));
    res.json({
      spreadsheet_id:    meta.data.spreadsheetId,
      spreadsheet_title: meta.data.properties?.title,
      tabs,
    });
  } catch (err) {
    const reason = classifySheetError(err);
    console.error('[sheet-info]', reason, '|', err.message);
    res.status(500).json({ error: reason, detail: err.message });
  }
});

app.get('/api/projects', async (req, res) => {
  try {
    const values = await fetchSheet('ชีต1!A1:Z1000');
    const data   = rowsToObjects(values);
    console.log(`[projects] OK — ${data.length} rows, headers: ${values[0]?.join(', ')}`);
    res.json(data);
  } catch (err) {
    const reason = classifySheetError(err);
    console.error('[projects]', reason, '|', err.message);
    res.status(500).json({ error: reason, detail: err.message });
  }
});

app.get('/api/leads', async (req, res) => {
  try {
    const values = await fetchSheet('Leads!A1:Z1000');
    const data   = rowsToObjects(values);
    console.log(`[leads] OK — ${data.length} rows, headers: ${values[0]?.join(', ')}`);
    res.json(data);
  } catch (err) {
    // Tab doesn't exist yet → return empty array instead of 500
    const msg = err.message || '';
    if (err.code === 400 || err.status === 400 || msg.includes('Unable to parse range') || msg.includes('badRequest')) {
      console.warn('[leads] tab not found — returning []');
      return res.json([]);
    }
    const reason = classifySheetError(err);
    console.error('[leads]', reason, '|', err.message);
    res.status(500).json({ error: reason, detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ClipForge Backend → http://localhost:${PORT}`);
  try {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
    console.log('  SA email :', creds.client_email  || 'MISSING');
    console.log('  Priv key :', creds.private_key   ? 'SET' : 'MISSING');
  } catch {
    console.log('  GOOGLE_CREDENTIALS: invalid JSON or not set');
  }
  console.log('  SHEET_ID :', SHEET_ID ? `…${SHEET_ID.slice(-6)}` : 'MISSING');
});