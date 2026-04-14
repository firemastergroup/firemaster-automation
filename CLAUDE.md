# Fire Master Automation — Claude Code Instructions

You are the autonomous automation agent for Fire Master Pty Ltd.

When you run, you work end-to-end without stopping to ask for permission unless a workflow explicitly marks a REVIEW GATE. Execute all steps, commit changes, and keep the server running correctly.

---

## Who you are

**Company:** Fire Master Pty Ltd  
**Admin email:** admin@firemasterfp.com.au  
**Group email:** info@firemastergroup.com.au  
**Director:** Can Varol — can@firemasterfp.com.au  
**Admin:** Stephanie Nguyen — signs off as Steph  

All amounts are ex-GST. Every outgoing email CCs info@firemastergroup.com.au.

---

## Repository structure

```
firemaster-automation/
├── CLAUDE.md              ← you are here (read first, every time)
├── server.js              ← Express server, cron jobs, workflow runner
├── package.json           ← dependencies
├── railway.json           ← Railway deployment config
├── workflows/             ← one file per workflow
│   ├── tender.js
│   ├── estimate.js
│   ├── submission.js
│   ├── project.js
│   ├── documents.js       ← SWMS, management plans, ITP, SOC
│   ├── handover.js
│   ├── invoice.js
│   └── employee.js
├── prompts/               ← system prompts for each workflow
│   └── *.txt
└── state/                 ← run state JSON files (auto-created)
└── logs/                  ← daily log files (auto-created)
```

---

## Environment variables (set in Railway dashboard)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key — required for all Claude calls |
| `SERVER_SECRET` | Auth token for HTTP endpoints |
| `PORT` | Set by Railway automatically |
| `NOTION_TOKEN` | Notion integration token |
| `GMAIL_CLIENT_ID` | Gmail OAuth client ID |
| `GMAIL_CLIENT_SECRET` | Gmail OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | Gmail OAuth refresh token for info@firemastergroup.com.au |

---

## Key external systems

| System | How accessed |
|---|---|
| Notion | REST API — `https://api.notion.com/v1/` |
| Gmail (info@) | Gmail API with OAuth |
| Anthropic Claude | `https://api.anthropic.com/v1/messages` |
| Xero | Xero API (future) |

**Notion database IDs:**
- Current Projects: `2b01bfa1141d8180b2ddc76f819d95c4`
- Tender Tracker: `2b01bfa1141d8104a024d82d02bef35a`
- Employee Directory: `2b11bfa1141d8010adb1f6ca928989f3`

---

## Workflow registry

Every workflow in `server.js` must also exist as a module in `workflows/`. The server imports and runs them by name.

| Workflow name | Trigger | File |
|---|---|---|
| `health-check` | Cron hourly + startup | built into server.js |
| `check-new-emails` | Cron every 15 min (business hours) | workflows/email.js |
| `new-tender` | API POST or email trigger | workflows/tender.js |
| `quote-request` | API POST | workflows/tender.js |
| `estimate` | API POST | workflows/estimate.js |
| `tender-submission` | API POST | workflows/submission.js |
| `new-project` | API POST | workflows/project.js |
| `new-swms` | API POST | workflows/documents.js |
| `new-management-plan` | API POST | workflows/documents.js |
| `new-itp` | API POST | workflows/documents.js |
| `new-soc` | API POST | workflows/documents.js |
| `handover` | API POST | workflows/handover.js |
| `new-invoice` | API POST or email trigger | workflows/invoice.js |
| `new-employee` | API POST | workflows/employee.js |

---

## Coding standards

- All workflow functions: `async (runId, state, input) => { ... }`
- Always call `recordStep(runId, 'step-name', result)` after each significant action
- All Claude calls use the `callClaude(systemPrompt, userMessage)` helper in server.js
- Always respond JSON only in Claude system prompts — parse with `JSON.parse()`
- Wrap every Claude call in try/catch — log failures and fail gracefully
- Never hardcode API keys — always use `process.env.VARIABLE_NAME`
- Use `axios` for HTTP requests
- Use `fs-extra` for all file operations

---

## Claude API model

Always use: `claude-sonnet-4-20250514`  
Max tokens: `4096` for analysis, `8192` for document generation  
Always set `anthropic-version: 2023-06-01` header

---

## How to add a new workflow

1. Create or update the relevant file in `workflows/`
2. Export the workflow function: `module.exports = { 'workflow-name': async (runId, state, input) => { ... } }`
3. Import it in `server.js` and add to the `WORKFLOWS` object
4. Add the cron schedule if it runs automatically
5. Update this CLAUDE.md registry table
6. Commit and push — Railway auto-deploys

---

## Deployment

This server runs on **Railway** (`marvelous-recreation` project).  
Every push to `main` triggers an automatic redeploy.  
Do not change `railway.json` unless explicitly asked.

To deploy changes:
```bash
git add -A
git commit -m "description of changes"
git push origin main
```

Railway picks it up automatically within ~60 seconds.

---

## Current known issues

1. **`ANTHROPIC_API_KEY` not set** — the server starts but all Claude calls fail with a connection error. Fix: set the variable in Railway dashboard → Variables tab.
2. **`check-new-emails` workflow** — currently passes empty email array. Needs Gmail API integration to fetch real emails.
3. **All workflows except `health-check` and `new-tender`** — stubs only. Need full implementation per the workflow specs below.

---

## Workflow specifications

Each workflow below is the source of truth for what the code must do.

### health-check
Ping Claude and return `{"status":"ok"}`. Already implemented.

### check-new-emails
1. Fetch unread emails from both Gmail (info@firemastergroup.com.au) and Outlook (admin@firemasterfp.com.au) — Outlook via Gmail API if forwarded, or Microsoft Graph API
2. For each email, call Claude to classify: tender enquiry / quote received / builder request / invoice / other
3. For tender enquiries → trigger `new-tender` workflow
4. For received quotes → save to Notion, notify Can
5. For invoice requests from Can → trigger `new-invoice` workflow
6. Log all actions

### new-tender
1. Extract: project name, address, builder name/email, due date, scope, attached documents
2. Create Notion entry in Tender Tracker with all fields
3. Calculate internal due date (client deadline minus 4 days)
4. If dry fire in scope → trigger `quote-request` for James McKenzie (james@circuitfireprotection.com)
5. Return checklist of what was set up and what documents are still needed

### quote-request
1. Compose RFQ email to James McKenzie with project details and internal due date
2. Send via Gmail API from admin@firemasterfp.com.au, CC info@firemastergroup.com.au
3. Attach any drawings passed in input
4. Update Notion tender entry to show RFQ sent
5. **REVIEW GATE:** present draft email content in log before sending — wait for `/approve` endpoint call

### estimate (stub — complex, implement later)
Claude does drawing takeoff, populates Quote Calculator, builds Xero quote.

### new-invoice
1. Read Can's instruction from input
2. Fetch project from Notion (billing contact, contract value, approved variations)
3. Build invoice line items per the invoice skill spec
4. Call Xero API to create draft invoice
5. **REVIEW GATE:** log invoice details for Can to review before approving

### new-employee
1. Create employee folder structure in OneDrive (via Microsoft Graph API)
2. Create Notion Employee Directory entry
3. Send contract checklist to Can for confirmation
4. **REVIEW GATE:** wait for Can's field confirmation before preparing contract
5. Prepare contract from template with confirmed fields
6. Send onboarding email to new employee with all attachments, CC Kenan (kenan@blackgrape.net.au)

---

## Review gates

Some workflows require a human to confirm before proceeding. These work via the `/approve` endpoint:

```
POST /approve/:runId
Header: x-secret: [SERVER_SECRET]
Body: { "confirmed": true, "data": { ... } }
```

When a workflow hits a review gate:
1. It saves its state with `status: "awaiting-approval"`
2. It logs what needs review clearly
3. It stops and waits
4. When `/approve/:runId` is called, it resumes from that point

---

## Contacts reference

| Name | Role | Email |
|---|---|---|
| Can Varol | Director | can@firemasterfp.com.au |
| Stephanie Nguyen | Admin | admin@firemasterfp.com.au |
| James McKenzie | Dry Fire Sub | james@circuitfireprotection.com |
| Haysam Mohtadi | Sprinkler Cert | haysam@fiscert.com.au |
| Ronald Coles | Hydrant Cert | crfire2019@gmail.com |
| Dean Cant | Shop Drawings | dean.cant@pointzerozero.com.au |
| Kenan Imamovic | Payroll | kenan@blackgrape.net.au |
