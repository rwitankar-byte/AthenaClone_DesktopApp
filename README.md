# Athena Exam Desktop App

An Electron desktop examination client with a React/Vite renderer, a small
Express exam backend, local camera previews/snapshots, deadline-based timing,
fullscreen/focus signals, and backend-authoritative scoring.

## Prerequisites

- Node.js 18 or newer and npm
- A working camera for proctored-exam flows
- macOS, Windows, or Linux with permission to use the camera

## Install and run

Install each package once:

```bash
cd athena-backend && npm install
cd ../athena-frontend && npm install
```

Run the backend, Vite renderer, and Electron shell in three terminals:

```bash
# terminal 1
cd athena-backend && npm start

# terminal 2
cd athena-frontend && npm run dev:react

# terminal 3
cd athena-frontend && npm run dev:electron
```

The default backend is `http://localhost:3000`; set
`VITE_EXAM_BACKEND_URL` before starting/building the frontend to use another
backend, and set `EXAM_BACKEND_PORT` when starting the backend. The configured
origin must also be allowed by the deployment CSP and CORS policy.

## Architecture

- `athena-frontend/src/` contains the React onboarding and exam lifecycle.
- `athena-frontend/src/examApi.js` is the renderer's bounded HTTP client. It
  never receives correct answers.
- `athena-frontend/electron/main.cjs` owns the BrowserWindow, timer persistence,
  fullscreen state, sender-validated IPC, navigation restrictions, and camera
  permission policy.
- `athena-frontend/electron/preload.cjs` exposes only explicit APIs for timer,
  window state, and validated snapshot bytes. Node integration is disabled,
  context isolation and sandboxing are enabled, and DevTools are development-only.
- `athena-backend/app.js` validates sessions, questions, answers, event payloads,
  and finalization. Correct answers and scoring remain server-side.
- The backend uses asynchronous atomic JSON writes with an in-process write
  queue. Use a real transactional database before deploying multiple backend
  processes.

## Camera and proctoring behavior

Camera access is requested only after the user clicks the camera action. The
live stream stays in the renderer; tracks are stopped on disable, camera
failure, submission, and unmount. During an active accepted exam, a still image
is captured immediately and then every five seconds when supported by the
already-authorized stream. Images are saved locally under the Electron user-data
directory in `snapshots/`; they are not uploaded by this application. The
current implementation does not automatically delete snapshots, so operators
must provide a retention/deletion policy before production use.

Events contain only a UUID, session ID, event type/category, timestamp, and a
small allowlisted metadata object. Technical failures and policy signals are
kept distinct; a focus loss or fullscreen exit is not proof of cheating.
Events are retried at most twice after the initial request and are capped at
1,000 stored events per session.

The OS still controls camera permissions and can interrupt a device. Electron
fullscreen is not kiosk mode and cannot prevent every OS shortcut or access to
other applications.

## Checks

```bash
cd athena-backend
npm test
node --check app.js
node --check server.js

cd ../athena-frontend
npm test
npm run lint
npm run build
```

For a manual end-to-end check, start both services, enter a student identity,
accept the rules, grant camera permission, enter fullscreen, start an exam,
answer/change an answer, refresh once to verify recovery, exit fullscreen,
disconnect or deny the camera, submit, and retry the submit action. Confirm
the results screen appears only after the backend returns success and that an
already-submitted session cannot return to the active exam.

## Known limitations

- JSON persistence is suitable for local development and one backend process,
  not concurrent production traffic or multi-device identity verification.
- Snapshots and event records are local/plain application data; encryption,
  retention automation, authenticated users, and server-side audit controls are
  still required for production.
- The app records technical and possible policy signals but does not reliably
  detect all cheating and makes no automatic punitive decision.
- Real hardware permission denial, camera disconnection, OS focus behavior, and
  packaging/signing require manual verification on each target platform.
