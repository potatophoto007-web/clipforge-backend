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
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
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

// ── Write helpers ────────────────────────────────────────────────────────────
async function findRowById(tab, idValue) {
  const { sheets } = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:A`,
  });
  const values = res.data.values || [];
  const idx = values.findIndex((row, i) => i > 0 && row[0] === idValue);
  return idx === -1 ? -1 : idx + 1; // 1-based sheet row
}

function validateRequired(body, fields) {
  return fields.filter(f => !body[f] || !String(body[f]).trim());
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
    const data   = rowsToObjects(values).filter(p => p.status?.toLowerCase() !== 'archived');
    console.log(`[projects GET] ${data.length} rows, headers: ${values[0]?.join(', ')}`);
    res.json(data);
  } catch (err) {
    const reason = classifySheetError(err);
    console.error('[projects GET]', reason, '|', err.message);
    res.status(500).json({ error: reason, detail: err.message });
  }
});

app.post('/api/projects', async (req, res) => {
  const { project_id, client_id, status, video_type, created_date, due_date } = req.body || {};
  const missing = validateRequired(req.body || {}, ['project_id', 'client_id', 'video_type']);
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

  try {
    // Validate client exists in Clients sheet
    const clientVals = await fetchSheet('Clients!A:A');
    const clientIds = clientVals.slice(1).map(r => r[0]).filter(Boolean);
    if (!clientIds.includes(client_id.trim())) {
      return res.status(400).json({ error: `Client not found: ${client_id}` });
    }

    const { sheets } = getSheetsClient();
    const today = new Date().toISOString().split('T')[0];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'ชีต1!A:F',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[project_id.trim(), client_id.trim(), status || 'Draft', video_type.trim(), created_date || today, due_date || '']] },
    });
    console.log(`[projects POST] appended ${project_id} → client ${client_id}`);
    res.json({ success: true, project_id, message: 'Project created' });
  } catch (err) {
    const reason = classifySheetError(err);
    console.error('[projects POST]', reason, '|', err.message);
    res.status(500).json({ error: reason });
  }
});

app.post('/api/leads', async (req, res) => {
  const { lead_id, company_name, contact_name, email, source, status, created_date } = req.body || {};
  const missing = validateRequired(req.body || {}, ['lead_id', 'company_name']);
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  if (email && !validateEmail(email)) return res.status(400).json({ error: 'Invalid email format' });

  try {
    const { sheets } = getSheetsClient();
    const today = new Date().toISOString().split('T')[0];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Leads!A:G',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[lead_id.trim(), company_name.trim(), contact_name || '', email || '', source || '', status || 'new', created_date || today]] },
    });
    console.log(`[leads POST] appended ${lead_id}`);
    res.json({ success: true, lead_id, message: 'Lead added' });
  } catch (err) {
    const reason = classifySheetError(err);
    console.error('[leads POST]', reason, '|', err.message);
    res.status(500).json({ error: reason });
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

app.put('/api/projects/:project_id', async (req, res) => {
  const { project_id } = req.params;
  const { client_id, status, video_type, created_date, due_date } = req.body || {};
  try {
    const rowNum = await findRowById('ชีต1', project_id);
    if (rowNum === -1) return res.status(404).json({ error: `Project ${project_id} not found` });

    const { sheets } = getSheetsClient();
    const cur = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `ชีต1!A${rowNum}:F${rowNum}` });
    const row = cur.data.values?.[0] || [];
    const updated = [
      project_id,
      client_id?.trim()    ?? row[1] ?? '',
      status               ?? row[2] ?? 'Draft',
      video_type?.trim()   ?? row[3] ?? '',
      created_date         ?? row[4] ?? '',
      due_date             ?? row[5] ?? '',
    ];
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `ชีต1!A${rowNum}:F${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [updated] },
    });
    console.log(`[projects PUT] updated row ${rowNum} for ${project_id}`);
    res.json({ success: true, updated_fields: { client_id, status, video_type, created_date, due_date } });
  } catch (err) {
    const reason = classifySheetError(err);
    console.error('[projects PUT]', reason, '|', err.message);
    res.status(500).json({ error: reason });
  }
});

app.delete('/api/projects/:project_id', async (req, res) => {
  const { project_id } = req.params;
  try {
    const rowNum = await findRowById('ชีต1', project_id);
    if (rowNum === -1) return res.status(404).json({ error: `Project ${project_id} not found` });

    const { sheets } = getSheetsClient();
    const cur = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `ชีต1!A${rowNum}:F${rowNum}` });
    const row = (cur.data.values?.[0] || []).slice();
    row[2] = 'Archived';
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `ชีต1!A${rowNum}:F${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
    console.log(`[projects DELETE] archived row ${rowNum} for ${project_id}`);
    res.json({ success: true, deleted_project_id: project_id });
  } catch (err) {
    const reason = classifySheetError(err);
    console.error('[projects DELETE]', reason, '|', err.message);
    res.status(500).json({ error: reason });
  }
});

// ── Clients ──────────────────────────────────────────────────────────────────
app.get('/api/clients', async (req, res) => {
  try {
    const values = await fetchSheet('Clients!A1:J1000');
    const data = rowsToObjects(values).filter(c => c.status?.toLowerCase() !== 'archived');
    console.log(`[clients GET] ${data.length} rows`);
    res.json(data);
  } catch (err) {
    const msg = err.message || '';
    if (err.code === 400 || err.status === 400 || msg.includes('Unable to parse range')) {
      return res.json([]);
    }
    const reason = classifySheetError(err);
    console.error('[clients GET]', reason, '|', err.message);
    res.status(500).json({ error: reason });
  }
});

app.post('/api/clients', async (req, res) => {
  const { client_id, company_name, contact_name, email, phone, address, industry, status, contract_date } = req.body || {};
  const missing = validateRequired(req.body || {}, ['client_id', 'company_name']);
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  if (email && !validateEmail(email)) return res.status(400).json({ error: 'Invalid email format' });

  try {
    const { sheets } = getSheetsClient();
    const today = new Date().toISOString().split('T')[0];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Clients!A:J',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[
        client_id.trim(), company_name.trim(), contact_name || '', email || '',
        phone || '', address || '', industry || '', status || 'active',
        contract_date || '', today,
      ]] },
    });
    console.log(`[clients POST] appended ${client_id}`);
    res.json({ success: true, client_id, message: 'Client created' });
  } catch (err) {
    const reason = classifySheetError(err);
    console.error('[clients POST]', reason, '|', err.message);
    res.status(500).json({ error: reason });
  }
});

app.put('/api/clients/:client_id', async (req, res) => {
  const { client_id } = req.params;
  const { company_name, contact_name, email, phone, address, industry, status, contract_date } = req.body || {};
  if (email && !validateEmail(email)) return res.status(400).json({ error: 'Invalid email format' });

  try {
    const rowNum = await findRowById('Clients', client_id);
    if (rowNum === -1) return res.status(404).json({ error: `Client ${client_id} not found` });

    const { sheets } = getSheetsClient();
    const cur = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `Clients!A${rowNum}:J${rowNum}` });
    const row = cur.data.values?.[0] || [];
    const updated = [
      client_id,
      company_name?.trim()  ?? row[1] ?? '',
      contact_name?.trim()  ?? row[2] ?? '',
      email?.trim()         ?? row[3] ?? '',
      phone?.trim()         ?? row[4] ?? '',
      address?.trim()       ?? row[5] ?? '',
      industry?.trim()      ?? row[6] ?? '',
      status                ?? row[7] ?? 'active',
      contract_date         ?? row[8] ?? '',
      row[9] ?? '',
    ];
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Clients!A${rowNum}:J${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [updated] },
    });
    console.log(`[clients PUT] updated row ${rowNum} for ${client_id}`);
    res.json({ success: true, updated_fields: req.body });
  } catch (err) {
    const reason = classifySheetError(err);
    console.error('[clients PUT]', reason, '|', err.message);
    res.status(500).json({ error: reason });
  }
});

app.delete('/api/clients/:client_id', async (req, res) => {
  const { client_id } = req.params;
  try {
    // Block delete if projects still reference this client
    const projVals = await fetchSheet('ชีต1!A:B');
    const projCount = projVals.slice(1).filter(r => r[1] === client_id && r[0]).length;
    if (projCount > 0) {
      return res.status(400).json({ error: `Cannot delete — ${projCount} project(s) reference this client` });
    }

    const rowNum = await findRowById('Clients', client_id);
    if (rowNum === -1) return res.status(404).json({ error: `Client ${client_id} not found` });

    const { sheets } = getSheetsClient();
    const cur = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `Clients!A${rowNum}:J${rowNum}` });
    const row = (cur.data.values?.[0] || []).slice();
    row[7] = 'Archived';
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Clients!A${rowNum}:J${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
    console.log(`[clients DELETE] archived ${client_id}`);
    res.json({ success: true, deleted_client_id: client_id });
  } catch (err) {
    const reason = classifySheetError(err);
    console.error('[clients DELETE]', reason, '|', err.message);
    res.status(500).json({ error: reason });
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