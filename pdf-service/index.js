// pdf-service/index.js

const express = require('express');
const puppeteer = require('puppeteer');

const fs = require('fs');
const path = require('path');

const app = express();
const port = parseInt(process.env.PORT) || 8080;

app.use(express.json({ limit: '50mb' }));

// Read local CSS once at startup for performance
let tailwindCss = '';
try {
  tailwindCss = fs.readFileSync(path.join(__dirname, 'styles/tailwind_mini.css'), 'utf8');
  console.log('✅ Loaded local Tailwind CSS');
} catch (e) {
  console.warn('⚠️ Could not load local Tailwind CSS:', e.message);
}

app.post('/pdf', async (req, res) => {
  const { html, options = {} } = req.body;

  if (!html) {
    return res.status(400).send('Missing html content');
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // critical for container environments
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ]
    });

    const page = await browser.newPage();
    
    // Set content and wait for network idle to ensure fonts/images load
    await page.setContent(html, {
      waitUntil: 'networkidle0'
    });

    // Inject local styles if available
    if (tailwindCss) {
      await page.addStyleTag({ content: tailwindCss });
    }

    const pdfBuffer = await page.pdf({
      format: options.format || 'A4',
      printBackground: options.printBackground !== false, // default true
      margin: options.margin || {
        top: '0.4in',
        right: '0.4in',
        bottom: '0.4in',
        left: '0.4in'
      },
      ...options
    });

    await browser.close();
    browser = null;

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': pdfBuffer.length
    });
    
    res.send(pdfBuffer);

  } catch (err) {
    console.error('PDF Generation failed:', err);
    if (browser) {
      await browser.close();
    }
    res.status(500).send('Internal Server Error: ' + err.message);
  }
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(port, () => {
  console.log(`PDF Service listening on port ${port}`);
});
