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

/**
 * Create items from manual JD submission (batch mode)
 * @param {Object} params - Manual JD parameters
 * @param {string} params.jobKey - Job key
 * @param {string} params.jdText - Cleaned JD text
 * @param {Object} params.existing - Existing job record
 * @param {Object} params.body - Original request body
 * @returns {Array<Object>} Array of item objects
 */
function createItemsFromManualJd({ jobKey, jdText, existing, body }) {
  const items = [];
  
  const item = {
    source: 'manual',
    received_at: new Date().toISOString(),
    url: existing?.job_url || '',
    title: existing?.role_title || '',
    company: existing?.company || '',
    raw: {
      jobKey: jobKey || '',
      jdText: jdText || '',
      body: body || {}
    },
    meta: {
      method: 'manual_jd',
      job_key: jobKey || null,
      existing_status: existing?.status || null
    }
  };
  items.push(item);
  
  return items;
}

module.exports = {
  manualIngest,
  createItemsFromManualJd,
  // Export for testing
  _test: { manualIngest, createItemsFromManualJd }
};