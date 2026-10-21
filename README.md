# Athena Exam App — Student Setup Guide

## Prerequisites
- [Node.js](https://nodejs.org/) (v18 or later) and npm installed
- Git installed

## 1. Clone the repository
```bash
git clone https://github.com/JACOBIAN01/athena-exam.git
cd athena-exam
```

## 2. Set up the backend
Open a terminal and run:
```bash
cd athena-backend
npm install
npm start
```
This starts the backend server at `http://localhost:3000`. Leave this terminal running.
The port can be changed with `EXAM_BACKEND_PORT=3100 npm start`.

## 3. Set up the frontend
Open a **second** terminal and run:
```bash
cd athena-exam/athena-frontend
npm install
npm install --save-dev electron
npm run dev:react
```
This starts the Vite dev server at `http://localhost:5173`. Leave this terminal running too.
The frontend uses `http://localhost:3000` by default. To use another backend, set
`VITE_EXAM_BACKEND_URL` before building or starting Vite, for example:
```bash
VITE_EXAM_BACKEND_URL=http://localhost:3100 npm run dev:react
```

## 4. Launch the Electron app
Open a **third** terminal and run:
```bash
cd athena-exam/athena-frontend
npm run dev:electron
```
This opens the Electron desktop window, which loads the app from the Vite dev server.

## Summary
| Terminal | Folder | Command | Purpose |
|---|---|---|---|
| 1 | `athena-backend` | `npm start` | Runs API on port 3000 |
| 2 | `athena-frontend` | `npm run dev:react` | Runs UI on port 5173 |
| 3 | `athena-frontend` | `npm run dev:electron` | Opens the desktop app window |

> All three terminals must stay open at the same time for the app to work.

## Backend checks

Run the backend session/connectivity test with:
```bash
cd athena-backend
npm test
```

The backend creates sessions through `POST /exam/start` and the frontend stores
the returned session ID for refresh recovery. `GET /exam/session/:sessionId`
checks that the saved session is still available. Questions never include their
`correctAnswer` field in responses.
