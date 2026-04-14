/**
 * Project setup, handover, employee workflows
 */

module.exports = {

  'new-project': async ({ runId, input, callClaude, recordStep, log, notionCreate, notionUpdate }) => {
    let projectPage = null;
    try {
      projectPage = await notionCreate('2b01bfa1141d8180b2ddc76f819d95c4', { 'Project Name': { title: [{ text: { content: `${input.projectName} | ${input.projectAddress}` } }] }, 'Project Status': { select: { name: 'Won 🤝' } }, 'Job Type': { select: { name: input.jobType || 'Construct Only' } }, 'Scope of Works': { rich_text: [{ text: { content: input.scope || '' } }] } });
      recordStep(runId, 'notion-project-created', { pageId: projectPage.id });
    } catch (err) { log('warn', 'new-project', `Notion failed: ${err.message}`); }
    if (input.fromTender && input.tenderNotionId) {
      try { await notionUpdate(input.tenderNotionId, { 'Stage': { select: { name: 'Won 🥳' } } }); } catch (err) {}
    }
    const checklist = await callClaude('You are Fire Master Pty Ltd project setup automation. Respond JSON only.', `Generate project start checklist for: ${JSON.stringify(input)}\nRespond: {"folderStructure":["00 - Tender","01 - Contract & Admin","02 - Drawings","03 - Shop Drawings","04 - Project Management","05 - Handover"],"startChecklist":[{"item":"","responsible":"","status":"outstanding"}],"nextSteps":[]}`);
    recordStep(runId, 'checklist-generated', checklist);
    const details = JSON.parse(checklist);
    return { projectPageId: projectPage?.id, details };
  },

  'handover': async ({ runId, input, callClaude, recordStep, log, notionUpdate, pauseForApproval }) => {
    if (input.notionPageId) { try { await notionUpdate(input.notionPageId, { 'Project Status': { select: { name: 'Handover 📄' } } }); } catch (err) {} }
    const checklist = await callClaude('You are Fire Master Pty Ltd handover automation. Respond JSON only.', `Generate handover checklist for: ${JSON.stringify(input)}\nRespond: {"documents":[{"name":"Statement of Compliance","responsible":"Fire Master","status":"pending"}],"certifiers":[],"emailsToSend":[]}`);
    recordStep(runId, 'checklist-generated', checklist);
    const details = JSON.parse(checklist);
    pauseForApproval(runId, { message: 'Review handover checklist - confirm all documents are in hand', details, instructions: `Call POST /approve/${runId} when all docs received` });
    return { status: 'awaiting-approval', details };
  },

  'new-employee': async ({ runId, input, callClaude, recordStep, log, notionCreate, pauseForApproval }) => {
    let empPage = null;
    try {
      empPage = await notionCreate('2b11bfa1141d8010adb1f6ca928989f3', { 'Employee Name': { title: [{ text: { content: input.fullName } }] }, 'Employee Status': { select: { name: 'Onboarding' } }, 'Email Address': { email: input.email }, 'Phone Number': { phone_number: input.phone }, 'Employment Contract': { select: { name: 'Issued' } } });
      recordStep(runId, 'notion-employee-created', { pageId: empPage.id });
    } catch (err) { log('warn', 'new-employee', err.message); }
    const checklist = await callClaude('You are Fire Master Pty Ltd HR automation. Respond JSON only.', `Generate contract checklist for: ${JSON.stringify(input)}\nRespond: {"contractTemplate":"","fieldsForCan":[],"emailToCanSubject":"","emailToCanBody":""}`);
    recordStep(runId, 'checklist-generated', checklist);
    const details = JSON.parse(checklist);
    pauseForApproval(runId, { message: `Send contract checklist to Can for ${input.fullName} - wait for reply`, details, notionPageId: empPage?.id, instructions: `Call POST /approve/${runId} when Can replies` });
    return { status: 'awaiting-approval', details, notionPageId: empPage?.id };
  }
};
