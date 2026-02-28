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

module.exports = {
  gmailIngest,
  // Export for testing
  _test: { gmailIngest }
};