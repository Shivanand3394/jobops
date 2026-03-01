// worker/src/services/pdf.js

/**
 * Service to handle PDF generation via a Cloud Run (Puppeteer) service.
 * It sends the rendered HTML + CSS to the PDF factory.
 */
export class PdfService {
  constructor(env) {
    this.pdfServiceUrl = env.PDF_SERVICE_URL || 'http://localhost:8080'; // Set default or env var
    this.apiKey = env.PDF_SERVICE_API_KEY || ''; // If auth is needed
  }

  /**
   * Generates a PDF from HTML content.
   * @param {string} htmlContent - The full HTML string to be printed.
   * @param {object} options - PDF options (e.g., format, margins).
   * @returns {Promise<ArrayBuffer>} - The PDF file as an ArrayBuffer.
   */
  async generatePdf(htmlContent, options = {}) {
    const payload = {
      html: htmlContent,
      options: {
        printBackground: true,
        format: 'A4',
        margin: {
          top: '0.4in',
          right: '0.4in',
          bottom: '0.4in',
          left: '0.4in',
        },
        ...options
      }
    };

    try {
      const response = await fetch(`${this.pdfServiceUrl}/pdf`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`PDF Service failed: ${response.status} ${errorText}`);
      }

      return await response.arrayBuffer();
    } catch (error) {
      console.error('PDF Generation Error:', error);
      throw error;
    }
  }
}
