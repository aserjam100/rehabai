# Rehab Coach — 4 Hour Build

Read fully before writing code. Every instruction here is a constraint,
not a suggestion.

---

## The only loop that matters

```
Open app  ->  Greeting by name
          ->  Click START
          ->  "Get into position" check
          ->  Stick figure demonstrates the move
          ->  Senior copies it, live dashboard shows reps + angle + form
          ->  Click STOP
          ->  HTML report opens
```

Three exercises. Nothing else exists.

**Framing:** adherence and logging tool for a clinician-prescribed plan.
It does NOT prescribe exercise. Use that language in any UI copy.

---

## Git rules — non-negotiable

- NEVER run `git push`, `git remote add`, or anything that sends code to a
  remote. Not even if I ask in the moment.
- NEVER run `git commit`. Not even if I ask in the moment. I do all
  committing myself, always.
- NEVER modify `.gitignore` entries under "Claude / AI agent files".
- NEVER run `git add -f` or `--force` on an ignored file.

---

## Stack — locked

| Thing | Choice |
|---|---|
| Shell | Electron |
| Pose | `@mediapipe/tasks-vision`, JS |
| Render | HTML5 canvas |
| LLM | Gemma via Ollama, `http://localhost:11434` |
| Report | HTML file on disk, loaded into the same Electron window (`webContents.loadFile`) |
| State | Plain JS objects + one JSON config file |

Do NOT suggest or introduce: React, TypeScript, React Native, a bundler,
a database, WebRTC, video calls, cloud APIs, a test suite, or a state
management library. Vanilla JS in plain `.js` files.

---

## How to work with me

- ONE step at a time. Stop at the end of each and wait for me.
- Tell me exactly how to verify the step before you stop.
- If you hit a blocker, STOP and say so. Do not improvise around the stack.
- Do not build ahead. Do not add features I did not ask for.
- Do not refactor. This code is thrown away tomorrow.
- Ugly and working beats clean and unfinished.

---

## Timeboxed build order

Times are cumulative from start. **If you hit a marker and aren't at that
step, cut something and move on.**

### T+0:30 — Step 1: Camera, landmarks, stick figure
Electron window. Webcam feed. PoseLandmarker in `runningMode: "VIDEO"`.
Canvas overlay: bone list of landmark index pairs, line per pair, dot per
joint. No styling.
**Verify:** skeleton tracks me smoothly.

### T+1:10 — Step 2: Position check + reps, ONE exercise
Seated knee extension only.

*Position check:* required landmarks visible and confidence above
threshold, held stable 2 seconds. Show "Please sit facing the camera"
until then. Then a 3-2-1 countdown.

*Reps:* three landmarks -> angle via dot product -> up/down state machine.

Print live angle on screen while building. Tune thresholds by watching it.
**Verify:** rep count matches reality 10 times running.

### T+1:30 — Step 3: Dashboard overlay + session log
Live, on top of the video. Not a separate screen.

Shows: rep count, current angle in degrees, best angle this session,
form status ("Good" / "Try to straighten more").

Log per rep: `{ n, minAngle, maxAngle, durationSec }`.
**Verify:** numbers update live and the log dumps correctly to console.

### T+2:00 — Step 4: Gemma report
JS formats the log into labelled English. Two Gemma calls, two audiences.
Write one HTML file, open it.
**Verify:** full loop works end to end.

> ### THIS IS THE SAFETY POINT.
> A complete demo now exists. Commit. Everything after is upside.

### T+2:30 — Step 5: Greeting screen
First run asks one question: "What should we call you?" Free text. Save to
local JSON config.

Every launch after:
```
Good morning, Madam Tan.
Last time you did 8 knee lifts.     <- omit on first run
Ready for today?
```
Speak it: `speechSynthesis.speak(new SpeechSynthesisUtterance(text))`.
Built into Chromium. Offline. No dependency.
**Verify:** greets by name, speaks aloud, shows last session count.

### T+2:50 — Step 6: Instruction stick figure
Capture TWO poses from my live webcam during a dev session — start position
and end position — and save the landmark arrays to JSON. Interpolate
between them on a loop to animate the demonstration.

Do NOT record video. Do NOT build a video-to-landmark extractor.
Two keyframes and a lerp is enough.
**Verify:** figure loops the movement beside the live feed.

### T+3:10 — Step 7: Exercises 2 and 3
Seated arm raise, sit-to-stand. Config only: landmark triple, thresholds,
two keyframes, form-cue text. If this needs new code, step 2 was written
wrong — tell me.
**Verify:** all three work.

### T+3:30 — Step 8: UI pass
See Controls below.

### T+3:30 — STOP BUILDING
Rehearse twice on the demo machine.

---

## Controls — the entire interface

| Screen | Controls |
|---|---|
| Greeting | Language + age picker (first run) + One large **START** button. Small speaker icon to replay. Returning users with 2+ sessions also see a small progress chart (see exceptions below). |
| Exercise | One large **STOP** button. Dashboard overlay. Nothing else. |
| Report | Opens in the same window. **PRINT REPORT** and **HOME** buttons. |

Exercise selection: three large tiles on the greeting screen, or cycle
through all three in one session. Your call — whichever is less code.

**Sizing:** buttons min 200x80px. Body text min 20px. Labels min 28px.
Operable from 2m away.

**Rules:**
- Never more than 3 things on screen at once.
- Buttons are words, not icons. "STOP", not a glyph.
- High contrast. Dark on light. No grey-on-grey, no thin weights.
- No hover-only affordances, tooltips, dropdowns, modals, or settings.
- No countdown timers or progress bars — they create pressure.

**Exception — reset button.** A small circular icon button, top-right
corner, present on the greeting and exercise screens (not the report,
which is a separately loaded HTML file). Not for the patient — it's a
dev/demo control to wipe the local JSON config (name + last session)
before recording a demo, so the app comes back up as first-run.
Deliberately breaks the "words not icons" and sizing rules above; that's
fine, it's the one control never meant to be used by the person the rest
of this UI is designed for.

**Exception — language toggle.** A labeled button (current language's
own name, e.g. "中文"), top-right corner beside the reset dot, present on
the greeting and exercise screens. (Originally top-left; moved after it
was found to overlap the full-width status/exercise text there.) Unlike
the reset button, this one IS for the patient. Tapping it cycles through
English / Bahasa Melayu / தமிழ் / 中文 — no dropdown, so it doesn't fully
violate "no dropdowns," but it is a settings control, which the base
rules above say not to have. Kept anyway because language support only
works if it's reachable after onboarding, not just chosen once on first
run.

**Exception — age range picker.** Four large buttons (Under 60 / 60-69 /
70-79 / 80+), shown once on the first-run screen next to the name and
language prompts, same button-group pattern as the language picker (no
dropdown). Unlike language, this is captured once at onboarding only and
never shown again — it's demographic data for future personalization
(see [[rehabai-language-support]]-style deferred exercise-selection
idea), not a live preference the patient needs to re-toggle. Stored as
`ageRange` in the config JSON alongside `name` and `lang`.

**Exception — history chart (breaks "never more than 3 things" and the
"no charts" out-of-scope rule).** The returning-user greeting screen adds
a small canvas bar chart ("YOUR PROGRESS") showing rep counts for the
last up to 5 sessions, shown only once at least 2 sessions exist. Plain
`<canvas>`, drawn the same way as the pose overlay — no charting library
(the locked stack still forbids that). JS computes the bars and the
improving/declining/steady trend word from real numbers; Gemma is only
told the trend in words for the spoken greeting (same JS-computes/
Gemma-tones split as the reports), never asked to interpret raw numbers
itself. Each bar is colored by which of the three exercises that session
was (fixed `EXERCISE_COLORS` map in `renderer.js`, not computed — there
are only ever three), with a small colored-dot legend appearing once a
second exercise shows up in the recent window. User-authorized deviation
from the base "3 things on screen" and "no charts" rules — see "Out of
scope" below for the corresponding narrowing of the out-of-scope list.

**Language support.** English, Malay, Tamil, Mandarin. First run adds a
language-choice step next to the name prompt; the config JSON stores
`lang` alongside `name`. Fixed UI chrome (button labels, dashboard
labels, status text) comes from a static translated dictionary
(`i18n.js`) — it has to render instantly during the exercise loop, when
Gemma can't be called. Personalized text (the greeting, both reports)
is still generated live by Gemma with a "respond only in \<language\>"
instruction — same JS-computes-facts/Gemma-supplies-tone split as
everywhere else Gemma is used. Voice pronunciation quality for the
non-English languages depends on what TTS voices the OS has installed;
`speechSynthesis` is given the right BCP-47 language tag regardless.

---

## Gemma — how to call it

`POST http://localhost:11434/api/generate`

```json
{
  "model": "gemma4:e2b",
  "stream": false,
  "think": false,
  "system": "...",
  "prompt": "..."
}
```

- `"stream": false` — streaming returns line-delimited JSON per token.
- `"think": false` — without it, hidden reasoning tokens cost ~9s per call.
  Measured: 496 eval tokens for a 28-token answer. If the flag is rejected,
  check `ollama show gemma4:e2b`, find the equivalent, record it here.
- Model name is a constant, one place, easy to swap.
- Reply text is at `.response`.

**Warm the model on app launch** with a throwaway one-word prompt. Cold
load is seconds; warm is ~260ms.

**Boot sequence (brainstorm addition).** On launch, main process
health-checks `http://localhost:11434/`; if Ollama isn't up it spawns
`ollama serve` and polls until healthy (20s timeout, then continues
anyway rather than hanging the app). The window opens immediately and
shows "Starting Ollama..." / "Starting Gemma..." on the greeting screen
while this runs — makes the local-AI story visible instead of assumed.
The existing warm-up call above is the "Starting Gemma" step. Completion
is exposed as a promise (`await-boot` IPC), not just a push event, so
reloading the same window later (reset button, HOME button) resolves
instantly instead of waiting on a boot sequence that already finished.

**Never call Gemma while the camera is running.** MediaPipe uses the same
GPU. Reports generate only after STOP.

---

## NEVER send raw session JSON to Gemma

The model does not know what `bestRom: 71` means. Given raw JSON it
produces generic filler that never references real performance —
confirmed in testing.

Format into labelled English in JS first:

```
Completed 8 of 10 reps. Knee straightened furthest on rep 3
(71 degrees, up from 64 average). Rep 6 was weakest at 52 degrees.
Movement was steady with little wobble.
```

Every number labelled, with units. State comparisons explicitly.

**The rule: JS does the interpretation, Gemma does the tone.** All maths,
comparisons, and threshold checks happen in our code before the call.

---

## The two reports

Same formatted text, two system prompts, both in one HTML file, side by
side. This contrast IS the demo.

**Senior-facing:** warm, second person, short sentences, no jargon, no raw
numbers. One thing that went well, one thing to work on. Never alarming.

**Clinician-facing:** terse, clinical, numbers with units, flag asymmetry
and any rep where ROM dropped more than 15% from best. Observations only,
no advice.

Plain text output from both. No JSON.

---

## Technical decisions — already made

**Normalization.** Every frame: subtract hip midpoint, then divide by torso
length (shoulder midpoint to hip midpoint). Apply identically to live and
keyframe data.

**Ignore `z`.** Monocular depth is noise. 2D only.

**Exception (rep-counting angle math only):** at steep webcam lid angles
(~80-90 degrees), the thigh foreshortens in the 2D projection and a bent
vs. straight knee become indistinguishable no matter how thresholds are
tuned — confirmed by testing. `angleDegrees()` in `renderer.js` uses
x/y/z for this reason. Everything else (stick figure drawing, keyframe
interpolation, any future landmark math) stays 2D-only.

**Angles.** Three landmarks, dot product, degrees. That is the entire
"pose estimation". No classifier.

**Rep thresholds are calibrated, not hardcoded.** During the 2-second
position hold, the max knee angle observed at rest becomes the session's
`up` threshold; `down` is 10 degrees below it (`HYSTERESIS_MARGIN`). This
adapts to whatever camera angle is actually in use instead of assuming a
fixed rest angle.

**Mirroring.** The `#stage` container (holds both `<video>` and the overlay
`<canvas>`) is CSS-flipped with `transform: scaleX(-1)`, so the feed behaves
like a mirror for the person facing it. Landmark coordinates from MediaPipe
are left in raw (unflipped) camera space -- only the container is flipped,
so canvas drawing and any future angle math both work in that same raw
space without needing to flip x-coordinates themselves.

**Video timestamps** into VIDEO mode must strictly increase or it throws.

---

## Cut list

Behind schedule? Drop in this order:

1. Exercise 3
2. Instruction stick figure (step 6) — show text instructions instead
3. Exercise 2

**Never cut:** the Gemma report, or the greeting.

---

## Out of scope — do not build

Video calls. Login. Accounts. Databases. Emailing the doctor. Cloud
inference. Settings screens. Exercise prescription logic (fixed 3
exercises only — no AI-chosen exercises, reps, or dosage). Pause button.
Mobile. Anything using `z` (outside the documented rep-counting-angle
exception above).

**Narrowed exceptions (user-authorized, see Controls section above):**
- ~~Past-sessions browser~~ → in scope, but only as the single small
  "YOUR PROGRESS" bar chart on the returning-user greeting screen (last
  5 sessions' rep counts). No dedicated history screen, no per-session
  drill-down, no scrolling list of every session.
- ~~Charts~~ → in scope, but only that one bar chart, drawn with plain
  `<canvas>`. No charting library, no other charts anywhere else in the
  app (not in the report, which stays plain text per "The two reports").
