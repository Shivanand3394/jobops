// Simple frontend logic
async function parseResume() {
    const text = document.getElementById('rawResume').value;
    if (!text) {
        alert("Please paste resume text first!");
        return;
    }

    const btn = document.getElementById('parseBtn');
    btn.textContent = "Parsing...";
    btn.disabled = true;

    try {
        const response = await fetch('/api/parse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resumeText: text })
        });

        if (!response.ok) throw new Error(await response.text());

        const data = await response.json();
        document.getElementById('jsonOutput').value = JSON.stringify(data, null, 2);
        
        // Enable print button
        const printBtn = document.getElementById('printBtn');
        printBtn.disabled = false;
        printBtn.onclick = () => generatePdf(data);
    } catch (err) {
        alert("Error parsing resume: " + err.message);
    } finally {
        btn.textContent = "✨ Parse with Gemini";
        btn.disabled = false;
    }
}

async function generatePdf(resumeData) {
    const templateId = document.getElementById('templateSelect').value;
    const btn = document.getElementById('printBtn');
    btn.textContent = "Generating PDF...";
    btn.disabled = true;

    try {
        const response = await fetch('/api/print', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resumeData, templateId })
        });

        if (!response.ok) throw new Error(await response.text());

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `resume-${templateId}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    } catch (err) {
        alert("Error generating PDF: " + err.message);
    } finally {
        btn.textContent = "📄 Download PDF";
        btn.disabled = false;
    }
}
