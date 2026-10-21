const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const express = require("express");
const cors = require("cors");

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requiredText(value, field, maxLength = 120) {
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_INPUT", `${field} must be a string`);
  }
  const text = value.trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new HttpError(400, "INVALID_INPUT", `${field} is invalid`);
  }
  return text;
}

function validateSessionId(value) {
  const sessionId = requiredText(value, "sessionId", 100);
  if (!/^session-[A-Za-z0-9-]{8,99}$/.test(sessionId)) {
    throw new HttpError(400, "INVALID_SESSION_ID", "sessionId is invalid");
  }
  return sessionId;
}

function validateQuestionId(value) {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new HttpError(400, "INVALID_QUESTION_ID", "questionId is invalid");
  }
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new HttpError(400, "INVALID_QUESTION_ID", "questionId is invalid");
  }
  const questionId = Number(text);
  if (!Number.isSafeInteger(questionId) || questionId < 1) {
    throw new HttpError(400, "INVALID_QUESTION_ID", "questionId is invalid");
  }
  return questionId;
}

function publicQuestion(question) {
  return { id: question.id, question: question.question, options: question.options };
}

function publicSession(session) {
  return {
    sessionId: session.sessionId,
    userId: session.userId,
    name: session.name,
    startedAt: session.startedAt,
    submittedAt: session.submittedAt,
    status: session.status,
    attempted: session.attempted,
    correct: session.correct,
    wrong: session.wrong,
    answers: session.answers.map(({ isCorrect, ...answer }) => answer),
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw new HttpError(500, "DATASTORE_UNAVAILABLE", "Exam data is unavailable");
  }
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(temporaryPath, filePath);
  } catch {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new HttpError(500, "DATASTORE_UNAVAILABLE", "Exam data could not be saved");
  }
}

function createSessionStore(sessionsPath) {
  let writeQueue = Promise.resolve();

  // JSON storage is single-process; use a database transaction before scaling out.
  return {
    read: () => readJson(sessionsPath, []),
    update(mutator) {
      const operation = writeQueue.then(async () => {
        const sessions = await readJson(sessionsPath, []);
        const result = await mutator(sessions);
        await writeJsonAtomically(sessionsPath, sessions);
        return result;
      });
      writeQueue = operation.catch(() => undefined);
      return operation;
    },
  };
}

function createExamApp({ dataDir = path.join(__dirname, "data") } = {}) {
  const questionsPath = path.join(dataDir, "questions.json");
  const sessionStore = createSessionStore(path.join(dataDir, "sessions.json"));
  const app = express();

  app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
  app.use(express.json({ limit: "64kb" }));
  app.get("/", (_req, res) => res.json({ message: "Exam backend is running" }));

  // Validate identity before persistence; the generated ID is the only client handle.
  app.post("/exam/start", async (req, res, next) => {
    try {
      const userId = requiredText(req.body?.userId, "userId");
      const name = requiredText(req.body?.name, "name");
      const session = {
        sessionId: `session-${Date.now()}-${crypto.randomUUID()}`,
        userId,
        name,
        startedAt: new Date().toISOString(),
        submittedAt: null,
        status: "in-progress",
        attempted: 0,
        correct: 0,
        wrong: 0,
        answers: [],
      };
      await sessionStore.update((sessions) => sessions.push(session));
      res.status(201).json({ message: "Exam session started", sessionId: session.sessionId });
    } catch (error) {
      next(error);
    }
  });

  app.get("/exam/mcq/total", async (_req, res, next) => {
    try {
      const questions = await readJson(questionsPath);
      res.json({ total: questions.length });
    } catch (error) {
      next(error);
    }
  });

  const getQuestion = async (req, res, next) => {
    try {
      const questionId = validateQuestionId(req.params.id);
      const questions = await readJson(questionsPath);
      const question = questions.find((item) => item.id === questionId);
      if (!question) throw new HttpError(404, "QUESTION_NOT_FOUND", "Question not found");
      res.json(publicQuestion(question));
    } catch (error) {
      next(error);
    }
  };
  app.get("/exam/mcq/:id", getQuestion);

  app.get("/exam/mcq", async (_req, res, next) => {
    try {
      const questions = await readJson(questionsPath);
      res.json(questions.map(publicQuestion));
    } catch (error) {
      next(error);
    }
  });

  app.post("/exam/answer", async (req, res, next) => {
    try {
      const sessionId = validateSessionId(req.body?.sessionId);
      const questionId = validateQuestionId(req.body?.questionId);
      const selectedAnswer = req.body?.selectedAnswer;
      if (!Number.isInteger(selectedAnswer) || selectedAnswer < 0) {
        throw new HttpError(400, "INVALID_ANSWER", "selectedAnswer must be an option index");
      }
      const questions = await readJson(questionsPath);
      const question = questions.find((item) => item.id === questionId);
      if (!question) throw new HttpError(404, "QUESTION_NOT_FOUND", "Question not found");
      if (selectedAnswer >= question.options.length) {
        throw new HttpError(400, "INVALID_ANSWER", "selectedAnswer is out of range");
      }

      const result = await sessionStore.update((sessions) => {
        const session = sessions.find((item) => item.sessionId === sessionId);
        if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "Session not found");
        if (session.status !== "in-progress") {
          throw new HttpError(409, "SESSION_COMPLETED", "Exam is already submitted");
        }
        const isCorrect = selectedAnswer === question.correctAnswer;
        const existingAnswer = session.answers.find(
          (answer) => answer.questionId === questionId,
        );

        if (existingAnswer) {
          // Answers are saved immediately and may be changed before submission.
          if (existingAnswer.isCorrect !== isCorrect) {
            if (isCorrect) {
              session.correct += 1;
              session.wrong -= 1;
            } else {
              session.correct -= 1;
              session.wrong += 1;
            }
          }
          existingAnswer.selectedAnswer = selectedAnswer;
          existingAnswer.isCorrect = isCorrect;
          existingAnswer.answeredAt = new Date().toISOString();
        } else {
          session.answers.push({ questionId, selectedAnswer, isCorrect, answeredAt: new Date().toISOString() });
          session.attempted += 1;
          if (isCorrect) session.correct += 1;
          else session.wrong += 1;
        }
        return { isCorrect, attempted: session.attempted, correct: session.correct, wrong: session.wrong };
      });
      const { isCorrect: _isCorrect, ...publicResult } = result;
      res.json({ message: "Answer saved", ...publicResult });
    } catch (error) {
      next(error);
    }
  });

  app.get("/exam/session/:sessionId", async (req, res, next) => {
    try {
      const sessionId = validateSessionId(req.params.sessionId);
      const sessions = await sessionStore.read();
      const session = sessions.find((item) => item.sessionId === sessionId);
      if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "Session not found");
      res.json(publicSession(session));
    } catch (error) {
      next(error);
    }
  });

  app.post("/exam/submit", async (req, res, next) => {
    try {
      const sessionId = validateSessionId(req.body?.sessionId);
      const result = await sessionStore.update((sessions) => {
        const session = sessions.find((item) => item.sessionId === sessionId);
        if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", "Session not found");
        if (session.status !== "in-progress") {
          // Finalization is idempotent: retries return the recorded result and
          // never replace the original submittedAt timestamp.
          return { attempted: session.attempted, correct: session.correct, wrong: session.wrong };
        }
        session.status = "submitted";
        session.submittedAt = new Date().toISOString();
        return { attempted: session.attempted, correct: session.correct, wrong: session.wrong };
      });
      res.json({ message: "Exam submitted successfully", result });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && error.status === 400) {
      return res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is invalid JSON" } });
    }
    const status = error.status || 500;
    res.status(status).json({
      error: {
        code: error.code || "INTERNAL_ERROR",
        message: status === 500 ? "The exam backend could not complete the request" : error.message,
      },
    });
  });
  return app;
}

module.exports = { createExamApp };
