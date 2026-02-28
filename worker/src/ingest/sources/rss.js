const { processIngest } = require('../processIngest');

/**
 * RSS ingestion source - handles RSS feed items
 * @param {string} feedUrl - URL of the RSS feed
 * @param {string} itemUrl - URL of the RSS item
 * @param {string} title - RSS item title
 * @param {string} description - RSS item description
 * @param {string} company - Company name extracted from RSS
 * @returns {Promise<Object>} Processing summary
 */
async function rssIngest(feedUrl, itemUrl, title, description, company) {
  const item = {
    source: 'rss',
    received_at: new Date().toISOString(),
    url: itemUrl,
    title,
    company,
    raw: {
      feedUrl,
      description
    },
    meta: {
      method: 'rss_poll'
    }
  };

  return await processIngest(item);
}

module.exports = {
  rssIngest,
  // Export for testing
  _test: { rssIngest }
};