const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SERVER_SECRET = process.env.SERVER_SECRET || 'firemaster2024';

const STATE_DIR = path.join(__dirname, 'state');
const LOG_DIR = path.join(__dirname, 'logs');

fs.ensureDirSync(STATE_DIR);
fs.ensureDirSync(LOG_DIR);

function log(level, workflow, message, data = null) {
  const entry = { timestamp: new Date().toISOString(), level, workflow, message, ...(data && { data }) };
  console.log(JSON.stringify(entry));
  const date = new Date().toISOString().split('T')[0];
  fs.appendFileSync(path.join(LOG_DIR, `${date}.log`), JSON.stringify(entry) + '\n');
}

function saveState(runId, state) { fs.writeJsonSync(path.join(STATE_DIR, `${runId}.json`), state, { spaces: 2 }); }
function loadState(runId) { const f = path.join(STATE_DIR, `${runId}.json`); return fs.existsSync(f) ? fs.readJsonSync(f) : null; }
function listActiveRuns() { return fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.json')).map(f => fs.readJsonSync(path.join(STATE_DIR, f))).filter(s => s.status === 'running'); }
function completeRun(runId, result) { const s = loadState(runId); if (s) { s.status = result; s.completedAt = new Date().toISOString(); saveState(runId, s); } }
function recordStep(runId, stepName, result) { const s = loadState(runId); if (!s) return; s.steps.push({ step: stepName, completedAt: new Date().toISOString(), result: typeof result === 'string' ? result.substring(0, 500) : result }); s.currentStep = s.steps.length; s.lastUpdated = new Date().toISOString(); saveState(runId, s); }

async function callClaude(systemPrompt, userMessage, maxRetries = 3) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      const r = await require('axios').post('https://api.anthropic.com/v1/messages', { model: 'claude-sonnet-4-20250514', max_tokens: 4096, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 120000 });
      return r.data.content[0].text;
    } catch (err) { if (i === maxRetries) throw err; await new Promise(r => setTimeout(r, i * 2000)); }
  }
}

async function runWorkflow(name, trigger, input = {}) {
  const active = listActiveRuns();
  if (active.find(r => r.workflow === name && r.trigger === trigger)) { log('warn', name, 'Skipping duplicate'); return; }
  const { v4: uuidv4 } = require('uuid');
  const runId = uuidv4();
  const state = { runId, workflow: name, trigger, input, status: 'running', currentStep: 0, steps: [], startedAt: new Date().toISOString(), lastUpdated: new Date().toISOString() };
  saveState(runId, state);
  log('info', name, `Started ${runId}`);
  try {
    const result = await WORKFLOWS[name](runId, state, input);
    completeRun(runId, 'success');
    log('info', name, `Completed ${runId}`);
    return { success: true, runId, result };
  } catch (err) {
    completeRun(runId, 'failed');
    log('error', name, `Failed: ${err.message}`);
    return { success: false, runId, error: err.message };
  }
}

const WORKFLOWS = {
  'health-check': async (runId) => {
    const r = await callClaude('You are a health checker. Respond JSON only.', 'Respond: {"status":"ok","message":"Fire Master automation server is running"}');
    recordStep(runId, 'claude-ping', r); return JSON.parse(r);
  },
  'check-new-emails': async (runId, state, input) => {
    const r = await callClaude('You are the Fire Master automation assistant. Respond JSON only.', `Analyse these emails and identify action items: ${JSON.stringify(input.emails || [])}. Respond: {"actionItems":[],"summary":""}`);
    recordStep(runId, 'email-analysis', r); return JSON.parse(r);
  },
  'new-tender': async (runId, state, input) => {
    log('info', 'new-tender', 'Running new tender setup', input);
    const sys = 'You are Fire Master Pty Ltd tender automation. Respond JSON only.';
    const s1 = await callClaude(sys, `Extract tender details from: ${JSON.stringify(input)}. Respond: {"projectName":"","builderName":"","builderEmail":"","address":"","dueDate":"","scope":"","documentsReceived":[],"documentsMissing":[]}`);
    recordStep(runId, 'extract-details', s1);
    const s2 = await callClaude(sys, `Generate setup checklist for: ${s1}. Respond: {"folderPath":"","subfolders":[],"notionFields":{},"emailToSend":{},"missingDocuments":[],"nextSteps":[]}`);
    recordStep(runId, 'generate-checklist', s2);
    return { step1: JSON.parse(s1), step2: JSON.parse(s2) };
  }
};

function auth(req, res, next) {
  const secret = req.headers['x-secret'] || req.query.secret;
  if (secret !== (process.env.SERVER_SECRET || 'firemaster2024')) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/', (req, res) => res.json({ name: 'Fire Master Automation Server', status: 'running', version: '1.0.0', time: new Date().toISOString(), workflows: Object.keys(WORKFLOWS) }));

app.post('/run/:workflow', auth, async (req, res) => {
  const { workflow } = req.params;
  if (!WORKFLOWS[workflow]) return res.status(404).json({ error: `Workflow '${workflow}' not found`, available: Object.keys(WORKFLOWS) });
  res.json({ started: true, workflow });
  runWorkflow(workflow, 'api-trigger', req.body || {}).catch(err => log('error', workflow, err.message));
});

app.get('/status/:runId', auth, (req, res) => { const s = loadState(req.params.runId); res.json(s || { error: 'Not found' }); });
app.get('/runs', auth, (req, res) => { try { const files = require('fs-extra').readdirSync(path.join(__dirname, 'state')).filter(f => f.endsWith('.json')); const runs = files.map(f => require('fs-extra').readJsonSync(path.join(__dirname, 'state', f))).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, 50); res.json(runs); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/logs', auth, (req, res) => { try { const d = new Date().toISOString().split('T')[0]; const f = path.join(__dirname, 'logs', `${d}.log`); if (!require('fs-extra').existsSync(f)) return res.json([]); const lines = require('fs-extra').readFileSync(f, 'utf8').trim().split('\n').filter(Boolean); res.json(lines.map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } }).slice(-100)); } catch (err) { res.status(500).json({ error: err.message }); } });

require('node-cron').schedule('0 * * * *', () => runWorkflow('health-check', 'scheduled'));
require('node-cron').schedule('*/15 21-23,0-9 * * *', () => runWorkflow('check-new-emails', 'scheduled', { emails: [] }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log('info', 'server', `Fire Master Automation Server started on port ${PORT}`);
  setTimeout(() => runWorkflow('health-check', 'startup'), 3000);
});

module.exports = app;