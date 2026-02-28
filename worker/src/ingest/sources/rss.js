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

/**
 * Create items from RSS poll data (batch mode)
 * @param {Object} env - Environment bindings
 * @param {Object} rssData - Result from runRssPoll_
 * @returns {Array<Object>} Array of item objects
 */
function createItemsFromPoll(env, rssData) {
  const items = [];
  if (!rssData || !Array.isArray(rssData.items)) return items;
  
  for (const item of rssData.items) {
    const ingestItem = {
      source: 'rss',
      received_at: new Date().toISOString(),
      url: item.url || item.link || '',
      title: item.title || '',
      company: item.company || '',
      raw: {
        feedUrl: item.feedUrl || item.feed_url || '',
        description: item.description || item.content || item.summary || ''
      },
      meta: {
        method: 'rss_poll',
        feed_title: item.feedTitle || item.feed_title || null,
        published: item.published || item.pubDate || null
      }
    };
    items.push(ingestItem);
  }
  return items;
}

module.exports = {
  rssIngest,
  createItemsFromPoll,
  // Export for testing
  _test: { rssIngest, createItemsFromPoll }
};