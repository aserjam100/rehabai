# Rehab Coach

An adherence and logging tool for a clinician-prescribed home exercise plan.
It watches a senior perform prescribed exercises via webcam, counts reps and
tracks form, and generates a plain-English session report. It does **not**
prescribe exercise.

## Loop

Open app -> greeting by name (spoken aloud) -> tap an exercise tile ->
"get into position" check -> labelled demo images show the move ->
senior copies it while a live dashboard shows reps, angle, and form ->
click STOP, or hold crossed arms for 2 seconds -> HTML report opens in
the same window, side by side: one plain-language column for the senior,
one clinical column for the clinician.

Three exercises: seated knee extension (alternating legs), seated arm
raise, sit-to-stand. Returning users also see a small progress chart and,
once there's enough repeated-exercise history, a cross-session
"clinician flags" digest surfacing multi-session patterns (declining
range of motion, persistent left/right asymmetry).

## Stack

| Thing | Choice |
|---|---|
| Shell | Electron |
| Pose tracking | `@mediapipe/tasks-vision`, running locally in the renderer |
| Render | HTML5 canvas overlay on the webcam feed |
| Report language | [Ollama](https://ollama.com) running `gemma4:e2b` locally at `http://localhost:11434` |
| Report output | Plain HTML file on disk, loaded into the same window (`webContents.loadFile`) |
| State | Plain JS objects + one local JSON config file |

No cloud APIs, no database, no accounts. Pose tracking and report
generation both run entirely on-device.

## Hackathon track fit

### Track 1 — Best Use of Gemma

| Brief | Status | How |
|---|---|---|
| Run privately or at the edge | Done | The entire pipeline runs on-device: pose tracking (`@mediapipe/tasks-vision`) in the renderer, and Gemma (`gemma4:e2b`) via Ollama at `localhost:11434`. No cloud LLM or vision API call exists anywhere in the app. |
| Adapt the model for a specific community | Done | Two audience-specific system prompts generate different text from the same session data — warm, plain-language, no-numbers for the senior; terse, clinical, numbers-with-units for the clinician. Both Gemma's output and the static UI are localized to English, Bahasa Melayu, Tamil, and Mandarin, aimed at a specific elderly community rather than an English-only demo. |
| Make openness essential to the product | Done | Session data — webcam-derived joint angles, rep counts, asymmetry — never leaves the device. That privacy guarantee only holds because the model runs locally; routing it through a cloud LLM would break the product's core promise, not just its cost profile. |

### Track 2 — Best Elderly Hack

| Brief | Status | How |
|---|---|---|
| Empathetic | Done | The senior-facing report and greeting are Gemma-generated in a warm, second-person, never-alarming tone. UI rules throughout (200x80px+ buttons, 20px+ body text, high contrast, no countdown timers or progress bars) are written for a senior operating the app alone, from 2m away. |
| Voice-first | Partial | Greeting and reports are spoken aloud offline (`speechSynthesis`), and a crossed-arms hold-to-stop gesture removes the need to walk to a button mid-exercise. There's no voice *input* — deliberately skipped, since the available options either required a cloud speech-recognition API (breaking the offline/privacy story above) or a heavy local model competing with MediaPipe for the GPU. The gesture-based stop was built as the offline-compatible alternative. |
| Context-aware | Done | Rep-counting thresholds are calibrated per session from the person's own rest pose rather than hardcoded. Session history drives a progress chart, trend-aware greetings, and a cross-session clinician flags digest that surfaces patterns (declining range of motion, persistent asymmetry) no single session would show. |
| Family caregivers / eldercare communities | Partial | The clinician-facing report and flags digest are written for a caregiver or clinician to read — printable, terse, numbers-first, observations only. There's no notification, sharing, or account layer to reach them directly; that's out of scope for this build. |

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
