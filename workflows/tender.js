/**
 * Tender workflows
 * Handles: new-tender, quote-request, tender-submission
 */

module.exports = {

  'quote-request': async ({ runId, input, callClaude, recordStep, log, notionQuery, notionUpdate, pauseForApproval }) => {
    const { projectName, projectAddress, dueDate, internalDueDate, drawings, notionPageId } = input;
    const emailDraft = { to: 'james@circuitfireprotection.com', from: 'admin@firemasterfp.com.au', cc: 'info@firemastergroup.com.au', subject: `RFQ - ${projectName} | ${projectAddress}`, body: `Hi James,\n\nCan you please provide us a dry fire quotation for this project.\n\nProject Name: ${projectName}\nProject Address: ${projectAddress}\nDue date: ${internalDueDate || dueDate}\n\nThanks\nSteph`, attachments: drawings || [] };
    recordStep(runId, 'email-drafted', emailDraft);
    pauseForApproval(runId, { message: 'Review RFQ email before sending to James McKenzie', emailDraft, warning: drawings?.length === 0 ? 'WARNING: No drawings attached' : null, instructions: `Call POST /approve/${runId} with {"confirmed":true} to send` });
    return { status: 'awaiting-approval', emailDraft };
  },

  'tender-submission': async ({ runId, input, callClaude, recordStep, log, pauseForApproval }) => {
    const pathType = input.path || 'A';
    const submission = await callClaude('You are Fire Master Pty Ltd tender submission automation. Respond JSON only.', `Generate tender submission details for: ${JSON.stringify(input)}\nRespond: {"coveringEmailSubject":"","coveringEmailBody":"","xeroQuoteTitle":"","xeroQuoteSummary":"","validityDays":30}`);
    recordStep(runId, 'submission-drafted', submission);
    const details = JSON.parse(submission);
    pauseForApproval(runId, { message: `Review ${pathType === 'A' ? 'Xero quote' : 'Tender Proposal'} before sending`, details, instructions: `Call POST /approve/${runId} with {"confirmed":true}` });
    return { status: 'awaiting-approval', details };
  }
};
