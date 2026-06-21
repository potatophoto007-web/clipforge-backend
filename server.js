const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

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
  const status = err.code || err.status;
  const msg    = err.message || '';

  if (status === 403) {
    if (msg.includes('disabled') || msg.includes('SERVICE_DISABLED')) {
      return '403 — Google Sheets API not enabled. Go to console.cloud.google.com → APIs → enable "Google Sheets API"';
    }
    let email = 'check GOOGLE_CREDENTIALS';
    try { email = JSON.parse(process.env.GOOGLE_CREDENTIALS).client_email; } catch {}
    return `403 — Permission denied. Share the Google Sheet (Viewer) with: ${email}`;
  }
  if (status === 404) return '404 — Sheet not found. Verify GOOGLE_SHEET_ID and tab names (Projects / Leads)';
  if (status === 401) return '401 — Auth failed. GOOGLE_CREDENTIALS may be malformed or private_key is wrong';
  if (status === 400) return `400 — Bad request: ${msg}`;
  return `Error (${status ?? 'unknown'}): ${msg}`;
}

// ── Sheets fetch ─────────────────────────────────────────────────────────────
async function fetchSheet(range) {
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID env var is not set');

  const auth   = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

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
    emailStatus = creds.client_email
      ? `✓ ${creds.client_email}`
      : '✗ missing client_email';
    keyStatus = creds.private_key
      ? `✓ ${creds.private_key.length} chars — starts correctly: ${creds.private_key.startsWith('-----BEGIN') ? 'yes' : 'NO'}`
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

app.get('/api/projects', async (req, res) => {
  try {
    const values = await fetchSheet('Projects!A:J');
    const data   = rowsToObjects(values);
    console.log(`[projects] OK — ${data.length} rows`);
    res.json(data);
  } catch (err) {
    const reason = classifySheetError(err);
    console.error('[projects]', reason);
    res.status(500).json({ error: reason, detail: err.message });
  }
});

app.get('/api/leads', async (req, res) => {
  try {
    const values = await fetchSheet('Leads!A:J');
    const data   = rowsToObjects(values);
    console.log(`[leads] OK — ${data.length} rows`);
    res.json(data);
  } catch (err) {
    const reason = classifySheetError(err);
    console.error('[leads]', reason);
    res.status(500).json({ error: reason, detail: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
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
