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
const flagsBtnEl = document.getElementById('flagsBtn');
const demoPanelEl = document.getElementById('demoPanel');
const demoIdleImg = document.getElementById('demoIdle');
const demoRightImg = document.getElementById('demoRight');
const demoLeftImg = document.getElementById('demoLeft');
const demoLeftItemEl = document.getElementById('demoLeftItem');
const demoIdleLabelEl = document.getElementById('demoIdleLabel');
const demoRightLabelEl = document.getElementById('demoRightLabel');
const demoLeftLabelEl = document.getElementById('demoLeftLabel');
const exerciseTilesEl = document.getElementById('exerciseTiles');
const exerciseTileButtons = Array.from(document.querySelectorAll('.exerciseTile'));

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
  flagsBtnEl.textContent = t('clinicianFlags');
  exerciseTileButtons.forEach((btn) => {
    btn.textContent = t(EXERCISES[btn.dataset.exercise].nameKey);
  });
  if (currentExercise) applyDemoLabels(currentExercise);
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

// --- Cross-session clinician flags digest (brainstormed Gemma addition):
// unlike the per-session report, this scans ALL logged sessions for
// multi-session patterns -- declining best angle, persistent asymmetry --
// and asks Gemma to write them up for a clinician. Triggered from the
// greeting screen only, so the camera is never running when this fires
// (see CLAUDE.md: never call Gemma while the camera is running). Same
// JS-computes-facts/Gemma-tones split as every other Gemma call here --
// formatFlagsFacts below decides what counts as a trend; Gemma only
// phrases what it's given, told explicitly not to invent anything else.
const ROM_DECLINE_WINDOW = 3;   // sessions compared for a declining-best-angle flag
const ASYMMETRY_WINDOW = 2;     // sessions compared for a persistent-asymmetry flag
const ASYMMETRY_THRESHOLD = 10; // degrees -- same threshold as the single-session report

// Gate on raw session counts (any exercise with 3+ logged sessions) --
// separate from formatFlagsFacts' own per-field checks below, which need
// the newer bestAngle/rightAvgAngle/leftAvgAngle fields that only exist on
// sessions logged after this feature shipped. Older sessions still count
// toward showing the button; formatFlagsFacts just has less to say about
// them.
function hasEnoughHistoryForFlags(history) {
  const counts = {};
  for (const s of history) counts[s.exercise] = (counts[s.exercise] || 0) + 1;
  return Object.values(counts).some((n) => n >= 3);
}

function formatFlagsFacts(history) {
  const usable = history.filter((s) => typeof s.bestAngle === 'number');
  const byExercise = {};
  for (const s of usable) {
    (byExercise[s.exercise] = byExercise[s.exercise] || []).push(s);
  }

  const lines = [];
  let anyFlag = false;

  // sessionHistory is stored oldest-first (pushed in order each session).
  for (const [exercise, sessions] of Object.entries(byExercise)) {
    lines.push(`${exercise}: ${sessions.length} session${sessions.length === 1 ? '' : 's'} recorded.`);

    if (sessions.length >= ROM_DECLINE_WINDOW) {
      const recent = sessions.slice(-ROM_DECLINE_WINDOW);
      const declining = recent.every((s, i) => i === 0 || s.bestAngle < recent[i - 1].bestAngle);
      lines.push(
        `Best angle over the last ${ROM_DECLINE_WINDOW} sessions: ` +
        `${recent.map((s) => s.bestAngle.toFixed(0)).join(', ')} degrees` +
        (declining ? ' (declining each session).' : ' (no consistent decline).')
      );
      if (declining) anyFlag = true;
    }

    const asymSessions = sessions.filter((s) => typeof s.rightAvgAngle === 'number' && typeof s.leftAvgAngle === 'number');
    if (asymSessions.length >= ASYMMETRY_WINDOW) {
      const recent = asymSessions.slice(-ASYMMETRY_WINDOW);
      const diffs = recent.map((s) => Math.abs(s.rightAvgAngle - s.leftAvgAngle));
      const persisting = diffs.every((d) => d > ASYMMETRY_THRESHOLD);
      lines.push(
        `Right/left asymmetry over the last ${ASYMMETRY_WINDOW} sessions: ` +
        `${diffs.map((d) => d.toFixed(0) + ' degrees').join(', ')}` +
        (persisting ? ` (each above the ${ASYMMETRY_THRESHOLD} degree threshold).` : ' (not consistently above threshold).')
      );
      if (persisting) anyFlag = true;
    }
  }

  if (!anyFlag) {
    lines.push(lines.length === 0
      ? 'Not enough repeated-exercise session history yet to identify multi-session trends.'
      : 'No concerning multi-session patterns identified.');
  }

  return lines.join(' ');
}

flagsBtnEl.addEventListener('click', async () => {
  flagsBtnEl.disabled = true;
  const facts = formatFlagsFacts(userConfig.sessionHistory || []);
  try {
    await window.rehabAPI.generateFlagsDigest(facts, lang);
    // On success the window navigates to the flags-digest page, same as
    // generateReport -- no further UI update needed, this context is gone.
  } catch (err) {
    flagsBtnEl.disabled = false;
    console.error('flags digest failed:', err);
  }
});

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
  flagsBtnEl.disabled = false;
  flagsBtnEl.style.display = hasEnoughHistoryForFlags(history) ? 'inline-block' : 'none';

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
    startBtn.style.display = 'inline-block';
    exerciseTilesEl.style.display = 'none';
    replayBtn.style.display = 'none';
    greetingTextEl.textContent = t('namePrompt');
    return;
  }

  nameInputEl.style.display = 'none';
  langChoiceEl.style.display = 'none';
  subPromptEl.style.display = 'none';
  ageChoiceEl.style.display = 'none';
  startBtn.style.display = 'none';
  await showPersonalizedGreeting();
  exerciseTilesEl.style.display = 'flex';
}

// startBtn now only handles first-run onboarding (name/language/age). Once
// a profile exists, the exercise tiles below replace it -- tapping a tile
// both picks and starts that exercise in one tap (see CLAUDE.md's Step 7
// amendment / the exercise-tile Controls exception).
startBtn.addEventListener('click', async () => {
  const name = nameInputEl.value.trim();
  if (!name) {
    nameInputEl.focus();
    return;
  }
  if (!selectedAge) return;
  userConfig = { name, lang, ageRange: selectedAge, sessionHistory: [] };
  await window.rehabAPI.saveConfig(userConfig);

  nameInputEl.style.display = 'none';
  langChoiceEl.style.display = 'none';
  subPromptEl.style.display = 'none';
  ageChoiceEl.style.display = 'none';
  startBtn.style.display = 'none';
  await showPersonalizedGreeting();
  exerciseTilesEl.style.display = 'flex';
});

function startExercise(exerciseId) {
  currentExercise = EXERCISES[exerciseId];
  loadExerciseImages(currentExercise);
  greetingEl.style.display = 'none';
  exerciseScreenEl.style.display = 'contents';
  init();
}

exerciseTileButtons.forEach((btn) => {
  btn.addEventListener('click', () => startExercise(btn.dataset.exercise));
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

// --- Step 2/7: exercise config. One shared angle-threshold state machine
// (below) drives all three -- each entry supplies the landmark triples,
// which landmarks must be visible to pass the position check, its demo
// images, and its `mode`:
//   'alternating' -- one side moves at a time, handoff to the other side
//                    after each rep (knee extension; user's explicit
//                    request to alternate legs).
//   'bilateral'   -- both sides move together, tracked as one averaged
//                    angle, no side handoff (arm raise, sit-to-stand --
//                    these are naturally two-limbs/whole-body movements).
// Every triple is anchor-joint-distal (e.g. hip-knee-ankle) chosen so the
// angle reads LOW at rest and HIGH at the top of the movement in every
// exercise -- that's what lets all three share one calibrated-threshold
// crossing rule instead of needing a per-exercise direction flag.
const EXERCISES = {
  kneeExtension: {
    id: 'kneeExtension',
    mode: 'alternating',
    nameKey: 'exerciseKneeExtension',
    reportName: 'Seated Knee Extension',
    triples: {
      right: { a: 24, b: 26, c: 28 }, // hip, knee, ankle
      left: { a: 23, b: 25, c: 27 },
    },
    positionLandmarks: [11, 12, 23, 24, 25, 26, 27, 28],
    images: {
      idle: 'assets/exercises/knee-extension-sitting.png',
      right: 'assets/exercises/knee-extension-right.png',
      left: 'assets/exercises/knee-extension-left.png',
    },
  },
  armRaise: {
    id: 'armRaise',
    mode: 'bilateral',
    nameKey: 'exerciseArmRaise',
    reportName: 'Seated Arm Raise',
    triples: {
      right: { a: 24, b: 12, c: 16 }, // hip, shoulder, wrist
      left: { a: 23, b: 11, c: 15 },
    },
    positionLandmarks: [11, 12, 15, 16, 23, 24],
    images: {
      idle: 'assets/exercises/arm-raise-sitting.png',
      active: 'assets/exercises/arm-raise-raised.png',
    },
    activeLabelKey: 'demoArmsUp',
    tryHarderKey: 'formTryHarderArm',
  },
  sitToStand: {
    id: 'sitToStand',
    mode: 'bilateral',
    nameKey: 'exerciseSitToStand',
    reportName: 'Sit-to-Stand',
    triples: {
      right: { a: 12, b: 24, c: 26 }, // shoulder, hip, knee
      left: { a: 11, b: 23, c: 25 },
    },
    positionLandmarks: [11, 12, 23, 24, 25, 26],
    images: {
      idle: 'assets/exercises/sit-to-stand-sitting.png',
      active: 'assets/exercises/sit-to-stand-standing.png',
    },
    activeLabelKey: 'demoStanding',
    tryHarderKey: 'formTryHarderStand',
  },
};

const VISIBILITY_THRESHOLD = 0.5;
const POSITION_HOLD_MS = 2000;
const COUNTDOWN_MS = 3000;
// Camera angle changes what a bent joint's 2D projected angle reads as (see
// CLAUDE.md: 2D-only, no z), so the up/down thresholds are calibrated per
// session from the actual rest angle measured during the position hold,
// rather than hardcoded. HYSTERESIS_MARGIN sets the gap between them. One
// shared threshold for both sides (calibrated from whichever side reads
// higher during the hold) rather than separate per-side calibration --
// keeps the tuned-and-verified single-side calibration approach intact
// instead of introducing a second untested source of jitter.
const HYSTERESIS_MARGIN = 10;    // degrees below the calibrated rest ceiling for the down-reset
const DEFAULT_UP_THRESHOLD = 145; // fallback if calibration somehow produced nothing

let currentExercise = null;
let appState = 'positioning'; // 'positioning' | 'countdown' | 'active'
let positionStableSince = null;
let countdownStart = null;
let restAngleMax = null;
let kneeUpThreshold = null;
let kneeDownThreshold = null;
let activeSide = 'right'; // alternates after every completed rep ('alternating' mode only)
let repState = 'down';
let repCount = 0;
let currentAngle = null;

function sideAngle(landmarks, exercise, side) {
  const triple = exercise.triples[side];
  return angleDegrees(landmarks[triple.a], landmarks[triple.b], landmarks[triple.c]);
}

// Highest of both sides' readings during the rest hold -- noise-floor
// reasoning from the original knee calibration, reused for every exercise.
function calibrationAngle(landmarks, exercise) {
  const right = sideAngle(landmarks, exercise, 'right');
  const left = sideAngle(landmarks, exercise, 'left');
  return Math.max(right ?? -Infinity, left ?? -Infinity);
}

// 'alternating' tracks whichever side is currently active; 'bilateral'
// tracks both sides at once, averaged into one number.
function activeExerciseAngle(landmarks, exercise, side) {
  if (exercise.mode === 'alternating') return sideAngle(landmarks, exercise, side);
  const right = sideAngle(landmarks, exercise, 'right');
  const left = sideAngle(landmarks, exercise, 'left');
  if (right === null || left === null) return null;
  return (right + left) / 2;
}

// --- Exercise demonstration images (replaces Step 6's planned webcam-
// keyframe stick figure -- see CLAUDE.md). Static assets the user supplies
// externally; this file only references a fixed local path per exercise
// state. Falls back to a plain labelled placeholder box until the real
// file is dropped in, so the app runs and looks reasonable either way. ---
function placeholderImage(label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="190" height="190">` +
    `<rect width="190" height="190" fill="#f4f1ea"/>` +
    `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="18" font-weight="bold" fill="#2c3e42">${label}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function setupDemoImage(imgEl, path, fallbackLabel) {
  imgEl.addEventListener('error', () => {
    imgEl.src = placeholderImage(fallbackLabel);
  }, { once: true });
  imgEl.src = path;
}

// Labels only (not src -- see loadExerciseImages) so language toggles can
// re-apply these without re-fetching/re-flashing the images themselves.
function applyDemoLabels(exercise) {
  demoIdleLabelEl.textContent = t('demoSitting'); // every exercise starts seated
  if (exercise.mode === 'alternating') {
    demoRightLabelEl.textContent = t('demoRightLeg');
    demoLeftLabelEl.textContent = t('demoLeftLeg');
  } else {
    demoRightLabelEl.textContent = t(exercise.activeLabelKey);
  }
}

// Bilateral exercises only need 2 images (idle, active) -- reuses the
// idle/right image slots and hides the unused left slot rather than
// building a separate variable-length panel markup.
function loadExerciseImages(exercise) {
  setupDemoImage(demoIdleImg, exercise.images.idle, 'SITTING');
  if (exercise.mode === 'alternating') {
    demoLeftItemEl.style.display = '';
    setupDemoImage(demoRightImg, exercise.images.right, 'RIGHT');
    setupDemoImage(demoLeftImg, exercise.images.left, 'LEFT');
  } else {
    demoLeftItemEl.style.display = 'none';
    setupDemoImage(demoRightImg, exercise.images.active, 'ACTIVE');
  }
  applyDemoLabels(exercise);
}

function updateDemoPanel() {
  const visible = appState === 'positioning' || appState === 'countdown' || appState === 'active';
  demoPanelEl.style.display = visible ? 'flex' : 'none';
  if (!visible) return;
  demoIdleImg.classList.toggle('highlight', appState !== 'active');
  if (currentExercise.mode === 'alternating') {
    demoRightImg.classList.toggle('highlight', appState === 'active' && activeSide === 'right');
    demoLeftImg.classList.toggle('highlight', appState === 'active' && activeSide === 'left');
  } else {
    demoRightImg.classList.toggle('highlight', appState === 'active');
  }
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

function isPositioned(landmarks, exercise) {
  for (const i of exercise.positionLandmarks) {
    const p = landmarks[i];
    if (!p || (p.visibility ?? 0) < VISIBILITY_THRESHOLD) return false;
  }
  return true;
}

function updateExercise(landmarks, now) {
  const exercise = currentExercise;
  if (appState === 'positioning') {
    if (landmarks && isPositioned(landmarks, exercise)) {
      if (positionStableSince === null) {
        positionStableSince = now;
        restAngleMax = null; // fresh calibration for this hold
      }
      // Calibrate from whichever side reads higher this frame -- one shared
      // threshold covers both sides (see const block above).
      const angle = calibrationAngle(landmarks, exercise);
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
      activeSide = 'right'; // 'alternating' mode always starts on the right side
      kneeUpThreshold = restAngleMax !== null ? restAngleMax : DEFAULT_UP_THRESHOLD;
      kneeDownThreshold = kneeUpThreshold - HYSTERESIS_MARGIN;
      // Start from whichever side of the range the movement actually is at --
      // don't assume 'down', or an already-raised start forces a spurious
      // extra half-cycle before the first real rep can count.
      const startAngle = landmarks ? activeExerciseAngle(landmarks, exercise, activeSide) : null;
      repState = startAngle !== null && startAngle > kneeUpThreshold ? 'up' : 'down';
      repStartTime = now;
      currentRepMinAngle = startAngle;
      currentRepMaxAngle = startAngle;
    }
    return;
  }

  // appState === 'active'
  if (!landmarks) return;
  const angle = activeExerciseAngle(landmarks, exercise, activeSide);
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
    const entry = exercise.mode === 'alternating'
      ? { n: repCount, side: activeSide, minAngle: currentRepMinAngle, maxAngle: currentRepMaxAngle, durationSec }
      : { n: repCount, minAngle: currentRepMinAngle, maxAngle: currentRepMaxAngle, durationSec };
    sessionLog.push(entry);
    console.log('rep complete:', entry, 'sessionLog:', sessionLog);

    formStatus = currentRepMaxAngle >= bestAngle - HYSTERESIS_MARGIN
      ? t('formGood')
      : t(exercise.tryHarderKey || 'formTryHarder');

    // 'alternating' mode: one rep = one side's up-down cycle, then hand off
    // to the other side. Re-seed state from the NEW side's current angle
    // (not the old side's), same "don't assume 'down'" reasoning as the
    // initial countdown start. 'bilateral' mode just keeps activeSide fixed
    // (unused by activeExerciseAngle in that mode) and re-seeds normally.
    if (exercise.mode === 'alternating') {
      activeSide = activeSide === 'right' ? 'left' : 'right';
    }
    const newAngle = activeExerciseAngle(landmarks, exercise, activeSide);
    repState = newAngle !== null && newAngle > kneeUpThreshold ? 'up' : 'down';
    repStartTime = now;
    currentRepMinAngle = newAngle;
    currentRepMaxAngle = newAngle;
  }
}

// --- Voice-free stop gesture (brainstormed alternative to walking to the
// STOP button): cross both wrists in front of the chest, held stable for
// STOP_HOLD_MS -- same hold-timer pattern as the position check above.
// Landmark left/right labels are the subject's own body sides regardless
// of camera mirroring (see CLAUDE.md's mirroring note), so "crossed" is
// checked relative to the shoulder midline rather than a fixed screen
// direction -- correct regardless of which way the person faces the lens.
// Checked every frame the exercise screen is up (all three appStates),
// same as updateExercise -- harmless if held during positioning/countdown,
// and keeps this one check unconditional instead of gating it per state.
const STOP_HOLD_MS = 2000;
let stopGestureSince = null;

function isCrossedArms(landmarks) {
  const ls = landmarks[11], rs = landmarks[12];   // shoulders
  const lw = landmarks[15], rw = landmarks[16];   // wrists
  const lh = landmarks[23], rh = landmarks[24];   // hips
  const pts = [ls, rs, lw, rw, lh, rh];
  if (pts.some((p) => !p || (p.visibility ?? 0) < VISIBILITY_THRESHOLD)) return false;

  const shoulderWidth = Math.abs(rs.x - ls.x);
  if (shoulderWidth < 1e-6) return false;
  const midX = (ls.x + rs.x) / 2;
  const margin = shoulderWidth * 0.2; // require a clear cross, not just touching the midline
  const leftShoulderSign = Math.sign(ls.x - midX);

  // Crossed: each wrist has moved past the midline onto the OPPOSITE
  // shoulder's side, by more than the margin.
  const crossed =
    Math.sign(rw.x - midX) === leftShoulderSign && Math.abs(rw.x - midX) > margin &&
    Math.sign(lw.x - midX) === -leftShoulderSign && Math.abs(lw.x - midX) > margin;
  if (!crossed) return false;

  // ...and roughly at chest height, not down at the waist or up at the face.
  const chestTop = Math.min(ls.y, rs.y);
  const chestBottom = Math.max(lh.y, rh.y);
  const inChestBand = (p) => p.y >= chestTop && p.y <= chestBottom;
  return inChestBand(lw) && inChestBand(rw);
}

// Returns true once the gesture has been held continuously for
// STOP_HOLD_MS. Also updates stopGestureSince, which dashboardText() and
// statusText() read to show the "Stopping..." hint mid-hold.
function updateStopGesture(landmarks, now) {
  if (landmarks && isCrossedArms(landmarks)) {
    if (stopGestureSince === null) stopGestureSince = now;
    return now - stopGestureSince >= STOP_HOLD_MS;
  }
  stopGestureSince = null;
  return false;
}

function dashboardText() {
  const angleStr = currentAngle !== null ? currentAngle.toFixed(0) + ' deg' : '--';
  const bestStr = bestAngle !== null ? bestAngle.toFixed(0) + ' deg' : '--';
  const lines = [`${t('reps')}: ${repCount}`];
  if (currentExercise.mode === 'alternating') {
    const sideStr = activeSide === 'right' ? t('sideRight') : t('sideLeft');
    lines.push(`${t('side')}: ${sideStr}`);
  }
  lines.push(`${t('angle')}: ${angleStr}`, `${t('best')}: ${bestStr}`, `${t('form')}: ${formStatus}`);
  if (stopGestureSince !== null) lines.push(t('stopping'));
  return lines.join('\n');
}

function statusText() {
  let text;
  if (appState === 'positioning') {
    text = t('positioning');
  } else {
    // appState === 'countdown'
    const remaining = Math.max(0, COUNTDOWN_MS - (performance.now() - countdownStart));
    const n = Math.ceil(remaining / 1000);
    text = n > 0 ? String(n) : t('go');
  }
  if (stopGestureSince !== null) text += '\n' + t('stopping');
  return text;
}

// --- Step 4: format sessionLog into labelled English for Gemma ---
function formatSessionSummary(log, exercise) {
  if (log.length === 0) return 'No reps were completed this session.';

  const roms = log.map((r) => r.maxAngle - r.minAngle);
  const bestRom = Math.max(...roms);
  const bestRep = log.reduce((a, b) => (b.maxAngle > a.maxAngle ? b : a));
  const weakestRep = log.reduce((a, b) => (b.maxAngle < a.maxAngle ? b : a));
  const avgMaxAngle = log.reduce((sum, r) => sum + r.maxAngle, 0) / log.length;

  const lines = [];

  if (exercise.mode === 'alternating') {
    lines.push(`Completed ${log.length} rep${log.length === 1 ? '' : 's'} of ${exercise.reportName.toLowerCase()}, alternating right and left legs.`);
    lines.push(
      `Knee straightened furthest on rep ${bestRep.n} (${bestRep.side} leg, ${bestRep.maxAngle.toFixed(0)} degrees, ` +
      `compared to ${avgMaxAngle.toFixed(0)} degrees average).`
    );
    lines.push(`Rep ${weakestRep.n} (${weakestRep.side} leg) was weakest at ${weakestRep.maxAngle.toFixed(0)} degrees.`);

    // Per-leg breakdown, since the clinician prompt is explicitly asked to
    // flag asymmetry -- only meaningful for this alternating-legs exercise.
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
  } else {
    // Bilateral exercises (arm raise, sit-to-stand): both sides move
    // together, tracked as one averaged angle -- no side breakdown.
    lines.push(`Completed ${log.length} rep${log.length === 1 ? '' : 's'} of ${exercise.reportName.toLowerCase()}.`);
    lines.push(
      `Best range of motion was on rep ${bestRep.n} (${bestRep.maxAngle.toFixed(0)} degrees, ` +
      `compared to ${avgMaxAngle.toFixed(0)} degrees average).`
    );
    lines.push(`Rep ${weakestRep.n} was weakest at ${weakestRep.maxAngle.toFixed(0)} degrees.`);

    for (const r of log) {
      const rom = r.maxAngle - r.minAngle;
      if (rom < bestRom * 0.85) {
        lines.push(
          `Rep ${r.n} had a range of motion of ${rom.toFixed(0)} degrees, ` +
          `more than 15% below the best rep's range of motion of ${bestRom.toFixed(0)} degrees.`
        );
      }
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
    const entry = {
      date: new Date().toISOString(),
      exercise: currentExercise.reportName,
      reps: repCount,
      bestAngle, // feeds the cross-session flags digest's declining-ROM check
    };
    // Per-leg averages -- only meaningful for the alternating (knee
    // extension) mode, same per-leg breakdown formatSessionSummary already
    // computes for the single-session clinician report. Feeds the flags
    // digest's persistent-asymmetry check.
    if (currentExercise.mode === 'alternating') {
      const rightReps = sessionLog.filter((r) => r.side === 'right');
      const leftReps = sessionLog.filter((r) => r.side === 'left');
      const avg = (reps) => reps.reduce((sum, r) => sum + r.maxAngle, 0) / reps.length;
      if (rightReps.length > 0) entry.rightAvgAngle = avg(rightReps);
      if (leftReps.length > 0) entry.leftAvgAngle = avg(leftReps);
    }
    userConfig.sessionHistory.push(entry);
    // Cap stored history -- only the history surface's chart (last 3) and
    // the greeting's trend line need recent data, no unbounded growth.
    userConfig.sessionHistory = userConfig.sessionHistory.slice(-20);
    await window.rehabAPI.saveConfig(userConfig);
  }

  const summary = formatSessionSummary(sessionLog, currentExercise);
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
    if (updateStopGesture(landmarks, now)) {
      stopSession();
      return;
    }
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
