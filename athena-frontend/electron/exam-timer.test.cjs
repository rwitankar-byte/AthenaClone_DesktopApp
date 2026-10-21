const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_EXAM_DURATION_MS,
  completeTimerState,
  createTimerState,
  getRemainingMs,
  isExpired,
} = require("./exam-timer.cjs");

test("creates a deadline from one reliable start timestamp", () => {
  const startedAt = 1_000_000;
  const state = createTimerState(startedAt);

  assert.equal(state.startedAt, startedAt);
  assert.equal(state.deadlineAt, startedAt + DEFAULT_EXAM_DURATION_MS);
  assert.equal(state.status, "active");
});

test("calculates remaining time from the deadline instead of interval count", () => {
  const state = createTimerState(1_000_000);

  assert.equal(getRemainingMs(state, 1_000_001), DEFAULT_EXAM_DURATION_MS - 1);
  assert.equal(getRemainingMs(state, state.deadlineAt + 1000), 0);
  assert.equal(isExpired(state, state.deadlineAt), true);
});

test("does not restart an existing active timer", () => {
  const state = createTimerState(1_000_000);

  assert.equal(createTimerState(state.startedAt).deadlineAt, state.deadlineAt);
});

test("completion is idempotent", () => {
  const state = createTimerState(1_000_000);
  const submitted = completeTimerState(state, "time-expired", state.deadlineAt);

  assert.equal(submitted.status, "submitted");
  assert.equal(completeTimerState(submitted, "manual"), submitted);
});
