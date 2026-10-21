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
    assert.equal(Object.hasOwn(session, "correctAnswer"), false);

    const questionResponse = await fetch(`${baseUrl}/exam/mcq/1`);
    const question = await questionResponse.json();
    assert.equal(questionResponse.status, 200);
    assert.equal(Object.hasOwn(question, "correctAnswer"), false);

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
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
