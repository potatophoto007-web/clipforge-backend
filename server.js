const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'Backend is running', timestamp: new Date() });
});

// Fetch projects from Google Sheets
app.get('/api/projects', async (req, res) => {
  try {
    const response = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/Projects!A:H`,
      { params: { key: GOOGLE_API_KEY } }
    );
    res.json(response.data.values || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch leads from Google Sheets
app.get('/api/leads', async (req, res) => {
  try {
    const response = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/Leads!A:F`,
      { params: { key: GOOGLE_API_KEY } }
    );
    res.json(response.data.values || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ClipForge Backend running on http://localhost:${PORT}`);
});