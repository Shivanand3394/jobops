const { processIngest } = require('../processIngest');

/**
 * Manual ingestion source - handles UI paste and manual entry
 * @param {string} url - Job URL
 * @param {string} title - Job title
 * @param {string} company - Company name
 * @param {string} raw - Raw content (optional)
 * @returns {Promise<Object>} Processing summary
 */
async function manualIngest(url, title, company, raw = null) {
  const item = {
    source: 'manual',
    received_at: new Date().toISOString(),
    url,
    title,
    company,
    raw,
    meta: { method: 'ui_paste' }
  };

  return await processIngest(item);
}

module.exports = {
  manualIngest,
  // Export for testing
  _test: { manualIngest }
};