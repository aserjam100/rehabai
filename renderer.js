import {
  PoseLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
import { LANGUAGES, LANGUAGE_NAMES, STRINGS } from "./i18n.js";

// BCP-47 tags so speechSynthesis picks a matching voice where the OS has one.
const SPEECH_LANG = { en: 'en-US', ms: 'ms-MY', ta: 'ta-IN', zh: 'zh-CN' };

// Bone list: pairs of landmark indices in the BlazePose 33-point topology.
// Face/hand fine detail is skipped -- torso and limbs are enough for a
// recognizable stick figure and for rep-counting angle math later.
const BONES = [
  [11, 12],
  [11, 13], [13, 15],
  [12, 14], [14, 16],
  [11, 23], [12, 24],
  [23, 24],
  [23, 25], [25, 27],
  [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31],
  [28, 30], [30, 32], [28, 32],
];

const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const stage = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const dashboardEl = document.getElementById('dashboard');
const stopBtn = document.getElementById('stopBtn');
const exerciseScreenEl = document.getElementById('exerciseScreen');
const greetingEl = document.getElementById('greeting');
const greetingTextEl = document.getElementById('greetingText');
const nameInputEl = document.getElementById('nameInput');
const startBtn = document.getElementById('startBtn');
const replayBtn = document.getElementById('replayBtn');
const resetBtn = document.getElementById('resetBtn');
const langToggleBtn = document.getElementById('langToggleBtn');
const langChoiceEl = document.getElementById('languageChoice');
const langOptionButtons = Array.from(document.querySelectorAll('.langOption'));
const subPromptEl = document.getElementById('subPrompt');
const ageChoiceEl = document.getElementById('ageChoice');
const ageOptionButtons = Array.from(document.querySelectorAll('.ageOption'));
const progressSectionEl = document.getElementById('progressSection');
const progressLabelEl = document.getElementById('progressLabel');
const progressExerciseEl = document.getElementById('progressExercise');
const progressCanvas = document.getElementById('progressCanvas');
const progressCaptionEl = document.getElementById('progressCaption');
const demoPanelEl = document.getElementById('demoPanel');
const demoIdleImg = document.getElementById('demoIdle');
const demoRightImg = document.getElementById('demoRight');
const demoLeftImg = document.getElementById('demoLeft');
const demoIdleLabelEl = document.getElementById('demoIdleLabel');
const demoRightLabelEl = document.getElementById('demoRightLabel');
const demoLeftLabelEl = document.getElementById('demoLeftLabel');

let poseLandmarker;
let lastVideoTime = -1;
let mediaStream = null;
let running = true;

// --- Step 5: greeting, local config, reset, language ---
let userConfig = null;
let greetingSpeechText = '';
let lang = 'en';
let selectedAge = null; // 'under60' | '60-69' | '70-79' | '80+', onboarding-only

function t(key) {
  return (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key];
}

// Voice names known to sound natural for a given language, preferred over
// whatever speechSynthesis would otherwise pick implicitly -- with no voice
// set explicitly, Chromium falls back to the OS's configured "default"
// voice, which on macOS is often a dated, robotic-sounding one (e.g. "Fred")
// rather than a good native voice like "Samantha". Naming a voice explicitly
// fixes that; language-lang matching below is the fallback where none of
// these are installed.
const PREFERRED_VOICE_NAMES = {
  en: ['Samantha', 'Google US English', 'Ava', 'Zoe', 'Alex'],
  ms: [],
  ta: [],
  zh: ['Google 普通话（中国大陆）', 'Ting-Ting', 'Tingting'],
};

// getVoices() can return an empty list on the very first call -- the OS
// voice list loads asynchronously. Cache the (eventually non-empty) list
// behind one promise instead of re-querying on every speak() call.
let voicesPromise = null;
function loadVoices() {
  if (voicesPromise) return voicesPromise;
  voicesPromise = new Promise((resolve) => {
    const existing = window.speechSynthesis.getVoices();
    if (existing.length) {
      resolve(existing);
      return;
    }
    window.speechSynthesis.onvoiceschanged = () => resolve(window.speechSynthesis.getVoices());
  });
  return voicesPromise;
}

function pickVoice(voices, bcp47) {
  for (const name of PREFERRED_VOICE_NAMES[lang] || []) {
    const match = voices.find((v) => v.name === name);
    if (match) return match;
  }
  const prefix = bcp47.split('-')[0];
  return voices.find((v) => v.lang === bcp47) || voices.find((v) => v.lang.startsWith(prefix)) || null;
}

async function speak(text) {
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const target = SPEECH_LANG[lang] || 'en-US';
  utterance.lang = target;
  const voice = pickVoice(await loadVoices(), target);
  if (voice) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
}

// Updates all fixed (non-Gemma) chrome text to the current language.
function applyStaticStrings() {
  startBtn.textContent = t('start');
  stopBtn.textContent = t('stop');
  nameInputEl.placeholder = t('namePlaceholder');
  langToggleBtn.textContent = LANGUAGE_NAMES[lang];
  langOptionButtons.forEach((b) => b.classList.toggle('selected', b.dataset.lang === lang));
  subPromptEl.textContent = t('agePrompt');
  ageOptionButtons.forEach((b) => b.classList.toggle('selected', b.dataset.age === selectedAge));
  progressLabelEl.textContent = t('progress');
  demoIdleLabelEl.textContent = t('demoSitting');
  demoRightLabelEl.textContent = t('demoRightLeg');
  demoLeftLabelEl.textContent = t('demoLeftLeg');
  // Only the still-onboarding "what's your name" screen is static text;
  // once a name exists, greetingTextEl holds Gemma's generated greeting.
  if (nameInputEl.style.display === 'block') {
    greetingTextEl.textContent = t('namePrompt');
  }
}

// --- History surface: small canvas bar chart of rep counts across recent
// sessions (see CLAUDE.md's documented "no charts" exception). Plain
// canvas, same approach as the pose overlay -- no charting library.
// Labelled explicitly (axis tag, per-bar date) since a bare set of bars
// with no context doesn't convey what's being measured. ---
function formatShortDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// One color per exercise so a mixed-history chart (once Step 7 adds the
// other two exercises) reads as "which exercise" at a glance, not just
// "how many reps". Fixed map, not computed -- CLAUDE.md caps this app at
// exactly three exercises, so there's no arbitrary-N case to handle.
const EXERCISE_COLORS = {
  'Seated Knee Extension': '#4a7c66', // existing accent green
  'Seated Arm Raise': '#c97a5a',      // matches the landmark-dot color in draw()
  'Sit-to-Stand': '#5a7ca0',
};
const DEFAULT_EXERCISE_COLOR = '#4a7c66';
function exerciseColor(name) {
  return EXERCISE_COLORS[name] || DEFAULT_EXERCISE_COLOR;
}

// Legend: only needed once more than one exercise shows up in the recent
// window -- a single exercise is already named in plain text, a colored
// dot next to just one name would be noise.
function renderProgressLegend(exerciseNames) {
  progressExerciseEl.innerHTML = '';
  if (exerciseNames.length <= 1) {
    progressExerciseEl.textContent = exerciseNames[0] || '';
    return;
  }
  exerciseNames.forEach((name) => {
    const item = document.createElement('span');
    item.style.display = 'inline-flex';
    item.style.alignItems = 'center';
    item.style.gap = '4px';
    item.style.marginRight = '10px';
    const dot = document.createElement('span');
    dot.style.width = '10px';
    dot.style.height = '10px';
    dot.style.borderRadius = '50%';
    dot.style.background = exerciseColor(name);
    item.appendChild(dot);
    item.appendChild(document.createTextNode(name));
    progressExerciseEl.appendChild(item);
  });
}

function drawProgressChart(history) {
  const ctx2 = progressCanvas.getContext('2d');
  const w = progressCanvas.width, h = progressCanvas.height;
  ctx2.clearRect(0, 0, w, h);

  const recent = history.slice(-3);
  const maxReps = Math.max(...recent.map((s) => s.reps), 1);
  const paddingSide = 20;
  const paddingTop = 34;    // room for the "REPS" axis tag + value labels
  const paddingBottom = 30; // room for the per-bar date label
  const barGap = 14;
  const barW = (w - paddingSide * 2 - barGap * (recent.length - 1)) / recent.length;
  const chartH = h - paddingTop - paddingBottom;

  ctx2.textAlign = 'left';
  ctx2.fillStyle = '#7a8785';
  ctx2.font = 'bold 12px sans-serif';
  ctx2.fillText(t('reps'), paddingSide, 16);

  ctx2.textAlign = 'center';
  recent.forEach((session, i) => {
    const barH = (session.reps / maxReps) * chartH;
    const x = paddingSide + i * (barW + barGap);
    const y = h - paddingBottom - barH;
    ctx2.fillStyle = exerciseColor(session.exercise);
    ctx2.fillRect(x, y, barW, barH);
    ctx2.fillStyle = '#2c3e42';
    ctx2.font = 'bold 15px sans-serif';
    ctx2.fillText(String(session.reps), x + barW / 2, y - 8);
    ctx2.font = '12px sans-serif';
    ctx2.fillText(formatShortDate(session.date), x + barW / 2, h - paddingBottom + 16);
  });
}

// Step 5 + language brainstorm: JS computes the facts (name, last rep
// count), Gemma only supplies warm tone and the target language -- same
// "JS interprets, Gemma tones" split used for the end-of-session report.
async function showPersonalizedGreeting() {
  replayBtn.style.display = 'none';
  greetingTextEl.textContent = '...';

  const history = userConfig.sessionHistory || [];
  const lastSession = history[history.length - 1];
  const showProgress = history.length >= 1;

  progressSectionEl.style.display = showProgress ? 'flex' : 'none';
  if (showProgress) {
    drawProgressChart(history);
    const recent = history.slice(-3);
    renderProgressLegend([...new Set(recent.map((s) => s.exercise))]);
    progressCaptionEl.textContent = '...';
  }

  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const facts = `Patient name: ${userConfig.name}. Time of day: ${timeOfDay}.` +
    (lastSession
      ? ` Last session they completed ${lastSession.reps} reps.`
      : ' This is their first session.');

  const greetingPromise = window.rehabAPI.generateGreeting(facts, lang)
    .catch(() => `${userConfig.name}. ${t('readyToday')}`);

  // Dedicated call so the chart gets its own caption instead of overloading
  // the spoken greeting with trend commentary too -- same JS-computes-facts/
  // Gemma-supplies-tone split as everywhere else Gemma is used, just scoped
  // to the chart's own facts (dates, reps, exercise) rather than raw numbers.
  let progressPromise = Promise.resolve('');
  if (showProgress) {
    const recent = history.slice(-3);
    const repsList = recent.map((s) => s.reps).join(', ');
    const trend = recent[recent.length - 1].reps > recent[0].reps
      ? 'improving'
      : recent[recent.length - 1].reps < recent[0].reps
        ? 'declining'
        : 'steady';
    const progressFacts = `Exercise: ${[...new Set(recent.map((s) => s.exercise))].join(', ')}. ` +
      `Rep counts for the last ${recent.length} sessions, oldest to newest: ${repsList} ` +
      `(an ${trend} trend).`;
    progressPromise = window.rehabAPI.generateProgressSummary(progressFacts, lang)
      .catch(() => `${trend === 'improving' ? '+' : trend === 'declining' ? '-' : '~'} ${recent[0].reps} to ${recent[recent.length - 1].reps} reps.`);
  }

  const [greetingResult, progressResult] = await Promise.all([greetingPromise, progressPromise]);
  greetingSpeechText = greetingResult;
  if (showProgress) progressCaptionEl.textContent = progressResult.trim();

  greetingTextEl.textContent = greetingSpeechText;
  replayBtn.style.display = 'inline-block';
  speak(greetingSpeechText);
}

async function initGreeting() {
  userConfig = await window.rehabAPI.loadConfig();
  lang = (userConfig && userConfig.lang) || 'en';
  applyStaticStrings();

  if (!userConfig || !userConfig.name) {
    nameInputEl.style.display = 'block';
    langChoiceEl.style.display = 'flex';
    subPromptEl.style.display = 'block';
    ageChoiceEl.style.display = 'flex';
    replayBtn.style.display = 'none';
    greetingTextEl.textContent = t('namePrompt');
    return;
  }

  nameInputEl.style.display = 'none';
  langChoiceEl.style.display = 'none';
  subPromptEl.style.display = 'none';
  ageChoiceEl.style.display = 'none';
  await showPersonalizedGreeting();
}

startBtn.addEventListener('click', async () => {
  if (!userConfig || !userConfig.name) {
    const name = nameInputEl.value.trim();
    if (!name) {
      nameInputEl.focus();
      return;
    }
    if (!selectedAge) return;
    userConfig = { name, lang, ageRange: selectedAge, sessionHistory: [] };
    await window.rehabAPI.saveConfig(userConfig);
  }
  greetingEl.style.display = 'none';
  exerciseScreenEl.style.display = 'contents';
  init();
});

replayBtn.addEventListener('click', () => speak(greetingSpeechText));

ageOptionButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedAge = btn.dataset.age;
    applyStaticStrings();
  });
});

resetBtn.addEventListener('click', async () => {
  await window.rehabAPI.resetConfig();
  location.reload();
});

langOptionButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    lang = btn.dataset.lang;
    applyStaticStrings();
  });
});

langToggleBtn.addEventListener('click', async () => {
  const idx = LANGUAGES.indexOf(lang);
  lang = LANGUAGES[(idx + 1) % LANGUAGES.length];
  if (userConfig) {
    userConfig.lang = lang;
    await window.rehabAPI.saveConfig(userConfig);
  }
  applyStaticStrings();
  // Re-fetch the greeting in the new language, but only pre-exercise --
  // never call Gemma once the camera loop is running (see CLAUDE.md).
  if (greetingEl.style.display !== 'none' && userConfig && userConfig.name) {
    await showPersonalizedGreeting();
  }
});

// --- Step 2: seated knee extension, alternating legs ---
const LEGS = {
  right: { hip: 24, knee: 26, ankle: 28 },
  left: { hip: 23, knee: 25, ankle: 27 },
};
const POSITION_LANDMARKS = [11, 12, 23, 24, 25, 26, 27, 28];
const VISIBILITY_THRESHOLD = 0.5;
const POSITION_HOLD_MS = 2000;
const COUNTDOWN_MS = 3000;
// Camera angle changes what a bent knee's 2D projected angle reads as (see
// CLAUDE.md: 2D-only, no z), so the up/down thresholds are calibrated per
// session from the actual rest angle measured during the position hold,
// rather than hardcoded. HYSTERESIS_MARGIN sets the gap between them. One
// shared threshold for both legs (calibrated from whichever leg reads
// higher during the hold) rather than separate per-leg calibration --
// keeps the tuned-and-verified single-leg calibration approach intact
// instead of introducing a second untested source of jitter.
const HYSTERESIS_MARGIN = 10;    // degrees below the calibrated rest ceiling for the down-reset
const DEFAULT_UP_THRESHOLD = 145; // fallback if calibration somehow produced nothing

let appState = 'positioning'; // 'positioning' | 'countdown' | 'active'
let positionStableSince = null;
let countdownStart = null;
let restAngleMax = null;
let kneeUpThreshold = null;
let kneeDownThreshold = null;
let activeSide = 'right'; // alternates after every completed rep
let repState = 'down';
let repCount = 0;
let currentAngle = null;

function legAngle(landmarks, side) {
  const l = LEGS[side];
  return angleDegrees(landmarks[l.hip], landmarks[l.knee], landmarks[l.ankle]);
}

// --- Exercise demonstration images (replaces Step 6's planned webcam-
// keyframe stick figure -- see CLAUDE.md). Static assets the user supplies
// externally; this file only references a fixed local path per exercise
// state. Falls back to a plain labelled placeholder box until the real
// file is dropped in, so the app runs and looks reasonable either way. ---
const EXERCISE_IMAGES = {
  idle: 'assets/exercises/knee-extension-sitting.png',
  right: 'assets/exercises/knee-extension-right.png',
  left: 'assets/exercises/knee-extension-left.png',
};

function placeholderImage(label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="130" height="130">` +
    `<rect width="130" height="130" fill="#f4f1ea"/>` +
    `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="15" font-weight="bold" fill="#2c3e42">${label}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function setupDemoImage(imgEl, path, fallbackLabel) {
  imgEl.addEventListener('error', () => {
    imgEl.src = placeholderImage(fallbackLabel);
  }, { once: true });
  imgEl.src = path;
}

setupDemoImage(demoIdleImg, EXERCISE_IMAGES.idle, 'SITTING');
setupDemoImage(demoRightImg, EXERCISE_IMAGES.right, 'RIGHT LEG');
setupDemoImage(demoLeftImg, EXERCISE_IMAGES.left, 'LEFT LEG');

function updateDemoPanel() {
  const visible = appState === 'positioning' || appState === 'countdown' || appState === 'active';
  demoPanelEl.style.display = visible ? 'flex' : 'none';
  if (!visible) return;
  demoIdleImg.classList.toggle('highlight', appState !== 'active');
  demoRightImg.classList.toggle('highlight', appState === 'active' && activeSide === 'right');
  demoLeftImg.classList.toggle('highlight', appState === 'active' && activeSide === 'left');
}

// --- Step 3: dashboard + session log ---
const sessionLog = []; // { n, minAngle, maxAngle, durationSec }
let bestAngle = null;
let formStatus = '--';
let repStartTime = null;
let currentRepMinAngle = null;
let currentRepMaxAngle = null;

function angleDegrees(a, b, c) {
  // angle at b formed by a-b-c, using x/y/z.
  // Deliberate deviation from CLAUDE.md's "ignore z" rule: at steep webcam
  // lid angles (~80-90 degrees), the thigh foreshortens in the 2D
  // projection and bent vs. straight becomes indistinguishable no matter
  // how thresholds are tuned. z restores the depth component that carries
  // that information. Still three landmarks, still one dot product, still
  // no classifier -- only the vector dimensionality changed.
  const v1x = a.x - b.x, v1y = a.y - b.y, v1z = a.z - b.z;
  const v2x = c.x - b.x, v2y = c.y - b.y, v2z = c.z - b.z;
  const mag1 = Math.hypot(v1x, v1y, v1z);
  const mag2 = Math.hypot(v2x, v2y, v2z);
  if (mag1 === 0 || mag2 === 0) return null;
  const dot = v1x * v2x + v1y * v2y + v1z * v2z;
  const cos = Math.min(1, Math.max(-1, dot / (mag1 * mag2)));
  return Math.acos(cos) * (180 / Math.PI);
}

function isPositioned(landmarks) {
  for (const i of POSITION_LANDMARKS) {
    const p = landmarks[i];
    if (!p || (p.visibility ?? 0) < VISIBILITY_THRESHOLD) return false;
  }
  return true;
}

function updateExercise(landmarks, now) {
  if (appState === 'positioning') {
    if (landmarks && isPositioned(landmarks)) {
      if (positionStableSince === null) {
        positionStableSince = now;
        restAngleMax = null; // fresh calibration for this hold
      }
      // Calibrate from whichever leg reads higher this frame -- one shared
      // threshold covers both legs (see const block above).
      const rightAngle = legAngle(landmarks, 'right');
      const leftAngle = legAngle(landmarks, 'left');
      const angle = Math.max(rightAngle ?? -Infinity, leftAngle ?? -Infinity);
      if (angle !== -Infinity) {
        restAngleMax = restAngleMax === null ? angle : Math.max(restAngleMax, angle);
      }
      if (now - positionStableSince >= POSITION_HOLD_MS) {
        appState = 'countdown';
        countdownStart = now;
      }
    } else {
      positionStableSince = null;
    }
    return;
  }

  if (appState === 'countdown') {
    if (now - countdownStart >= COUNTDOWN_MS) {
      appState = 'active';
      repCount = 0;
      activeSide = 'right'; // always starts on the right leg
      kneeUpThreshold = restAngleMax !== null ? restAngleMax : DEFAULT_UP_THRESHOLD;
      kneeDownThreshold = kneeUpThreshold - HYSTERESIS_MARGIN;
      // Start from whichever side of the range the leg actually is at --
      // don't assume 'down', or an already-extended leg forces a spurious
      // extra half-cycle before the first real rep can count.
      const startAngle = landmarks ? legAngle(landmarks, activeSide) : null;
      repState = startAngle !== null && startAngle > kneeUpThreshold ? 'up' : 'down';
      repStartTime = now;
      currentRepMinAngle = startAngle;
      currentRepMaxAngle = startAngle;
    }
    return;
  }

  // appState === 'active'
  if (!landmarks) return;
  const angle = legAngle(landmarks, activeSide);
  if (angle === null) return;
  currentAngle = angle;

  currentRepMinAngle = currentRepMinAngle === null ? angle : Math.min(currentRepMinAngle, angle);
  currentRepMaxAngle = currentRepMaxAngle === null ? angle : Math.max(currentRepMaxAngle, angle);
  bestAngle = bestAngle === null ? angle : Math.max(bestAngle, angle);

  if (repState === 'down' && angle > kneeUpThreshold) {
    repState = 'up';
  } else if (repState === 'up' && angle < kneeDownThreshold) {
    repCount++;

    const durationSec = (now - repStartTime) / 1000;
    const entry = { n: repCount, side: activeSide, minAngle: currentRepMinAngle, maxAngle: currentRepMaxAngle, durationSec };
    sessionLog.push(entry);
    console.log('rep complete:', entry, 'sessionLog:', sessionLog);

    formStatus = currentRepMaxAngle >= bestAngle - HYSTERESIS_MARGIN ? t('formGood') : t('formTryHarder');

    // One rep = one leg's up-down cycle, then alternate to the other leg.
    // Re-seed state from the NEW side's current angle (not the old side's),
    // same "don't assume 'down'" reasoning as the initial countdown start.
    activeSide = activeSide === 'right' ? 'left' : 'right';
    const newAngle = legAngle(landmarks, activeSide);
    repState = newAngle !== null && newAngle > kneeUpThreshold ? 'up' : 'down';
    repStartTime = now;
    currentRepMinAngle = newAngle;
    currentRepMaxAngle = newAngle;
  }
}

function dashboardText() {
  const angleStr = currentAngle !== null ? currentAngle.toFixed(0) + ' deg' : '--';
  const bestStr = bestAngle !== null ? bestAngle.toFixed(0) + ' deg' : '--';
  const sideStr = activeSide === 'right' ? t('sideRight') : t('sideLeft');
  return `${t('reps')}: ${repCount}\n${t('side')}: ${sideStr}\n${t('angle')}: ${angleStr}\n${t('best')}: ${bestStr}\n${t('form')}: ${formStatus}`;
}

function statusText() {
  if (appState === 'positioning') {
    return t('positioning');
  }
  // appState === 'countdown'
  const remaining = Math.max(0, COUNTDOWN_MS - (performance.now() - countdownStart));
  const n = Math.ceil(remaining / 1000);
  return n > 0 ? String(n) : t('go');
}

// --- Step 4: format sessionLog into labelled English for Gemma ---
function formatSessionSummary(log) {
  if (log.length === 0) return 'No reps were completed this session.';

  const roms = log.map((r) => r.maxAngle - r.minAngle);
  const bestRom = Math.max(...roms);
  const bestRep = log.reduce((a, b) => (b.maxAngle > a.maxAngle ? b : a));
  const weakestRep = log.reduce((a, b) => (b.maxAngle < a.maxAngle ? b : a));
  const avgMaxAngle = log.reduce((sum, r) => sum + r.maxAngle, 0) / log.length;

  const lines = [];
  lines.push(`Completed ${log.length} rep${log.length === 1 ? '' : 's'} of seated knee extension, alternating right and left legs.`);
  lines.push(
    `Knee straightened furthest on rep ${bestRep.n} (${bestRep.side} leg, ${bestRep.maxAngle.toFixed(0)} degrees, ` +
    `compared to ${avgMaxAngle.toFixed(0)} degrees average).`
  );
  lines.push(`Rep ${weakestRep.n} (${weakestRep.side} leg) was weakest at ${weakestRep.maxAngle.toFixed(0)} degrees.`);

  // Per-leg breakdown, since the clinician prompt is explicitly asked to
  // flag asymmetry -- that's only meaningful now that both legs are
  // actually tracked (previously this app only ever measured one leg).
  const rightReps = log.filter((r) => r.side === 'right');
  const leftReps = log.filter((r) => r.side === 'left');
  const avg = (reps) => reps.reduce((sum, r) => sum + r.maxAngle, 0) / reps.length;
  if (rightReps.length > 0 && leftReps.length > 0) {
    const avgRight = avg(rightReps);
    const avgLeft = avg(leftReps);
    lines.push(
      `Right leg: ${rightReps.length} rep${rightReps.length === 1 ? '' : 's'}, ` +
      `average maximum angle ${avgRight.toFixed(0)} degrees. ` +
      `Left leg: ${leftReps.length} rep${leftReps.length === 1 ? '' : 's'}, ` +
      `average maximum angle ${avgLeft.toFixed(0)} degrees.`
    );
    const diff = Math.abs(avgRight - avgLeft);
    if (diff > 10) {
      lines.push(`Asymmetry noted: right and left leg average maximum angles differ by ${diff.toFixed(0)} degrees.`);
    }
  }

  for (const r of log) {
    const rom = r.maxAngle - r.minAngle;
    if (rom < bestRom * 0.85) {
      lines.push(
        `Rep ${r.n} (${r.side} leg) had a range of motion of ${rom.toFixed(0)} degrees, ` +
        `more than 15% below the best rep's range of motion of ${bestRom.toFixed(0)} degrees.`
      );
    }
  }

  return lines.join(' ');
}

async function stopSession() {
  running = false;
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
  }
  stopBtn.style.display = 'none';
  dashboardEl.style.display = 'none';
  demoPanelEl.style.display = 'none';
  statusEl.style.display = 'block';
  statusEl.textContent = t('generatingReport');

  if (userConfig && repCount > 0) {
    userConfig.sessionHistory = userConfig.sessionHistory || [];
    userConfig.sessionHistory.push({
      date: new Date().toISOString(),
      exercise: 'Seated Knee Extension',
      reps: repCount,
    });
    // Cap stored history -- only the history surface's chart (last 3) and
    // the greeting's trend line need recent data, no unbounded growth.
    userConfig.sessionHistory = userConfig.sessionHistory.slice(-20);
    await window.rehabAPI.saveConfig(userConfig);
  }

  const summary = formatSessionSummary(sessionLog);
  try {
    await window.rehabAPI.generateReport(summary, lang);
    // On success the window navigates to the report page itself, so no
    // further status update runs here -- this renderer context is gone.
  } catch (err) {
    statusEl.textContent = 'ERROR generating report: ' + err.message;
  }
}

stopBtn.addEventListener('click', stopSession);

window.addEventListener('error', (e) => {
  statusEl.textContent = 'ERROR: ' + e.message;
});
window.addEventListener('unhandledrejection', (e) => {
  statusEl.textContent = 'ERROR: ' + e.reason;
});

async function init() {
  statusEl.textContent = 'loading pose model...';
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );

  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numPoses: 1,
  });

  statusEl.textContent = 'requesting camera...';
  mediaStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  video.srcObject = mediaStream;

  video.addEventListener('loadeddata', () => {
    // Canvas pixel buffer stays at native capture resolution -- landmark
    // math and drawing both happen in that space. Display size (below) is
    // a separate CSS scale-up so it's readable from 2m away; it doesn't
    // affect coordinates since video and canvas are scaled identically.
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    // Reserve room for #demoPanel (190px image + border + its margin-right,
    // see index.html) so the video isn't sized to the full window width --
    // otherwise it overflows the flex row and, being position:absolute,
    // paints on top of the demo images instead of sitting beside them.
    const DEMO_PANEL_SPACE = 240;
    const availableW = window.innerWidth - 40 - DEMO_PANEL_SPACE;
    const availableH = window.innerHeight - 80;
    const scale = Math.min(
      availableW / video.videoWidth,
      availableH / video.videoHeight,
      1.6
    );
    const displayW = Math.round(video.videoWidth * scale);
    const displayH = Math.round(video.videoHeight * scale);

    stage.style.width = displayW + 'px';
    stage.style.height = displayH + 'px';
    video.style.width = displayW + 'px';
    video.style.height = displayH + 'px';
    canvas.style.width = displayW + 'px';
    canvas.style.height = displayH + 'px';

    statusEl.textContent = 'running';
    stopBtn.style.display = 'block';
    requestAnimationFrame(renderLoop);
  });
}

function renderLoop() {
  if (!running) return;
  // detectForVideo requires strictly increasing timestamps.
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const now = performance.now();
    const result = poseLandmarker.detectForVideo(video, now);
    const landmarks = result.landmarks && result.landmarks[0];
    draw(result);
    updateExercise(landmarks, now);
    updateDemoPanel();
    if (appState === 'active') {
      statusEl.style.display = 'none';
      dashboardEl.style.display = 'block';
      dashboardEl.textContent = dashboardText();
    } else {
      dashboardEl.style.display = 'none';
      statusEl.style.display = 'block';
      statusEl.textContent = statusText();
    }
  }
  requestAnimationFrame(renderLoop);
}

function draw(result) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const landmarksList = result.landmarks;
  if (!landmarksList || landmarksList.length === 0) return;

  const landmarks = landmarksList[0];

  ctx.strokeStyle = '#4a7c66';
  ctx.lineWidth = 3;
  for (const [a, b] of BONES) {
    const p1 = landmarks[a];
    const p2 = landmarks[b];
    if (!p1 || !p2) continue;
    ctx.beginPath();
    ctx.moveTo(p1.x * canvas.width, p1.y * canvas.height);
    ctx.lineTo(p2.x * canvas.width, p2.y * canvas.height);
    ctx.stroke();
  }

  ctx.fillStyle = '#c97a5a';
  for (const p of landmarks) {
    ctx.beginPath();
    ctx.arc(p.x * canvas.width, p.y * canvas.height, 5, 0, 2 * Math.PI);
    ctx.fill();
  }
}

// Boot sequence (idea from brainstorm): main process starts/health-checks
// Ollama and warms Gemma, pushing status here so the demo visibly shows
// the local AI coming up instead of just appearing. Completion is a
// separate pull (awaitBoot) rather than only a push event, so a reload
// via the reset or HOME buttons -- which reuses this same window after
// the one-time boot sequence already finished -- resolves immediately
// instead of waiting forever for a 'ready' event that won't fire again.
window.rehabAPI.onBootStatus((status) => {
  if (status === 'ollama') {
    greetingTextEl.textContent = 'Starting Ollama...';
  } else if (status === 'gemma') {
    greetingTextEl.textContent = 'Starting Gemma...';
  }
});
// startBtn is disabled in HTML by default so it can't be clicked mid-boot
// (Gemma isn't reachable yet, and userConfig hasn't loaded) -- re-enable it
// once boot has actually finished.
window.rehabAPI.awaitBoot().then(() => {
  startBtn.disabled = false;
  initGreeting();
});
