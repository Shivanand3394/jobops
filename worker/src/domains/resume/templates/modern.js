// worker/src/domains/resume/templates/modern.js

export function modernTemplate(resumeData) {
  const basics = resumeData.basics || {};
  const work = resumeData.work || [];
  const education = resumeData.education || [];
  const skills = resumeData.skills || [];

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>${basics.name || 'Resume'}</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&family=Lato:wght@300;400;700&display=swap');
        
        /* Minimal Tailwind Replacement */
        .flex { display: flex; }
        .min-h-screen { min-height: 100vh; }
        .bg-white { background-color: white; }
        .bg-gray-50 { background-color: #f9fafb; }
        .w-1\\/3 { width: 33.333333%; }
        .w-2\\/3 { width: 66.666667%; }
        .p-8 { padding: 2rem; }
        .border-r { border-right-width: 1px; }
        .border-gray-200 { border-color: #e5e7eb; }
        .mb-8 { margin-bottom: 2rem; }
        .mb-10 { margin-bottom: 2.5rem; }
        .mb-3 { margin-bottom: 0.75rem; }
        .mb-4 { margin-bottom: 1rem; }
        .mb-6 { margin-bottom: 1.5rem; }
        .mb-2 { margin-bottom: 0.5rem; }
        .pb-1 { padding-bottom: 0.25rem; }
        .text-3xl { font-size: 1.875rem; line-height: 2.25rem; }
        .font-extrabold { font-weight: 800; }
        .text-gray-900 { color: #111827; }
        .leading-tight { line-height: 1.25; }
        .text-md { font-size: 1rem; line-height: 1.5rem; }
        .text-blue-600 { color: #2563eb; }
        .font-medium { font-weight: 500; }
        .text-xs { font-size: 0.75rem; line-height: 1rem; }
        .font-bold { font-weight: 700; }
        .uppercase { text-transform: uppercase; }
        .tracking-widest { letter-spacing: 0.1em; }
        .text-gray-500 { color: #6b7280; }
        .text-sm { font-size: 0.875rem; line-height: 1.25rem; }
        .space-y-2 > :not([hidden]) ~ :not([hidden]) { margin-top: 0.5rem; }
        .space-y-1 > :not([hidden]) ~ :not([hidden]) { margin-top: 0.25rem; }
        .text-gray-700 { color: #374151; }
        .flex-wrap { flex-wrap: wrap; }
        .gap-2 { gap: 0.5rem; }
        .px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }
        .py-1 { padding-top: 0.25rem; padding-bottom: 0.25rem; }
        .border { border-width: 1px; }
        .rounded-md { border-radius: 0.375rem; }
        .shadow-sm { box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); }
        .text-xl { font-size: 1.25rem; line-height: 1.75rem; }
        .border-b-2 { border-bottom-width: 2px; }
        .border-blue-600 { border-color: #2563eb; }
        .justify-between { justify-content: space-between; }
        .items-baseline { align-items: baseline; }
        .text-gray-800 { color: #1f2937; }
        .text-lg { font-size: 1.125rem; line-height: 1.75rem; }
        .font-semibold { font-weight: 600; }
        .text-blue-700 { color: #1d4ed8; }
        .list-disc { list-style-type: disc; }
        .list-outside { list-style-position: outside; }
        .ml-4 { margin-left: 1rem; }
        .text-gray-600 { color: #4b5563; }
        
        body { font-family: 'Roboto', sans-serif; margin: 0; padding: 0; background-color: #ffffff; }
        @page { size: auto; margin: 0; } /* Remove print margins for full bleed sidebar */
      </style>
    </head>
    <body>
      <div class="flex min-h-screen bg-white">
        <!-- Sidebar -->
        <aside class="w-1/3 bg-gray-50 p-8 border-r border-gray-200">
          <div class="mb-8">
            <h1 class="text-3xl font-extrabold text-gray-900 leading-tight">${basics.name}</h1>
            <p class="text-md text-blue-600 font-medium">${basics.label || ''}</p>
          </div>
          
          <section class="mb-8">
            <h2 class="text-xs font-bold uppercase tracking-widest text-gray-500 mb-3">Contact</h2>
            <div class="text-sm space-y-2 text-gray-700">
              <p>${basics.email}</p>
              <p>${basics.phone}</p>
              <p>${basics.location?.city}, ${basics.location?.region}</p>
              ${basics.url ? `<p><a href="${basics.url}" class="text-blue-600 no-underline">${basics.url.replace(/^https?:\/\//, '')}</a></p>` : ''}
            </div>
          </section>
          
          <section>
            <h2 class="text-xs font-bold uppercase tracking-widest text-gray-500 mb-3">Skills</h2>
            <div class="flex flex-wrap gap-2">
              ${skills.map(s => `
                <span class="px-2 py-1 bg-white border border-gray-200 text-xs rounded-md shadow-sm font-medium text-gray-700">
                  ${s.name}
                </span>
              `).join('')}
            </div>
          </section>
        </aside>

        <!-- Main Content -->
        <main class="w-2/3 p-8">
          ${basics.summary ? `
            <section class="mb-10">
               <h2 class="text-xl font-bold text-gray-900 border-b-2 border-blue-600 pb-1 mb-4">Summary</h2>
               <p class="text-sm text-gray-700 leading-relaxed">${basics.summary}</p>
            </section>
          ` : ''}

          <section class="mb-10">
            <h2 class="text-xl font-bold text-gray-900 border-b-2 border-blue-600 pb-1 mb-4">Experience</h2>
            ${work.map(job => `
              <div class="mb-6">
                <div class="flex justify-between items-baseline">
                  <h3 class="font-bold text-gray-800 text-lg">${job.name}</h3>
                  <span class="text-xs font-semibold text-gray-500">${job.startDate} — ${job.endDate || 'Present'}</span>
                </div>
                <p class="text-sm font-medium text-blue-700 mb-2">${job.position}</p>
                <ul class="list-disc list-outside ml-4 text-sm text-gray-600 space-y-1">
                  ${(job.highlights || []).map(h => `<li>${h}</li>`).join('')}
                </ul>
              </div>
            `).join('')}
          </section>

          <section>
            <h2 class="text-xl font-bold text-gray-900 border-b-2 border-blue-600 pb-1 mb-4">Education</h2>
            ${education.map(edu => `
              <div class="mb-4">
                <h3 class="font-bold text-gray-800">${edu.institution}</h3>
                <p class="text-sm text-gray-600">${edu.area} — ${edu.studyType} | ${edu.endDate}</p>
              </div>
            `).join('')}
        </section>
        </main>
      </div>
    </body>
    </html>
  `;
}
