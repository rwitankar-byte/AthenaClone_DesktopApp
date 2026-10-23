const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createExamApp } = require("./app.js");

test("creates a session and returns its public status", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-backend-"));
  await fs.writeFile(
    path.join(dataDir, "questions.json"),
    JSON.stringify([
      {
        id: 1,
        question: "Which process creates BrowserWindow?",
        options: ["Renderer", "Main"],
        correctAnswer: 1,
      },
    ]),
  );
  await fs.writeFile(path.join(dataDir, "sessions.json"), "[]");

  const server = createExamApp({ dataDir }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const startResponse = await fetch(`${baseUrl}/exam/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "student-1", name: "Test Student" }),
    });
    const started = await startResponse.json();

    assert.equal(startResponse.status, 201);
    assert.match(started.sessionId, /^session-/);

    const sessionResponse = await fetch(
      `${baseUrl}/exam/session/${encodeURIComponent(started.sessionId)}`,
    );
    const session = await sessionResponse.json();

    assert.equal(sessionResponse.status, 200);
    assert.equal(session.status, "in-progress");
    assert.equal(session.userId, "student-1");
    assert.deepEqual(session.answers, []);
    assert.deepEqual(session.events, []);
    assert.equal(Object.hasOwn(session, "correctAnswer"), false);

    const questionResponse = await fetch(`${baseUrl}/exam/mcq/1`);
    const question = await questionResponse.json();
    assert.equal(questionResponse.status, 200);
    assert.equal(Object.hasOwn(question, "correctAnswer"), false);

    const event = {
      eventId: "2d8b7f42-1d9f-4f40-b7fa-2e0b1c7f2abc",
      sessionId: started.sessionId,
      eventType: "fullscreen-exit",
      timestamp: new Date().toISOString(),
      metadata: { source: "window-state" },
    };
    const firstEventResponse = await fetch(`${baseUrl}/exam/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    const firstEvent = await firstEventResponse.json();
    assert.equal(firstEventResponse.status, 201);
    assert.equal(firstEvent.event.category, "policy-signal");

    const duplicateEventResponse = await fetch(`${baseUrl}/exam/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    const duplicateEvent = await duplicateEventResponse.json();
    assert.equal(duplicateEventResponse.status, 200);
    assert.equal(duplicateEvent.duplicate, true);

    const invalidEventResponse = await fetch(`${baseUrl}/exam/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...event, eventId: "bad", eventType: "secret-data" }),
    });
    const invalidEvent = await invalidEventResponse.json();
    assert.equal(invalidEventResponse.status, 400);
    assert.equal(invalidEvent.error.code, "INVALID_EVENT");

    const staleEventResponse = await fetch(`${baseUrl}/exam/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...event,
        eventId: "603d9a20-49de-4b23-a61e-fc4f7ce5048e",
        timestamp: new Date(0).toISOString(),
      }),
    });
    assert.equal(staleEventResponse.status, 400);
    assert.equal((await staleEventResponse.json()).error.code, "INVALID_EVENT");

    const sessionWithEvent = await (
      await fetch(`${baseUrl}/exam/session/${encodeURIComponent(started.sessionId)}`)
    ).json();
    assert.equal(sessionWithEvent.events.length, 1);
    assert.equal(sessionWithEvent.events[0].eventId, event.eventId);

    const firstAnswerResponse = await fetch(`${baseUrl}/exam/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: started.sessionId,
        questionId: 1,
        selectedAnswer: 0,
      }),
    });
    assert.equal(firstAnswerResponse.status, 200);

    const changedAnswerResponse = await fetch(`${baseUrl}/exam/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: started.sessionId,
        questionId: 1,
        selectedAnswer: 1,
      }),
    });
    const changedAnswer = await changedAnswerResponse.json();
    assert.equal(changedAnswerResponse.status, 200);
    assert.equal(Object.hasOwn(changedAnswer, "isCorrect"), false);
    assert.equal(changedAnswer.attempted, 1);
    assert.equal(changedAnswer.correct, 1);

    const updatedSession = await (
      await fetch(`${baseUrl}/exam/session/${encodeURIComponent(started.sessionId)}`)
    ).json();
    assert.equal(updatedSession.answers.length, 1);
    assert.equal(updatedSession.answers[0].selectedAnswer, 1);
    assert.equal(Object.hasOwn(updatedSession.answers[0], "isCorrect"), false);

    const invalidSessionResponse = await fetch(`${baseUrl}/exam/session/not-valid`);
    const invalidSession = await invalidSessionResponse.json();
    assert.equal(invalidSessionResponse.status, 400);
    assert.equal(invalidSession.error.code, "INVALID_SESSION_ID");

    const firstSubmitResponse = await fetch(`${baseUrl}/exam/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: started.sessionId }),
    });
    const firstSubmit = await firstSubmitResponse.json();
    assert.equal(firstSubmitResponse.status, 200);
    assert.deepEqual(firstSubmit.result, { attempted: 1, correct: 1, wrong: 0 });

    const secondSubmitResponse = await fetch(`${baseUrl}/exam/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: started.sessionId }),
    });
    const secondSubmit = await secondSubmitResponse.json();
    assert.equal(secondSubmitResponse.status, 200);
    assert.deepEqual(secondSubmit.result, firstSubmit.result);

    const submittedSession = await (
      await fetch(`${baseUrl}/exam/session/${encodeURIComponent(started.sessionId)}`)
    ).json();
    assert.equal(submittedSession.status, "submitted");
    assert.ok(submittedSession.submittedAt);

    const lateEventResponse = await fetch(`${baseUrl}/exam/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...event, eventId: "603d9a20-49de-4b23-a61e-fc4f7ce5048e" }),
    });
    assert.equal(lateEventResponse.status, 409);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("returns a structured error when event persistence is unavailable", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-backend-events-"));
  await fs.writeFile(path.join(dataDir, "questions.json"), "[]");
  await fs.mkdir(path.join(dataDir, "sessions.json"));
  const server = createExamApp({ dataDir }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/exam/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "student-1", name: "Test Student" }),
    });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.error.code, "DATASTORE_UNAVAILABLE");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
