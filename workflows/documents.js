/**
 * Document workflows
 * Handles: new-swms, new-management-plan, new-itp, new-soc
 */

module.exports = {

  'new-swms': async ({ runId, input, callClaude, recordStep, log, pauseForApproval }) => {
    const analysis = await callClaude('You are Fire Master Pty Ltd SWMS automation. Respond JSON only.', `Analyse project and determine risks for: ${JSON.stringify(input)}\nRespond: {"swmsDocuments":[{"type":"","filename":"","risksToInclude":[],"risksToRemove":[],"projectSpecificRisks":[]}],"headerFields":{"projectName":"","projectAddress":"","builderName":"","date":"","scope":""},"reviewSummary":""}`);
    recordStep(runId, 'swms-analysed', analysis);
    const details = JSON.parse(analysis);
    pauseForApproval(runId, { message: 'Review SWMS details - Stephanie must approve', details, instructions: `Call POST /approve/${runId} to proceed` });
    return { status: 'awaiting-approval', details };
  },

  'new-management-plan': async ({ runId, input, callClaude, recordStep, log, pauseForApproval }) => {
    const plans = await callClaude('You are Fire Master Pty Ltd management plan automation. Respond JSON only.', `Generate management plan for: ${JSON.stringify(input)}\nRespond: {"plans":[{"type":"","code":"","filename":"","fieldsToPopulate":{}}]}`);
    recordStep(runId, 'plans-drafted', plans);
    const details = JSON.parse(plans);
    pauseForApproval(runId, { message: 'Review management plan fields - Stephanie must approve', details, instructions: `Call POST /approve/${runId} to proceed` });
    return { status: 'awaiting-approval', details };
  },

  'new-itp': async ({ runId, input, callClaude, recordStep }) => {
    const itp = await callClaude('You are Fire Master Pty Ltd ITP automation. Respond JSON only.', `Generate ITP header for: ${JSON.stringify(input)}\nRespond: {"itpCode":"ITP001","stage":"","filename":"","headerFields":{"projectName":"","address":"","revision":"V1","date":"","area":"","inspectedBy":"","drawingNo":"","revisionNo":""},"notionEntry":{"documentName":"","status":"Issued"}}`);
    recordStep(runId, 'itp-prepared', itp);
    return JSON.parse(itp);
  },

  'new-soc': async ({ runId, input, recordStep, pauseForApproval }) => {
    const standards = { 'sprinkler-residential': { number: 'AS 2118.4-2012', title: 'Accommodations Automatic Fire Sprinklers' }, 'sprinkler-general': { number: 'AS 2118.1-2017', title: 'Automatic Fire Sprinkler Systems \u2013 General Requirements' }, 'hydrant': { number: 'AS 2419.1-2005', title: 'Fire Hydrant Installations' }, 'hose-reel': { number: 'AS 2441-2005', title: 'Installation of Fire Hose Reels' }, 'detection': { number: 'AS 1670.1-2018', title: 'Fire Detection, Warning, Control and Intercom Systems' } };
    const std = standards[input.systemType] || standards['sprinkler-residential'];
    const soc = { filename: `${(input.projectName||'').replace(/\\s+/g,'')}_StatementOfCompliance_V1.docx`, date: new Date().toLocaleDateString('en-AU',{ day:'numeric', month:'long', year:'numeric' }), clientName: input.builderName, projectAddress: input.projectAddress, buildingDescription: input.buildingDescription || input.projectName, standard: std.number, standardTitle: std.title };
    recordStep(runId, 'soc-prepared', soc);
    pauseForApproval(runId, { message: 'Review Statement of Compliance fields - Stephanie must approve', soc, instructions: `Call POST /approve/${runId} to proceed` });
    return { status: 'awaiting-approval', soc };
  }
};
