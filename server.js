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

function makeId(prefix) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${prefix}${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
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

// ── Webhook: Lead Intake ──────────────────────────────────────────────────────
app.post('/webhook/lead-intake', async (req, res) => {
  const { company_name, contact_name, email, phone, source, budget, deadline, brief } = req.body || {};

  if (!company_name || !contact_name || !email) {
    return res.status(400).json({ error: 'Missing required fields: company_name, contact_name, email' });
  }
  if (!validateEmail(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  const today = new Date().toISOString().split('T')[0];
  const lead_id    = makeId('LD');
  const project_id = makeId('PRJ');

  console.log(`[webhook] intake start | source=${source || 'unknown'} | email=${email}`);

  try {
    const { sheets } = getSheetsClient();

    // 1. Check for existing client by email (column D)
    const clientRows = await fetchSheet('Clients!A:D');
    const existing = clientRows.slice(1).find(r => r[3]?.trim().toLowerCase() === email.toLowerCase());
    const isNewClient = !existing;
    const client_id = existing ? existing[0] : makeId('CW');

    if (isNewClient) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'Clients!A:J',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[
          client_id, company_name.trim(), contact_name.trim(), email.trim(),
          phone || '', '', '', 'active', '', today,
        ]] },
      });
      console.log(`[webhook] client created: ${client_id} (${company_name})`);
    } else {
      console.log(`[webhook] client matched: ${client_id} (existing)`);
    }

    // 2. Create lead record
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Leads!A:G',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[
        lead_id, company_name.trim(), contact_name.trim(), email.trim(),
        source || 'webhook', 'new', today,
      ]] },
    });
    console.log(`[webhook] lead created: ${lead_id}`);

    // 3. Auto-create project from lead
    const videoType = brief ? brief.substring(0, 80) : 'TBD — from lead intake';
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'ชีต1!A:F',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[
        project_id, client_id, 'Draft', videoType, today, deadline || '',
      ]] },
    });
    console.log(`[webhook] project created: ${project_id}`);

    console.log(`[webhook] done | lead=${lead_id} | client=${client_id} (${isNewClient ? 'new' : 'existing'}) | project=${project_id} | budget=${budget || '—'}`);

    res.json({
      success: true,
      lead_id,
      client_id,
      project_id,
      is_new_client: isNewClient,
      message: `Intake processed. Project ${project_id} created for ${company_name}.`,
    });
  } catch (err) {
    const reason = classifySheetError(err);
    console.error('[webhook]', reason, '|', err.message);
    res.status(500).json({ error: reason });
  }
});

// ── Form: Lead Intake ─────────────────────────────────────────────────────────
app.get('/form/lead-intake', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ClipForge — ส่ง Brief</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root { --bg:#FAFAF7; --surface:#fff; --border:rgba(0,0,0,0.09); --border-s:rgba(0,0,0,0.18); --text:#1A1A18; --muted:#6B6B66; --dim:#A8A8A2; --accent:#E85D2A; --green:#2D8B6E; --red:#C73E3E; --mono:'JetBrains Mono',monospace; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;font-size:14px;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;width:100%;max-width:520px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.06)}
  .card-head{padding:28px 32px 20px;border-bottom:1px solid var(--border)}
  .brand{font-family:var(--mono);font-size:12px;text-transform:uppercase;letter-spacing:0.15em;color:var(--dim);margin-bottom:10px}
  .title{font-size:24px;font-weight:600;letter-spacing:-0.02em;color:var(--text)}
  .sub{font-size:13px;color:var(--muted);margin-top:4px}
  .card-body{padding:24px 32px 28px}
  .row{margin-bottom:18px}
  .row.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  label{display:block;font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:0.12em;color:var(--dim);margin-bottom:5px}
  input,select,textarea{width:100%;padding:9px 12px;border:1px solid var(--border-s);border-radius:6px;background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;font-size:13px;outline:none;transition:border-color .15s,box-shadow .15s}
  input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(232,93,42,0.1)}
  textarea{resize:vertical;min-height:80px}
  .req{color:var(--accent)}
  .btn{width:100%;padding:11px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-family:'Inter',system-ui,sans-serif;font-size:14px;font-weight:500;cursor:pointer;transition:background .15s;margin-top:4px}
  .btn:hover{background:#FF7E4D}
  .btn:disabled{background:var(--dim);cursor:not-allowed}
  .result{margin-top:16px;padding:14px 16px;border-radius:6px;font-size:13px;display:none}
  .result.ok{background:rgba(45,139,110,.1);border:1px solid rgba(45,139,110,.2);color:var(--green)}
  .result.err{background:rgba(199,62,62,.08);border:1px solid rgba(199,62,62,.2);color:var(--red)}
  .result.show{display:block}
  .mono{font-family:var(--mono);font-size:12px}
  @media(max-width:480px){.row.two{grid-template-columns:1fr}.card-head,.card-body{padding:20px}}
</style>
</head>
<body>
<div class="card">
  <div class="card-head">
    <div class="brand">ClipForge Studio</div>
    <div class="title">ส่ง Brief</div>
    <div class="sub">กรอกข้อมูลเพื่อเริ่มโปรเจกต์ ทีมงานจะติดต่อกลับภายใน 24 ชม.</div>
  </div>
  <div class="card-body">
    <form id="f">
      <div class="row two">
        <div>
          <label>ชื่อบริษัท / แบรนด์ <span class="req">*</span></label>
          <input name="company_name" placeholder="Beauty Brand Co" required>
        </div>
        <div>
          <label>ชื่อผู้ติดต่อ <span class="req">*</span></label>
          <input name="contact_name" placeholder="คุณสมชาย" required>
        </div>
      </div>
      <div class="row two">
        <div>
          <label>อีเมล <span class="req">*</span></label>
          <input name="email" type="email" placeholder="contact@brand.com" required>
        </div>
        <div>
          <label>เบอร์โทร</label>
          <input name="phone" placeholder="+66-8x-xxx-xxxx">
        </div>
      </div>
      <div class="row two">
        <div>
          <label>งบประมาณ (บาท)</label>
          <input name="budget" placeholder="5,000 – 15,000">
        </div>
        <div>
          <label>Deadline</label>
          <input name="deadline" type="date">
        </div>
      </div>
      <div class="row">
        <label>Brief / รายละเอียดงาน</label>
        <textarea name="brief" placeholder="ต้องการทำวิดีโอโฆษณา 30 วินาที สินค้าประเภท..."></textarea>
      </div>
      <input type="hidden" name="source" value="form">
      <button class="btn" type="submit" id="sub">ส่ง Brief →</button>
      <div class="result" id="res"></div>
    </form>
  </div>
</div>
<script>
document.getElementById('f').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('sub');
  const res = document.getElementById('res');
  btn.disabled = true; btn.textContent = 'กำลังส่ง…';
  res.className = 'result'; res.textContent = '';

  const body = Object.fromEntries(new FormData(e.target));
  try {
    const r = await fetch('/webhook/lead-intake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (r.ok) {
      res.className = 'result ok show';
      res.innerHTML = '<strong>✓ ส่ง Brief สำเร็จ!</strong><br>ทีมงานจะติดต่อกลับภายใน 24 ชม.<br><span class="mono">Project: ' + data.project_id + ' · Lead: ' + data.lead_id + '</span>';
      e.target.reset();
    } else {
      res.className = 'result err show';
      res.textContent = '✗ ' + (data.error || 'เกิดข้อผิดพลาด กรุณาลองใหม่');
    }
  } catch(err) {
    res.className = 'result err show';
    res.textContent = '✗ ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่';
  } finally {
    btn.disabled = false; btn.textContent = 'ส่ง Brief →';
  }
});
</script>
</body>
</html>`);
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