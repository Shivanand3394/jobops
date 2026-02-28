import workerRuntime from "./worker.js";
import { generateResumePdf } from './domains/resume/api.js';
import { RESUME_PARSER_PROMPT } from './domains/resume/parser.js';
import * as domains from "./domains/index.js";

// [vars
export const PDF_SERVICE_URL = "https://your-cloud-run-url.run.app/pdf";
export const PDF_AUTH_KEY = "your-super-secret-key-123";

// Sprint A orchestrator entrypoint.
// Runtime behavior remains delegated to the existing worker implementation.
export { domains };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- NEW: RESUME PARSING ENDPOINT ---
    if (path === '/api/parse-resume' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (!body.resumeText) return new Response('Missing resumeText', { status: 400 });

        if (!env.GEMINI_API_KEY) {
           return new Response('Missing GEMINI_API_KEY env var', { status: 500 });
        }

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: RESUME_PARSER_PROMPT },
                { text: `RAW RESUME TEXT:\n${body.resumeText}` }
              ]
            }],
            generationConfig: { response_mime_type: "application/json" }
          })
        });

        if (!response.ok) {
           const errText = await response.text();
           return new Response(`Gemini API Error: ${errText}`, { status: response.status });
        }

        const result = await response.json();
        const candidateText = result.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        // Gemini returns escaped JSON string sometimes, but usually pure JSON in this mode.
        // We trust JSON.parse to handle the structure.
        return new Response(candidateText, {
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*' 
          }
        });
      } catch (err) {
        return new Response(`Parse failed: ${err.message}`, { status: 500 });
      }
    }

    // --- NEW: RESUME PDF GENERATION ENDPOINT ---
    if (path === '/api/generate-pdf' && request.method === 'POST') {
        try {
            const body = await request.json();
            const { resumeData, templateId } = body;
            
            if (!resumeData) return new Response('Missing resumeData', { status: 400 });

            // Call our internal API layer
            const pdfBuffer = await generateResumePdf(env, resumeData, templateId || 'modern');

            return new Response(pdfBuffer, {
                headers: {
                    'Content-Type': 'application/pdf',
                    'Content-Disposition': 'attachment; filename="resume.pdf"',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        } catch (err) {
            console.error(err);
            return new Response(`PDF Generation failed: ${err.message}`, { status: 500 });
        }
    }

    // Delegate to existing worker logic
    return workerRuntime.fetch(request, env, ctx);
  }
};

