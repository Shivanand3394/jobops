// worker/src/domains/resume/templates/classic.js

export function classicTemplate(resumeData) {
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
        @import url('https://fonts.googleapis.com/css2?family=Merriweather:ital,wght@0,300;0,400;0,700;1,300;1,400&family=Open+Sans:wght@300;400;600;700&display=swap');
        /* Embedded Tailwind Minimal */
        .max-w-4xl { max-width: 56rem; }
        .mx-auto { margin-left: auto; margin-right: auto; }
        .p-8 { padding: 2rem; }
        .bg-white { background-color: #ffffff; }
        .text-gray-900 { color: #111827; }
        .leading-relaxed { line-height: 1.625; }
        .border-b-2 { border-bottom-width: 2px; }
        .border-gray-800 { border-color: #1f2937; }
        .pb-4 { padding-bottom: 1rem; }
        .mb-6 { margin-bottom: 1.5rem; }
        .text-center { text-align: center; }
        .text-4xl { font-size: 2.25rem; line-height: 2.5rem; }
        .font-bold { font-weight: 700; }
        .uppercase { text-transform: uppercase; }
        .tracking-tight { letter-spacing: -0.025em; }
        .text-sm { font-size: 0.875rem; line-height: 1.25rem; }
        .mt-2 { margin-top: 0.5rem; }
        .text-gray-600 { color: #4b5563; }
        .text-blue-700 { color: #1d4ed8; }
        .text-lg { font-size: 1.125rem; line-height: 1.75rem; }
        .border-b { border-bottom-width: 1px; }
        .border-gray-300 { border-color: #d1d5db; }
        .mb-2 { margin-bottom: 0.5rem; }
        .mb-4 { margin-bottom: 1rem; }
        .flex { display: flex; }
        .justify-between { justify-content: space-between; }
        .text-md { font-size: 1rem; line-height: 1.5rem; }
        .italic { font-style: italic; }
        .text-gray-700 { color: #374151; }
        .list-disc { list-style-type: disc; }
        .list-inside { list-style-position: inside; }
        .mt-1 { margin-top: 0.25rem; }
        .text-gray-800 { color: #1f2937; }
        .gap-2 { gap: 0.5rem; }
        .flex-wrap { flex-wrap: wrap; }
        .bg-gray-100 { background-color: #f3f4f6; }
        .px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }
        .py-1 { padding-top: 0.25rem; padding-bottom: 0.25rem; }
        .text-xs { font-size: 0.75rem; line-height: 1rem; }
        .rounded { border-radius: 0.25rem; }
        .border { border-width: 1px; }
        .border-gray-200 { border-color: #e5e7eb; }
        
        body { font-family: 'Times New Roman', serif; margin: 0; padding: 0; }
        @page { size: auto; margin: 0.5in; }
      </style>
    </head>
    <body class="bg-white">
      <div class="max-w-4xl mx-auto p-8 text-gray-900 leading-relaxed">
        <header class="border-b-2 border-gray-800 pb-4 mb-6 text-center">
          <h1 class="text-4xl font-bold uppercase tracking-tight">${basics.name}</h1>
          <div class="text-sm mt-2 text-gray-600">
            ${[basics.email, basics.phone, basics.location?.city, basics.location?.region].filter(Boolean).join(' | ')}
          </div>
          ${basics.url ? `<div class="text-blue-700 text-sm mt-1">${basics.url}</div>` : ''}
        </header>

        <section class="mb-6">
          <h2 class="text-lg font-bold uppercase border-b border-gray-300 mb-2">Professional Summary</h2>
          <p class="text-sm">${basics.summary}</p>
        </section>

        <section class="mb-6">
          <h2 class="text-lg font-bold uppercase border-b border-gray-300 mb-2">Experience</h2>
          ${work.map(job => `
            <div class="mb-4">
              <div class="flex justify-between font-bold text-md">
                <span>${job.name}</span>
                <span>${job.startDate} — ${job.endDate || 'Present'}</span>
              </div>
              <div class="italic text-gray-700 text-sm">${job.position}</div>
              <ul class="list-disc list-inside mt-1 text-sm text-gray-800">
                ${(job.highlights || []).map(h => `<li>${h}</li>`).join('')}
              </ul>
            </div>
          `).join('')}
        </section>

        <section class="mb-6">
          <h2 class="text-lg font-bold uppercase border-b border-gray-300 mb-2">Education</h2>
          ${education.map(edu => `
            <div class="flex justify-between mb-2">
              <div>
                <span class="font-bold text-sm">${edu.institution}</span>, <span class="text-sm italic">${edu.area}</span>
              </div>
              <span class="text-sm">${edu.endDate}</span>
            </div>
          `).join('')}
        </section>

        <section>
          <h2 class="text-lg font-bold uppercase border-b border-gray-300 mb-2">Skills</h2>
          <div class="flex flex-wrap gap-2">
            ${skills.map(skill => `
              <span class="bg-gray-100 px-2 py-1 text-xs rounded border border-gray-200 font-medium">
                ${skill.name}${skill.keywords && skill.keywords.length ? ': ' + skill.keywords.join(', ') : ''}
              </span>
            `).join('')}
          </div>
        </section>
      </div>
    </body>
    </html>
  `;
}
