const EXAM_BACKEND_URL = (
  import.meta.env.VITE_EXAM_BACKEND_URL || "http://localhost:3000"
).replace(/\/$/, "");

async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${EXAM_BACKEND_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { "content-type": "application/json", ...options.headers },
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new Error("The exam backend returned malformed data");
    }
    if (!response.ok) {
      throw new Error(body?.error?.message || body?.message || `Backend error (${response.status})`);
    }
    return body;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("The exam backend timed out", { cause: error });
    }
    if (error instanceof TypeError) {
      throw new Error("The exam backend is unavailable", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function startExamSession({ userId, name }) {
  return request("/exam/start", {
    method: "POST",
    body: JSON.stringify({ userId, name }),
  });
}

export function getExamSession(sessionId) {
  return request(`/exam/session/${encodeURIComponent(sessionId)}`);
}

export function getExamQuestions() {
  return request("/exam/mcq");
}

export function getExamQuestionTotal() {
  return request("/exam/mcq/total");
}

export function saveExamAnswer({ sessionId, questionId, selectedAnswer }) {
  return request("/exam/answer", {
    method: "POST",
    body: JSON.stringify({ sessionId, questionId, selectedAnswer }),
  });
}

export function submitExamSession(sessionId) {
  return request("/exam/submit", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

export { EXAM_BACKEND_URL };
