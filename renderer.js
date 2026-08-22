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

let poseLandmarker;
let lastVideoTime = -1;

// --- Step 2: seated knee extension (right leg: hip 24, knee 26, ankle 28) ---
const HIP = 24, KNEE = 26, ANKLE = 28;
const POSITION_LANDMARKS = [11, 12, 23, 24, 25, 26, 27, 28];
const VISIBILITY_THRESHOLD = 0.5;
const POSITION_HOLD_MS = 2000;
const COUNTDOWN_MS = 3000;
const KNEE_UP_THRESHOLD = 150;   // degrees -- leg counted as extended (top of rep)
const KNEE_DOWN_THRESHOLD = 100; // degrees -- leg counted as back at rest

let appState = 'positioning'; // 'positioning' | 'countdown' | 'active'
let positionStableSince = null;
let countdownStart = null;
let repState = 'down';
let repCount = 0;
let currentAngle = null;

function angleDegrees(a, b, c) {
  // angle at b formed by a-b-c, x/y only -- z is monocular noise, ignored per project rules.
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const mag1 = Math.hypot(v1x, v1y);
  const mag2 = Math.hypot(v2x, v2y);
  if (mag1 === 0 || mag2 === 0) return null;
  const cos = Math.min(1, Math.max(-1, (v1x * v2x + v1y * v2y) / (mag1 * mag2)));
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
      if (positionStableSince === null) positionStableSince = now;
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
      repState = 'down';
      repCount = 0;
    }
    return;
  }

  // appState === 'active'
  if (!landmarks) return;
  const angle = angleDegrees(landmarks[HIP], landmarks[KNEE], landmarks[ANKLE]);
  if (angle === null) return;
  currentAngle = angle;

  if (repState === 'down' && angle > KNEE_UP_THRESHOLD) {
    repState = 'up';
  } else if (repState === 'up' && angle < KNEE_DOWN_THRESHOLD) {
    repState = 'down';
    repCount++;
  }
}

function statusText() {
  if (appState === 'positioning') {
    return 'Please sit facing the camera';
  }
  if (appState === 'countdown') {
    const remaining = Math.max(0, COUNTDOWN_MS - (performance.now() - countdownStart));
    const n = Math.ceil(remaining / 1000);
    return n > 0 ? String(n) : 'GO';
  }
  return `reps: ${repCount}  angle: ${currentAngle !== null ? currentAngle.toFixed(1) : '--'}  state: ${repState}`;
}

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
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;

  video.addEventListener('loadeddata', () => {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    video.width = video.videoWidth;
    video.height = video.videoHeight;
    stage.style.width = video.videoWidth + 'px';
    stage.style.height = video.videoHeight + 'px';
    statusEl.textContent = 'running';
    requestAnimationFrame(renderLoop);
  });
}

function renderLoop() {
  // detectForVideo requires strictly increasing timestamps.
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const now = performance.now();
    const result = poseLandmarker.detectForVideo(video, now);
    const landmarks = result.landmarks && result.landmarks[0];
    draw(result);
    updateExercise(landmarks, now);
    statusEl.textContent = statusText();
  }
  requestAnimationFrame(renderLoop);
}

function draw(result) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const landmarksList = result.landmarks;
  if (!landmarksList || landmarksList.length === 0) return;

  const landmarks = landmarksList[0];

  ctx.strokeStyle = '#00ff00';
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

  ctx.fillStyle = '#ff0000';
  for (const p of landmarks) {
    ctx.beginPath();
    ctx.arc(p.x * canvas.width, p.y * canvas.height, 5, 0, 2 * Math.PI);
    ctx.fill();
  }
}

init();
