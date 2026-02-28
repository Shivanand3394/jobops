const { canonicalizeUrl, dedupe, persistJob } = require('../shared/utils');

/**
 * Process and normalize job ingestion from any source
 * @param {Object} item - Standardized item from source adapter
 * @param {string} item.source - Source identifier (manual, vonage, gmail, rss)
 * @param {string} item.received_at - ISO timestamp when received
 * @param {string} item.url - Job URL
 * @param {string} item.title - Job title
 * @param {string} item.company - Company name
 * @param {string} item.raw - Raw content if available
 * @param {Object} item.meta - Additional metadata
 * @returns {Promise<Object>} Summary of processing results
 */
async function processIngest(itemOrItems) {
  // Support both single item and batch array
  const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
  
  if (items.length === 0) {
    return { inserted: 0, updated: 0, skipped: 0, errors: 0, total: 0 };
  }

  const results = await Promise.all(
    items.map(async (item) => {
      try {
        // Canonicalize URL
        const canonicalUrl = canonicalizeUrl(item.url);
        
        // Check for duplicates
        const isDuplicate = await dedupe(canonicalUrl);
        if (isDuplicate) {
          return { inserted: 0, updated: 0, skipped: 1, errors: 0 };
        }

        // Attempt JD resolution if available
        let jdResolved = false;
        try {
          const { resolveJobDescription } = require('../domains/resume/parser');
          if (resolveJobDescription) {
            const jd = await resolveJobDescription(canonicalUrl);
            if (jd) {
              item.raw = jd;
              jdResolved = true;
            }
          }
        } catch (e) {
          // JD resolution not available, continue without it
        }

        // Prepare job data for persistence
        const jobData = {
          source: item.source,
          received_at: item.received_at,
          url: canonicalUrl,
          title: item.title,
          company: item.company,
          raw: item.raw || null,
          meta: item.meta || {},
          status: jdResolved ? 'RESOLVED' : 'NEEDS_MANUAL_JD'
        };

        // Persist to D1
        const result = await persistJob(jobData);
        
        return {
          inserted: result.inserted ? 1 : 0,
          updated: result.updated ? 1 : 0,
          skipped: 0,
          errors: result.error ? 1 : 0
        };
      } catch (error) {
        console.error('Error processing ingest:', error);
        return { inserted: 0, updated: 0, skipped: 0, errors: 1 };
      }
    })
  );

  // Aggregate results
  const summary = results.reduce(
    (acc, r) => ({
      inserted: acc.inserted + r.inserted,
      updated: acc.updated + r.updated,
      skipped: acc.skipped + r.skipped,
      errors: acc.errors + r.errors
    }),
    { inserted: 0, updated: 0, skipped: 0, errors: 0 }
  );

  return { ...summary, total: items.length };
}

module.exports = {
  processIngest,
  // Export for testing
  _test: { canonicalizeUrl, dedupe, persistJob }
};