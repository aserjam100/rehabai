const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Locked stack (CLAUDE.md): Gemma via Ollama, one place to swap the model name.
const GEMMA_MODEL = 'gemma4:e2b';
const GEMMA_URL = 'http://localhost:11434/api/generate';

const SENIOR_SYSTEM_PROMPT = `You are a warm exercise companion writing directly to the patient who just
finished their exercises. Speak in second person, short sentences, no
medical jargon, no raw numbers or degrees. Based only on the facts given,
mention one thing that went well and one gentle thing to work on. Never be
alarming. Three to four sentences, plain text only.`;

const CLINICIAN_SYSTEM_PROMPT = `You are summarizing an exercise adherence session for a clinician. Be
terse and clinical. Use the exact numbers and units given in the facts.
Output format: one short opening line stating the exercise and rep count,
then each remaining observation as its own bullet line starting with
"- ". Note any flagged asymmetry or range-of-motion drop greater than 15%
from the best rep as its own bullet. State observations only, no advice
or recommendations. Plain text only, no markdown besides the "- " bullet
markers.`;

async function callGemma(systemPrompt, userPrompt) {
  const res = await fetch(GEMMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GEMMA_MODEL,
      stream: false,
      think: false,
      system: systemPrompt,
      prompt: userPrompt,
    }),
  });
  const data = await res.json();
  return data.response;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Turns Gemma's plain text (paragraphs, plus optional "- " bullet lines)
// into real HTML markup instead of one dense wall of text.
function textToHtml(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  let html = '';
  let inList = false;
  for (const line of lines) {
    const isBullet = line.startsWith('- ') || line.startsWith('* ');
    if (isBullet && !inList) {
      html += '<ul>';
      inList = true;
    } else if (!isBullet && inList) {
      html += '</ul>';
      inList = false;
    }
    html += isBullet ? `<li>${escapeHtml(line.slice(2))}</li>` : `<p>${escapeHtml(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

function buildReportHtml(seniorText, clinicianText) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<title>RehabAI Report</title>
<style>
  body { font: 20px/1.6 sans-serif; background: #fff; color: #111; margin: 40px; }
  h1 { font-size: 32px; margin-bottom: 4px; }
  .columns { display: flex; gap: 40px; margin-top: 20px; }
  .column { flex: 1; border: 2px solid #111; padding: 20px; }
  .column p { margin: 0 0 14px; }
  .column ul { margin: 0 0 14px; padding-left: 24px; }
  .column li { margin-bottom: 8px; }
  h2 { font-size: 22px; margin-top: 0; }
  #printBtn {
    min-width: 200px;
    min-height: 80px;
    font: bold 24px sans-serif;
    background: #111;
    color: #fff;
    border: none;
    margin-top: 20px;
  }
  @media print {
    #printBtn { display: none; }
  }
</style>
</head>
<body>
  <h1>RehabAI Report</h1>
  <p>${new Date().toLocaleString()}</p>
  <div class="columns">
    <div class="column">
      <h2>For you</h2>
      ${textToHtml(seniorText)}
    </div>
    <div class="column">
      <h2>For the clinician</h2>
      ${textToHtml(clinicianText)}
    </div>
  </div>
  <button id="printBtn" onclick="window.print()">PRINT REPORT</button>
</body>
</html>`;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 1000,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });

  // Warm the model so the first real report call isn't paying cold-load cost.
  callGemma('', 'hi').catch(() => {});

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.handle('generate-report', async (event, formattedSummary) => {
  const [seniorText, clinicianText] = await Promise.all([
    callGemma(SENIOR_SYSTEM_PROMPT, formattedSummary),
    callGemma(CLINICIAN_SYSTEM_PROMPT, formattedSummary),
  ]);

  const html = buildReportHtml(seniorText, clinicianText);
  const filePath = path.join(os.tmpdir(), `rehab-report-${Date.now()}.html`);
  fs.writeFileSync(filePath, html);

  await event.sender.loadFile(filePath);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
