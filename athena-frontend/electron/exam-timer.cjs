const DEFAULT_EXAM_DURATION_MS = 60 * 60 * 1000;

function createTimerState(startedAt = Date.now()) {
  return {
    status: "active",
    startedAt,
    deadlineAt: startedAt + DEFAULT_EXAM_DURATION_MS,
    durationMs: DEFAULT_EXAM_DURATION_MS,
    completedAt: null,
    completionReason: null,
    rulesAccepted: true,
  };
}

function getRemainingMs(state, now = Date.now()) {
  if (!state || state.status !== "active") return 0;
  return Math.max(0, state.deadlineAt - now);
}

function isExpired(state, now = Date.now()) {
  return state?.status === "active" && getRemainingMs(state, now) === 0;
}

function completeTimerState(state, reason, completedAt = Date.now()) {
  if (!state || state.status !== "active") return state;

  return {
    ...state,
    status: "submitted",
    completedAt,
    completionReason: reason,
  };
}

module.exports = {
  DEFAULT_EXAM_DURATION_MS,
  completeTimerState,
  createTimerState,
  getRemainingMs,
  isExpired,
};
