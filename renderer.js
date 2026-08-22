import {
  PoseLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

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

let poseLandmarker;
let lastVideoTime = -1;
let mediaStream = null;
let running = true;

// --- Step 5: greeting, local config, reset ---
let userConfig = null;
let greetingSpeechText = '';

function buildGreetingText(config) {
  const hour = new Date().getHours();
  const timeGreeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  let text = `${timeGreeting}, ${config.name}.`;
  if (config.lastSessionReps) {
    text += ` Last time you did ${config.lastSessionReps} reps.`;
  }
  text += ' Ready for today?';
  return text;
}

function speak(text) {
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

async function initGreeting() {
  userConfig = await window.rehabAPI.loadConfig();

  if (!userConfig || !userConfig.name) {
    greetingTextEl.textContent = 'What should we call you?';
    nameInputEl.style.display = 'block';
    replayBtn.style.display = 'none';
    return;
  }

  greetingSpeechText = buildGreetingText(userConfig);
  greetingTextEl.textContent = greetingSpeechText;
  nameInputEl.style.display = 'none';
  replayBtn.style.display = 'inline-block';
  speak(greetingSpeechText);
}

startBtn.addEventListener('click', async () => {
  if (!userConfig || !userConfig.name) {
    const name = nameInputEl.value.trim();
    if (!name) {
      nameInputEl.focus();
      return;
    }
    userConfig = { name };
    await window.rehabAPI.saveConfig(userConfig);
  }
  greetingEl.style.display = 'none';
  exerciseScreenEl.style.display = 'contents';
  init();
});

replayBtn.addEventListener('click', () => speak(greetingSpeechText));

resetBtn.addEventListener('click', async () => {
  await window.rehabAPI.resetConfig();
  location.reload();
});

// --- Step 2: seated knee extension (right leg: hip 24, knee 26, ankle 28) ---
const HIP = 24, KNEE = 26, ANKLE = 28;
const POSITION_LANDMARKS = [11, 12, 23, 24, 25, 26, 27, 28];
const VISIBILITY_THRESHOLD = 0.5;
const POSITION_HOLD_MS = 2000;
const COUNTDOWN_MS = 3000;
// Camera angle changes what a bent knee's 2D projected angle reads as (see
// CLAUDE.md: 2D-only, no z), so the up/down thresholds are calibrated per
// session from the actual rest angle measured during the position hold,
// rather than hardcoded. HYSTERESIS_MARGIN sets the gap between them.
const HYSTERESIS_MARGIN = 10;    // degrees below the calibrated rest ceiling for the down-reset
const DEFAULT_UP_THRESHOLD = 145; // fallback if calibration somehow produced nothing

let appState = 'positioning'; // 'positioning' | 'countdown' | 'active'
let positionStableSince = null;
let countdownStart = null;
let restAngleMax = null;
let kneeUpThreshold = null;
let kneeDownThreshold = null;
let repState = 'down';
let repCount = 0;
let currentAngle = null;

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
      const angle = angleDegrees(landmarks[HIP], landmarks[KNEE], landmarks[ANKLE]);
      if (angle !== null) {
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
      kneeUpThreshold = restAngleMax !== null ? restAngleMax : DEFAULT_UP_THRESHOLD;
      kneeDownThreshold = kneeUpThreshold - HYSTERESIS_MARGIN;
      // Start from whichever side of the range the leg actually is at --
      // don't assume 'down', or an already-extended leg forces a spurious
      // extra half-cycle before the first real rep can count.
      const startAngle = landmarks
        ? angleDegrees(landmarks[HIP], landmarks[KNEE], landmarks[ANKLE])
        : null;
      repState = startAngle !== null && startAngle > kneeUpThreshold ? 'up' : 'down';
      repStartTime = now;
      currentRepMinAngle = startAngle;
      currentRepMaxAngle = startAngle;
    }
    return;
  }

  // appState === 'active'
  if (!landmarks) return;
  const angle = angleDegrees(landmarks[HIP], landmarks[KNEE], landmarks[ANKLE]);
  if (angle === null) return;
  currentAngle = angle;

  currentRepMinAngle = currentRepMinAngle === null ? angle : Math.min(currentRepMinAngle, angle);
  currentRepMaxAngle = currentRepMaxAngle === null ? angle : Math.max(currentRepMaxAngle, angle);
  bestAngle = bestAngle === null ? angle : Math.max(bestAngle, angle);

  if (repState === 'down' && angle > kneeUpThreshold) {
    repState = 'up';
  } else if (repState === 'up' && angle < kneeDownThreshold) {
    repState = 'down';
    repCount++;

    const durationSec = (now - repStartTime) / 1000;
    const entry = { n: repCount, minAngle: currentRepMinAngle, maxAngle: currentRepMaxAngle, durationSec };
    sessionLog.push(entry);
    console.log('rep complete:', entry, 'sessionLog:', sessionLog);

    formStatus = currentRepMaxAngle >= bestAngle - HYSTERESIS_MARGIN ? 'Good' : 'Try to straighten more';

    repStartTime = now;
    currentRepMinAngle = angle;
    currentRepMaxAngle = angle;
  }
}

function dashboardText() {
  const angleStr = currentAngle !== null ? currentAngle.toFixed(0) + ' deg' : '--';
  const bestStr = bestAngle !== null ? bestAngle.toFixed(0) + ' deg' : '--';
  return `REPS: ${repCount}\nANGLE: ${angleStr}\nBEST: ${bestStr}\nFORM: ${formStatus}`;
}

function statusText() {
  if (appState === 'positioning') {
    return 'Please sit facing the camera';
  }
  // appState === 'countdown'
  const remaining = Math.max(0, COUNTDOWN_MS - (performance.now() - countdownStart));
  const n = Math.ceil(remaining / 1000);
  return n > 0 ? String(n) : 'GO';
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
  lines.push(`Completed ${log.length} rep${log.length === 1 ? '' : 's'} of seated knee extension.`);
  lines.push(
    `Knee straightened furthest on rep ${bestRep.n} (${bestRep.maxAngle.toFixed(0)} degrees, ` +
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

  return lines.join(' ');
}

async function stopSession() {
  running = false;
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
  }
  stopBtn.style.display = 'none';
  dashboardEl.style.display = 'none';
  statusEl.style.display = 'block';
  statusEl.textContent = 'Generating report...';

  if (userConfig) {
    userConfig.lastSessionReps = repCount;
    await window.rehabAPI.saveConfig(userConfig);
  }

  const summary = formatSessionSummary(sessionLog);
  try {
    await window.rehabAPI.generateReport(summary);
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

    const availableW = window.innerWidth - 40;
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

initGreeting();
