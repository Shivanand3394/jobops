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

/**
 * Create items from Vonage webhook payload (batch mode)
 * @param {Object} params - Webhook parameters
 * @param {Object} params.body - Parsed webhook body
 * @param {string} params.rawBody - Raw webhook body string
 * @param {string} params.messageId - Message UUID
 * @param {string} params.sender - Sender phone number
 * @param {string} params.mediaUrl - Media URL if present
 * @param {boolean} params.mediaDetected - Whether media was detected
 * @param {string} params.mediaCaption - Media caption text
 * @param {Object} params.env - Environment bindings
 * @returns {Array<Object>} Array of item objects
 */
function createItemsFromWebhook({ body, rawBody, messageId, sender, mediaUrl, mediaDetected, mediaCaption, env }) {
  const items = [];
  
  // Extract text content from body
  const messageText = String(body?.text || body?.message || body?.body || '').trim();
  const messageSubject = String(body?.subject || '').trim();
  
  if (messageText || messageSubject) {
    const item = {
      source: 'vonage',
      received_at: new Date().toISOString(),
      url: mediaUrl || '',
      title: messageSubject || 'WhatsApp Job Lead',
      company: '',
      raw: {
        message: messageText,
        from: sender || '',
        messageId: messageId || '',
        rawBody: rawBody || '',
        media_detected: mediaDetected || false,
        media_caption: mediaCaption || ''
      },
      meta: {
        method: 'whatsapp_webhook',
        provider: 'vonage',
        media_url: mediaUrl || null
      }
    };
    items.push(item);
  }
  
  return items;
}

module.exports = {
  vonageIngest,
  createItemsFromWebhook,
  // Export for testing
  _test: { vonageIngest, createItemsFromWebhook }
};