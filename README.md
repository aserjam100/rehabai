# Rehab Coach

Adherence and logging tool for a clinician-prescribed home exercise plan.
Watches a senior do prescribed exercises via webcam, counts reps, tracks
form, and generates a plain-English session report. Does **not**
prescribe exercise.

## How it works

Greeting by name (spoken aloud) -> tap an exercise tile -> get into
position -> demo images show the move, senior copies it while a live
dashboard tracks reps/angle/form -> stop (button, or hold crossed arms
for 2s) -> report opens: one column for the senior, one for the
clinician.

Three exercises: seated knee extension, seated arm raise, sit-to-stand.
Returning users also see a progress chart and, once there's enough
history, a cross-session "clinician flags" digest.

## Stack

| Thing | Choice |
|---|---|
| Shell | Electron |
| Pose tracking | `@mediapipe/tasks-vision`, local, in the renderer |
| Render | HTML5 canvas overlay on the webcam feed |
| Report language | [Ollama](https://ollama.com) running `gemma4:e2b` locally |
| State | Plain JS objects + one local JSON config file |

No cloud APIs, no database, no accounts — everything runs on-device.

## Track fit

**Track 1 — Best Use of Gemma**
- Runs entirely locally via Ollama, no cloud LLM call anywhere
- Two audience prompts (warm/plain for the senior, clinical for the clinician) from the same session data
- Localized to English, Bahasa Melayu, Tamil, Mandarin
- Local-only inference is what makes the privacy promise possible — session data never leaves the device

**Track 2 — Best Elderly Hack**
- Empathetic: warm, never-alarming Gemma-written reports; large text/buttons, no timers or pressure cues
- Voice: greeting + reports spoken aloud offline; hands-free stop via a crossed-arms gesture (no voice *input* — would've needed a cloud speech API or a GPU-competing local model)
- Context-aware: thresholds calibrated per session; progress chart + cross-session clinician flags digest
- Caregiver-facing: printable clinical report and flags digest (no notifications/accounts — out of scope)

## Running it

```
npm install
npm start
```

For the session report step, [Ollama](https://ollama.com) must be running
locally with the `gemma4:e2b` model pulled:

```
ollama pull gemma4:e2b
```
