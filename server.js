const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
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
function listRuns(filter = null) { try { return fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.json')).map(f => fs.readJsonSync(path.join(STATE_DIR, f))).filter(s => filter ? s.status === filter : true).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)); } catch { return []; } }
function recordStep(runId, stepName, result) { const s = loadState(runId); if (!s) return; s.steps.push({ step: stepName, completedAt: new Date().toISOString(), result: typeof result === 'string' ? result.substring(0, 500) : result }); s.currentStep = s.steps.length; s.lastUpdated = new Date().toISOString(); saveState(runId, s); }
function completeRun(runId, status, result = null) { const s = loadState(runId); if (s) { s.status = status; s.completedAt = new Date().toISOString(); if (result) s.result = result; saveState(runId, s); } }
function pauseForApproval(runId, reviewData) { const s = loadState(runId); if (s) { s.status = 'awaiting-approval'; s.awaitingApproval = { requestedAt: new Date().toISOString(), reviewData }; saveState(runId, s); } }
async function callClaude(systemPrompt, userMessage, maxTokens = 4096, maxRetries = 3) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  for (let i = 1; i <= maxRetries; i++) {
    try {
      const r = await axios.post('https://api.anthropic.com/v1/messages', { model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] }, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 120000 });
      return r.data.content[0].text;
    } catch (err) { log('warn', 'claude', `Attempt ${i} failed: ${err.message}`); if (i === maxRetries) throw err; await new Promise(r => setTimeout(r, i * 2000)); }
  }
}
async function notionRequest(method, endpoint, body = null) {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error('NOTION_TOKEN environment variable is not set');
  const r = await axios({ method, url: `https://api.notion.com/v1${endpoint}`, headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }, ...(body && { data: body }) });
  return r.data;
}
async function notionQuery(databaseId, filter = null) { return notionRequest('POST', `/databases/${databaseId}/query`, filter ? { filter } : {}); }
async function notionCreate(databaseId, properties) { return notionRequest('POST', '/pages', { parent: { database_id: databaseId }, properties }); }
async function notionUpdate(pageId, properties) { return notionRequest('PATCH', `/pages/${pageId}`, { properties }); }
async function runWorkflow(name, trigger, input = {}) {
  if (!WORKFLOWS[name]) { log('error', name, `Unknown workflow: ${name}`); return { success: false, error: `Unknown workflow: ${name}` }; }
  const active = listRuns('running');
  if (active.find(r => r.workflow === name && r.trigger === trigger)) { log('warn', name, 'Skipping duplicate run'); return { success: false, error: 'Duplicate run skipped' }; }
  const runId = uuidv4();
  const state = { runId, workflow: name, trigger, input, status: 'running', currentStep: 0, steps: [], startedAt: new Date().toISOString(), lastUpdated: new Date().toISOString() };
  saveState(runId, state);
  log('info', name, `Started ${runId}`, { trigger, input });
  try {
    const result = await WORKFLOWS[name]({ runId, state, input, callClaude, recordStep, log, notionQuery, notionCreate, notionUpdate, pauseForApproval, loadState, saveState });
    completeRun(runId, 'success', result); log('info', name, `Completed ${runId}`); return { success: true, runId, result };
  } catch (err) { completeRun(runId, 'failed'); log('error', name, `Failed: ${err.message}`, { stack: err.stack }); return { success: false, runId, error: err.message }; }
}
const WORKFLOWS = {
  'health-check': async ({ runId, callClaude, recordStep }) => {
    const r = await callClaude('You are a health checker. Respond with JSON only, no other text.', 'Respond exactly: {"status":"ok","message":"Fire Master automation server is running"}');
    recordStep(runId, 'claude-ping', r); return JSON.parse(r);
  },
  'check-new-emails': async ({ runId, input, callClaude, recordStep, log }) => {
    const emails = input.emails || [];
    if (emails.length === 0) { log('info', 'check-new-emails', 'No emails to process'); return { actionItems: [], summary: 'No emails received' }; }
    const r = await callClaude(`You are the Fire Master Pty Ltd automation assistant. Classify each email and identify what action is needed.\nRespond with JSON only.\nAction types: "new-tender", "quote-received", "invoice-request", "builder-request", "no-action"\nFor each email that needs action, include: emailId, action, projectName (if identifiable), summary`, `Emails to process: ${JSON.stringify(emails)}\nRespond: {"actionItems":[{"emailId":"","action":"","projectName":"","summary":""}],"summary":""}`);
    recordStep(runId, 'email-analysis', r); return JSON.parse(r);
  },
  'new-tender': async ({ runId, input, callClaude, recordStep, log, notionCreate }) => {
    log('info', 'new-tender', 'Extracting tender details', input);
    const extracted = await callClaude('You are Fire Master Pty Ltd tender automation. Extract structured data from the input. Respond with JSON only.', `Extract tender details from this input: ${JSON.stringify(input)}\nRespond: {"projectName":"","projectAddress":"","builderName":"","builderEmail":"","builderContact":"","dueDate":"","internalDueDate":"4 days before dueDate YYYY-MM-DD","scope":"","dryFireInScope":false,"documentsReceived":[],"documentsMissing":["Architecture Drawings","Services Drawings","FER","R129","Scope of Works","Specifications"]}`);
    recordStep(runId, 'extract-details', extracted);
    const details = JSON.parse(extracted);
    let notionPage = null;
    try {
      notionPage = await notionCreate('2b01bfa1141d8104a024d82d02bef35a', { 'Project Name': { title: [{ text: { content: details.projectName || 'Unknown Project' } }] }, 'Status': { select: { name: 'In Progress' } }, ...(details.projectAddress && { 'Project Address': { rich_text: [{ text: { content: details.projectAddress } }] } }), ...(details.builderName && { 'Builder': { rich_text: [{ text: { content: details.builderName } }] } }), ...(details.dueDate && { 'Due Date': { date: { start: details.dueDate } } }) });
      recordStep(runId, 'notion-created', { pageId: notionPage.id }); log('info', 'new-tender', `Notion entry created: ${notionPage.id}`);
    } catch (err) { log('warn', 'new-tender', `Notion creation failed: ${err.message}`); }
    return { details, notionPageId: notionPage?.id, nextSteps: [details.dryFireInScope ? 'Trigger quote-request for James McKenzie' : null, details.documentsMissing.length > 0 ? `Chase missing docs: ${details.documentsMissing.join(', ')}` : null].filter(Boolean) };
  },
  'new-invoice': async ({ runId, input, callClaude, recordStep, log, notionQuery, pauseForApproval }) => {
    const parsed = await callClaude('You are Fire Master Pty Ltd invoice automation. Parse the invoice instruction. Respond with JSON only.', `Parse this invoice instruction: ${JSON.stringify(input)}\nRespond: {"projectName":"","invoiceType":"deposit|progress|variation|final|retention-pc|retention-dlp","amount":0,"description":"","paymentTermsDays":14,"variationNumber":null,"variationDescription":null}`);
    recordStep(runId, 'parse-instruction', parsed);
    const invoice = JSON.parse(parsed);
    let project = null;
    try {
      const results = await notionQuery('2b01bfa1141d8180b2ddc76f819d95c4', { property: 'Project Name', title: { contains: invoice.projectName } });
      project = results.results?.[0]; recordStep(runId, 'notion-lookup', { found: !!project, pageId: project?.id });
    } catch (err) { log('warn', 'new-invoice', `Notion lookup failed: ${err.message}`); }
    pauseForApproval(runId, { message: 'Review invoice details before creating in Xero', invoice, projectNotionId: project?.id, instructions: `Call POST /approve/${runId} with {"confirmed":true} to proceed` });
    log('info', 'new-invoice', `Awaiting approval for invoice: ${invoice.invoiceType} - $${invoice.amount}`);
    return { status: 'awaiting-approval', invoice };
  }
};

const WORKFLOW_DIR = path.join(__dirname, 'workflows');
if (fs.existsSync(WORKFLOW_DIR)) {
  fs.readdirSync(WORKFLOW_DIR).filter(f => f.endsWith('.js')).forEach(file => {
    try {
      const mod = require(path.join(WORKFLOW_DIR, file));
      Object.assign(WORKFLOWS, mod);
      log('info', 'server', `Loaded workflows from ${file}: ${Object.keys(mod).join(', ')}`);
    } catch (err) { log('error', 'server', `Failed to load ${file}: ${err.message}`); }
  });
}

function auth(req, res, next) {
  const secret = req.headers['x-secret'] || req.query.secret;
  if (secret !== (process.env.SERVER_SECRET || 'firemaster2024')) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.get('/', (req, res) => res.json({ name: 'Fire Master Automation Server', status: 'running', version: '2.0.0', time: new Date().toISOString(), workflows: Object.keys(WORKFLOWS), apiKeySet: !!process.env.ANTHROPIC_API_KEY, notionTokenSet: !!process.env.NOTION_TOKEN }));

app.post('/run/:workflow', auth, async (req, res) => {
  const { workflow } = req.params;
  if (!WORKFLOWS[workflow]) return res.status(404).json({ error: `Workflow '${workflow}' not found`, available: Object.keys(WORKFLOWS) });
  const runId = uuidv4();
  res.json({ started: true, workflow, runId, statusUrl: `/status/${runId}` });
  runWorkflow(workflow, 'api-trigger', req.body || {}).catch(err => log('error', workflow, `Unhandled error: ${err.message}`));
});

app.post('/approve/:runId', auth, async (req, res) => {
  const { runId } = req.params;
  const s = loadState(runId);
  if (!s) return res.status(404).json({ error: 'Run not found' });
  if (s.status !== 'awaiting-approval') return res.status(400).json({ error: `Run is not awaiting approval (status: ${s.status})` });
  const { confirmed, data, reason } = req.body || {};
  if (!confirmed) { completeRun(runId, 'cancelled'); log('info', s.workflow, `Run ${runId} cancelled: ${reason || 'no reason given'}`); return res.json({ cancelled: true, runId }); }
  s.status = 'running'; s.approvedAt = new Date().toISOString(); s.approvalData = data || {};
  saveState(runId, s); log('info', s.workflow, `Run ${runId} approved, resuming`);
  res.json({ resumed: true, runId });
});

app.get('/status/:runId', auth, (req, res) => { const s = loadState(req.params.runId); res.json(s || { error: 'Not found' }); });
app.get('/runs', auth, (req, res) => { const { status } = req.query; res.json(listRuns(status || null).slice(0, 50)); });
app.get('/logs', auth, (req, res) => {
  try {
    const d = new Date().toISOString().split('T')[0]; const f = path.join(LOG_DIR, `${d}.log`);
    if (!fs.existsSync(f)) return res.json([]);
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
    res.json(lines.map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } }).slice(-200));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/workflows', auth, (req, res) => { res.json({ workflows: Object.keys(WORKFLOWS) }); });
cron.schedule('0 * * * *', () => { log('info', 'cron', 'Running hourly health check'); runWorkflow('health-check', 'scheduled'); });
cron.schedule('*/15 21-23,0-9 * * *', () => { log('info', 'cron', 'Running email check'); runWorkflow('check-new-emails', 'scheduled', { emails: [] }); });

app.listen(PORT, () => {
  log('info', 'server', `Fire Master Automation Server v2.0.0 started on port ${PORT}`);
  log('info', 'server', `API key set: ${!!process.env.ANTHROPIC_API_KEY}`);
  log('info', 'server', `Notion token set: ${!!process.env.NOTION_TOKEN}`);
  log('info', 'server', `Loaded workflows: ${Object.keys(WORKFLOWS).join(', ')}`);
  setTimeout(() => runWorkflow('health-check', 'startup'), 3000);
});

module.exports = { app, callClaude, notionQuery, notionCreate, notionUpdate, recordStep, log, pauseForApproval };
