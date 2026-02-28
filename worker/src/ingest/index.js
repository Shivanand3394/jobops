// Export all ingestion sources and main processor
const processIngest = require('./processIngest');
const manual = require('./sources/manual');
const vonage = require('./sources/vonage');
const gmail = require('./sources/gmail');
const rss = require('./sources/rss');

module.exports = {
  processIngest,
  manual,
  vonage,
  gmail,
  rss,
  // Export all sources for convenience
  sources: {
    manual,
    vonage,
    gmail,
    rss
  }
};