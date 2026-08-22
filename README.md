# Rehab Coach

An adherence and logging tool for a clinician-prescribed home exercise plan.
It watches a senior perform prescribed exercises via webcam, counts reps and
tracks form, and generates a plain-English session report. It does **not**
prescribe exercise.

## Loop

Open app -> greeting by name -> click START -> "get into position" check ->
stick figure demonstrates the move -> senior copies it while a live
dashboard shows reps, angle, and form -> click STOP -> HTML report opens.

Three exercises: seated knee extension, seated arm raise, sit-to-stand.

## Stack

| Thing | Choice |
|---|---|
| Shell | Electron |
| Pose tracking | `@mediapipe/tasks-vision`, running locally in the renderer |
| Render | HTML5 canvas overlay on the webcam feed |
| Report language | [Ollama](https://ollama.com) running `gemma4:e2b` locally at `http://localhost:11434` |
| Report output | Plain HTML file on disk, opened with `shell.openPath` |
| State | Plain JS objects + one local JSON config file |

No cloud APIs, no database, no accounts. Pose tracking and report
generation both run entirely on-device.

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
