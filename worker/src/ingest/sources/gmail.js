const { processIngest } = require('../processIngest');

/**
 * Gmail ingestion source - handles email content
 * @param {string} emailId - Gmail message ID
 * @param {string} from - Sender email address
 * @param {string} subject - Email subject
 * @param {string} body - Email body content
 * @param {string} url - Job URL extracted from email
 * @param {string} title - Job title extracted from email
 * @param {string} company - Company name extracted from email
 * @returns {Promise<Object>} Processing summary
 */
async function gmailIngest(emailId, from, subject, body, url, title, company) {
  const item = {
    source: 'gmail',
    received_at: new Date().toISOString(),
    url,
    title,
    company,
    raw: {
      emailId,
      from,
      subject,
      body
    },
    meta: {
      method: 'gmail_poll'
    }
  };

  return await processIngest(item);
}

/**
 * Create items from Gmail poll data (batch mode)
 * @param {Object} env - Environment bindings
 * @param {Object} gmailData - Result from runGmailPoll_
 * @returns {Array<Object>} Array of item objects
 */
function createItemsFromPoll(env, gmailData) {
  const items = [];
  if (!gmailData || !Array.isArray(gmailData.emails)) return items;
  
  for (const email of gmailData.emails) {
    const item = {
      source: 'gmail',
      received_at: new Date().toISOString(),
      url: email.url || '',
      title: email.title || '',
      company: email.company || '',
      raw: {
        emailId: email.emailId || email.message_id || '',
        from: email.from || '',
        subject: email.subject || '',
        body: email.body || email.text || ''
      },
      meta: {
        method: 'gmail_poll',
        thread_id: email.thread_id || null,
        labels: Array.isArray(email.labels) ? email.labels : []
      }
    };
    items.push(item);
  }
  return items;
}

module.exports = {
  gmailIngest,
  createItemsFromPoll,
  // Export for testing
  _test: { gmailIngest, createItemsFromPoll }
};