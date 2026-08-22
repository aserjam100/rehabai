const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// Locked stack (CLAUDE.md): Gemma via Ollama, one place to swap the model name.
const GEMMA_MODEL = 'gemma4:e2b';
const GEMMA_URL = 'http://localhost:11434/api/generate';
const OLLAMA_HEALTH_URL = 'http://localhost:11434/';

// Full names for Gemma's "respond only in X" instruction -- distinct from
// the native self-names used as UI button labels in i18n.js.
const GEMMA_LANGUAGE_NAMES = {
  en: 'English',
  ms: 'Malay (Bahasa Melayu)',
  ta: 'Tamil',
  zh: 'Mandarin Chinese (Simplified)',
};

// Small duplicate of the report-chrome subset of i18n.js -- main.js is
// CommonJS and renderer.js's i18n.js is an ES module for the browser, so
// sharing one file would need a bundler (locked stack forbids one).
const REPORT_STRINGS = {
  en: { title: 'RehabAI Report', forYou: 'For you', forClinician: 'For the clinician', print: 'PRINT REPORT', home: 'HOME' },
  ms: { title: 'Laporan RehabAI', forYou: 'Untuk anda', forClinician: 'Untuk doktor', print: 'CETAK LAPORAN', home: 'LAMAN UTAMA' },
  ta: { title: 'RehabAI அறிக்கை', forYou: 'உங்களுக்காக', forClinician: 'மருத்துவர்க்காக', print: 'அறிக்கையை அச்சிடு', home: 'முகப்பு' },
  zh: { title: '康复AI报告', forYou: '为您', forClinician: '给临床医生', print: '打印报告', home: '主页' },
};

// Small chrome dict for the cross-session flags digest page -- same
// separate-from-i18n.js reasoning as REPORT_STRINGS above (CommonJS vs.
// browser ES module, no bundler to share one file).
const FLAGS_STRINGS = {
  en: { title: 'Clinician Flags Digest', print: 'PRINT REPORT', home: 'HOME' },
  ms: { title: 'Ringkasan Isu Klinikal', print: 'CETAK LAPORAN', home: 'LAMAN UTAMA' },
  ta: { title: 'மருத்துவர் கவனிப்பு சுருக்கம்', print: 'அறிக்கையை அச்சிடு', home: 'முகப்பு' },
  zh: { title: '临床医生关注摘要', print: '打印报告', home: '主页' },
};

// Step 5: local JSON config -- greeting name + last session's rep count.
let CONFIG_PATH; // set once app.getPath is available (app.whenReady)

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config));
}

function resetConfig() {
  try {
    fs.unlinkSync(CONFIG_PATH);
  } catch {}
}

function seniorSystemPrompt(langName) {
  return `You are a warm exercise companion writing directly to the patient who just
finished their exercises. Speak in second person, short sentences, no
medical jargon, no raw numbers or degrees. Based only on the facts given,
mention one thing that went well and one gentle thing to work on. Never be
alarming. Three to four sentences. Respond only in ${langName}, plain text
only.`;
}

function clinicianSystemPrompt(langName) {
  return `You are summarizing an exercise adherence session for a clinician. Be
terse and clinical. Use the exact numbers and units given in the facts.
Output format: one short opening line stating the exercise and rep count,
then each remaining observation as its own bullet line starting with
"- ". Note any flagged asymmetry or range-of-motion drop greater than 15%
from the best rep as its own bullet. State observations only, no advice
or recommendations. Respond only in ${langName}, plain text only, no
markdown besides the "- " bullet markers.`;
}

function greetingSystemPrompt(langName) {
  return `You are a warm exercise companion greeting a patient who is about to
start their prescribed exercises. Based only on the facts given, greet
them by name, mention their last session's rep count encouragingly if
given, and ask if they're ready. One to two short sentences. Respond only
in ${langName}, plain text only, no other language mixed in.`;
}

function flagsDigestSystemPrompt(langName) {
  return `You are summarizing exercise adherence trends across MULTIPLE past sessions
for a clinician -- not a single session. Be terse and clinical. Use only
the exact numbers, units, and exercises given in the facts; do not invent
any trend, number, or exercise not present in the facts. Output format:
each observation as its own bullet line starting with "- ". If the facts
state that no pattern was identified, or that there isn't enough history
yet, output exactly one bullet saying so -- do not add anything else.
State observations only, no advice or recommendations. Respond only in
${langName}, plain text only, no markdown besides the "- " bullet
markers.`;
}

function progressSummarySystemPrompt(langName) {
  return `You caption a small chart of a patient's exercise session history for
them. Write exactly one short sentence (12 words or fewer) noting the
trend, warm and encouraging, second person. Based only on the facts
given -- do not invent numbers not given to you. No greeting, no
question, just the one observation. Respond only in ${langName}, plain
text only.`;
}

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

function buildReportHtml(seniorText, clinicianText, lang) {
  const s = REPORT_STRINGS[lang] || REPORT_STRINGS.en;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<title>${s.title}</title>
<style>
  body { font: 20px/1.6 sans-serif; background: #fff; color: #111; margin: 40px; }
  h1 { font-size: 32px; margin-bottom: 4px; }
  .columns { display: flex; gap: 40px; margin-top: 20px; }
  .column { flex: 1; border: 2px solid #111; padding: 20px; }
  .column p { margin: 0 0 14px; }
  .column ul { margin: 0 0 14px; padding-left: 24px; }
  .column li { margin-bottom: 8px; }
  h2 { font-size: 22px; margin-top: 0; }
  .actions { display: flex; gap: 20px; margin-top: 20px; }
  #printBtn, #homeBtn {
    min-width: 200px;
    min-height: 80px;
    font: bold 24px sans-serif;
    border: none;
    color: #fff;
  }
  #printBtn { background: #4a7c66; }
  #homeBtn { background: #2c3e42; }
  @media print {
    .actions { display: none; }
  }
</style>
</head>
<body>
  <h1>${s.title}</h1>
  <p>${new Date().toLocaleString()}</p>
  <div class="columns">
    <div class="column">
      <h2>${s.forYou}</h2>
      ${textToHtml(seniorText)}
    </div>
    <div class="column">
      <h2>${s.forClinician}</h2>
      ${textToHtml(clinicianText)}
    </div>
  </div>
  <div class="actions">
    <button id="printBtn" onclick="window.print()">${s.print}</button>
    <button id="homeBtn" onclick="window.rehabAPI.goHome()">${s.home}</button>
  </div>
</body>
</html>`;
}

// Single-column variant of buildReportHtml, above -- clinician-only, no
// senior-facing column since there's no "this session" to speak warmly
// about here.
function buildFlagsHtml(flagsText, lang) {
  const s = FLAGS_STRINGS[lang] || FLAGS_STRINGS.en;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<title>${s.title}</title>
<style>
  body { font: 20px/1.6 sans-serif; background: #fff; color: #111; margin: 40px; }
  h1 { font-size: 32px; margin-bottom: 4px; }
  .column { max-width: 700px; border: 2px solid #111; padding: 20px; margin-top: 20px; }
  .column p { margin: 0 0 14px; }
  .column ul { margin: 0 0 14px; padding-left: 24px; }
  .column li { margin-bottom: 8px; }
  .actions { display: flex; gap: 20px; margin-top: 20px; }
  #printBtn, #homeBtn {
    min-width: 200px;
    min-height: 80px;
    font: bold 24px sans-serif;
    border: none;
    color: #fff;
  }
  #printBtn { background: #4a7c66; }
  #homeBtn { background: #2c3e42; }
  @media print {
    .actions { display: none; }
  }
</style>
</head>
<body>
  <h1>${s.title}</h1>
  <p>${new Date().toLocaleString()}</p>
  <div class="column">
    ${textToHtml(flagsText)}
  </div>
  <div class="actions">
    <button id="printBtn" onclick="window.print()">${s.print}</button>
    <button id="homeBtn" onclick="window.rehabAPI.goHome()">${s.home}</button>
  </div>
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
  return win;
}

async function waitForOllamaHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(OLLAMA_HEALTH_URL);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// Demo-visible boot sequence: shows the greeting screen booting up "its"
// local AI instead of silently assuming Ollama is already running. Runs
// once per app launch, but the reset/HOME buttons reload index.html into
// the SAME window afterwards -- those reloads must not wait on a second
// round of push events that will never come again, so completion is also
// exposed as a pull-able promise (see `bootPromise` / 'await-boot' below).
let resolveBootPromise;
const bootPromise = new Promise((resolve) => {
  resolveBootPromise = resolve;
});

async function bootLocalAi(win) {
  win.webContents.send('boot-status', 'ollama');
  let healthy = await waitForOllamaHealthy(1500);
  if (!healthy) {
    try {
      spawn('ollama', ['serve'], { stdio: 'ignore', detached: true }).unref();
    } catch {}
    healthy = await waitForOllamaHealthy(20000);
  }

  win.webContents.send('boot-status', 'gemma');
  if (healthy) {
    // Warm the model so the first real call isn't paying cold-load cost.
    await callGemma('', 'hi').catch(() => {});
  }

  resolveBootPromise();
}

app.whenReady().then(() => {
  CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });

  const win = createWindow();
  bootLocalAi(win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.handle('await-boot', () => bootPromise);
ipcMain.handle('load-config', () => loadConfig());
ipcMain.handle('save-config', (event, config) => saveConfig(config));
ipcMain.handle('reset-config', () => resetConfig());
ipcMain.handle('go-home', (event) => event.sender.loadFile('index.html'));

ipcMain.handle('generate-greeting', async (event, factsText, lang) => {
  const langName = GEMMA_LANGUAGE_NAMES[lang] || GEMMA_LANGUAGE_NAMES.en;
  return callGemma(greetingSystemPrompt(langName), factsText);
});

ipcMain.handle('generate-progress-summary', async (event, factsText, lang) => {
  const langName = GEMMA_LANGUAGE_NAMES[lang] || GEMMA_LANGUAGE_NAMES.en;
  return callGemma(progressSummarySystemPrompt(langName), factsText);
});

ipcMain.handle('generate-report', async (event, formattedSummary, lang) => {
  const langName = GEMMA_LANGUAGE_NAMES[lang] || GEMMA_LANGUAGE_NAMES.en;
  const [seniorText, clinicianText] = await Promise.all([
    callGemma(seniorSystemPrompt(langName), formattedSummary),
    callGemma(clinicianSystemPrompt(langName), formattedSummary),
  ]);

  const html = buildReportHtml(seniorText, clinicianText, lang);
  const filePath = path.join(os.tmpdir(), `rehab-report-${Date.now()}.html`);
  fs.writeFileSync(filePath, html);

  await event.sender.loadFile(filePath);
});

ipcMain.handle('generate-flags-digest', async (event, factsText, lang) => {
  const langName = GEMMA_LANGUAGE_NAMES[lang] || GEMMA_LANGUAGE_NAMES.en;
  const flagsText = await callGemma(flagsDigestSystemPrompt(langName), factsText);

  const html = buildFlagsHtml(flagsText, lang);
  const filePath = path.join(os.tmpdir(), `rehab-flags-${Date.now()}.html`);
  fs.writeFileSync(filePath, html);

  await event.sender.loadFile(filePath);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
