const { processIngest } = require('../processIngest');

/**
 * Vonage webhook ingestion source - handles WhatsApp messages
 * @param {string} message - WhatsApp message content
 * @param {string} from - Sender phone number
 * @param {string} url - Job URL extracted from message
 * @param {string} title - Job title extracted from message
 * @param {string} company - Company name extracted from message
 * @returns {Promise<Object>} Processing summary
 */
async function vonageIngest(message, from, url, title, company) {
  const item = {
    source: 'vonage',
    received_at: new Date().toISOString(),
    url,
    title,
    company,
    raw: message,
    meta: {
      from,
      method: 'whatsapp_webhook'
    }
  };

  return await processIngest(item);
}

module.exports = {
  vonageIngest,
  // Export for testing
  _test: { vonageIngest }
};