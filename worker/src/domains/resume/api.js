import { ResumeEngine } from './engine.js';

/**
 * Orchestrates the PDF generation process:
 * 1. Hydrates the ResumeEngine with data.
 * 2. Renders the selected HTML template.
 * 3. Sends the HTML to the secure PDF Factory (GCP).
 * 
 * @param {Object} env - Worker environment variables (needs PDF_SERVICE_URL, PDF_AUTH_KEY).
 * @param {Object} resumeData - The resume content (JSON Resume schema).
 * @param {string} templateId - 'classic' or 'modern'.
 * @returns {Promise<ArrayBuffer>} - The raw PDF bytes.
 */
export async function generateResumePdf(env, resumeData, templateId = 'modern') {
  // 1. Initialize Engine with user data
  const engine = new ResumeEngine(resumeData);
  
  // Optional: Run validation and log warnings (non-blocking)
  const validation = engine.validate();
  if (!validation.isValid) {
    console.warn(`Resume validation warnings for PDF generation: ${validation.errors.join(', ')}`);
  }

  // 2. Render to HTML
  const html = engine.render(templateId);

  // 3. Send to GCP Factory with the Secret Key
  const serviceUrl = env.PDF_SERVICE_URL;
  if (!serviceUrl) {
    throw new Error("Missing env.PDF_SERVICE_URL");
  }

  const response = await fetch(serviceUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Send the shared secret key for authentication
      'Authorization': `Bearer ${env.PDF_AUTH_KEY || ''}` 
    },
    body: JSON.stringify({ html })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`PDF Factory failed (${response.status}): ${errText}`);
  }

  // 4. Return the raw PDF
  return await response.arrayBuffer();
}
