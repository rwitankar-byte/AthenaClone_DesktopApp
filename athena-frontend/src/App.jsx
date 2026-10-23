import { useCallback, useEffect, useRef, useState } from "react";
import {
  getExamQuestionTotal,
  getExamQuestions,
  getExamSession,
  recordExamEvent,
  saveExamAnswer,
  startExamSession,
  submitExamSession,
} from "./examApi";

const CAMERA_STATUS = {
  NOT_CONFIGURED: "not-configured",
  REQUESTING: "requesting",
  READY: "ready",
  UNAVAILABLE: "unavailable",
};
const SNAPSHOT_INTERVAL_MS = 5000;

function formatTimeLeft(remainingMs) {
  const totalMinutes = Math.ceil(Math.max(0, remainingMs) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function readStoredSessionId() {
  try {
    return localStorage.getItem("athena.examSessionId") || "";
  } catch {
    return "";
  }
}

function storeSessionId(sessionId) {
  try {
    localStorage.setItem("athena.examSessionId", sessionId);
  } catch {
    // Session recovery is best effort; the backend remains authoritative.
  }
}

function stopMediaStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

function stopSnapshotTimer(timerRef, generationRef) {
  generationRef.current += 1;
  if (timerRef.current !== null) {
    clearInterval(timerRef.current);
    timerRef.current = null;
  }
}

async function captureImageBytes(videoRef, imageCaptureRef, canvasRef) {
  if (imageCaptureRef.current) {
    try {
      const photo = await imageCaptureRef.current.takePhoto();
      if (photo) return photo.arrayBuffer();
    } catch {
      // Fall back to the displayed video frame when ImageCapture is unavailable.
    }
  }

  const video = videoRef.current;
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    throw new Error("Camera preview is not ready");
  }

  const canvas = canvasRef.current || document.createElement("canvas");
  canvasRef.current = canvas;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("Snapshot canvas is unavailable");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const photo = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.85),
  );
  if (!photo) throw new Error("Snapshot encoding failed");
  return photo.arrayBuffer();
}

function getCameraErrorMessage(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Camera permission was denied. Allow camera access and try again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera was found. Connect a camera before continuing.";
    case "NotReadableError":
    case "TrackStartError":
      return "The camera is unavailable or already in use by another app.";
    case "SecurityError":
      return "Camera access is blocked by the current security settings.";
    case "AbortError":
      return "Camera access was interrupted. Please try again.";
    default:
      return "The camera could not be started. Please try again.";
  }
}

function App() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const imageCaptureRef = useRef(null);
  const canvasRef = useRef(null);
  const requestInFlightRef = useRef(false);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(false);
  const captureTimerRef = useRef(null);
  const captureInFlightRef = useRef(false);
  const captureGenerationRef = useRef(0);
  const examActiveRef = useRef(false);
  const examTimerIntervalRef = useRef(null);
  const examStartInFlightRef = useRef(false);
  const examExpiryHandledRef = useRef(false);
  const answerInFlightRef = useRef(new Set());
  const submissionInFlightRef = useRef(false);
  const backendFinalizationPromiseRef = useRef(null);
  const lastViolationAtRef = useRef(new Map());
  const eventRetryTimersRef = useRef(new Set());
  const lastCaptureFailureAtRef = useRef(0);
  const examStartEventSessionRef = useRef("");
  const submissionEventKeysRef = useRef(new Set());
  const [cameraStatus, setCameraStatus] = useState(
    CAMERA_STATUS.NOT_CONFIGURED,
  );
  const [statusMessage, setStatusMessage] = useState(
    "Camera access has not been requested.",
  );
  const [rulesAccepted, setRulesAccepted] = useState(false);
  const [studentId, setStudentId] = useState("");
  const [studentName, setStudentName] = useState("");
  const [sessionId, setSessionId] = useState(readStoredSessionId);
  const [backendStatus, setBackendStatus] = useState(
    readStoredSessionId() ? "checking" : "not-connected",
  );
  const [backendError, setBackendError] = useState("");
  const [questions, setQuestions] = useState([]);
  const [questionCount, setQuestionCount] = useState(0);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [questionError, setQuestionError] = useState("");
  const [answerSavingId, setAnswerSavingId] = useState(null);
  const [submissionWarning, setSubmissionWarning] = useState(0);
  const [submissionConfirmation, setSubmissionConfirmation] = useState(false);
  const [submissionInFlight, setSubmissionInFlight] = useState(false);
  const [examResult, setExamResult] = useState(null);
  const [finalizationStatus, setFinalizationStatus] = useState("idle");
  const [examActive, setExamActive] = useState(false);
  const [captureStatus, setCaptureStatus] = useState(
    "Snapshots are off until you start the exam.",
  );
  const [examTimerState, setExamTimerState] = useState({ status: "idle" });
  const [remainingMs, setRemainingMs] = useState(0);
  const [timerError, setTimerError] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenRequesting, setFullscreenRequesting] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const [fullscreenRecoveryRequired, setFullscreenRecoveryRequired] =
    useState(false);
  const [violations, setViolations] = useState([]);

  const applyExamTimerState = useCallback((nextState) => {
    if (!nextState || !["idle", "active", "submitted"].includes(nextState.status)) {
      return;
    }

    const nextRemainingMs = Number.isFinite(nextState.remainingMs)
      ? nextState.remainingMs
      : 0;
    setExamTimerState(nextState);
    setRemainingMs(nextRemainingMs);

    if (nextState.status === "active") {
      examExpiryHandledRef.current = false;
      examActiveRef.current = true;
      setExamActive(true);
      if (nextState.rulesAccepted) setRulesAccepted(true);
      return;
    }

    if (nextState.status === "submitted") {
      stopSnapshotTimer(captureTimerRef, captureGenerationRef);
      examActiveRef.current = false;
      setExamActive(false);
      setFullscreenRecoveryRequired(false);
      setFinalizationStatus((current) =>
        current === "succeeded" ? current : "pending",
      );
      if (!examExpiryHandledRef.current && nextState.completionReason === "time-expired") {
        examExpiryHandledRef.current = true;
        setCaptureStatus("Time expired; the exam was submitted automatically.");
      }
    }
  }, []);

  const finishExam = useCallback(async (reason) => {
    if (!window.electronAPI?.finishExam) return null;

    try {
      const nextState = await window.electronAPI.finishExam(reason);
      applyExamTimerState(nextState);
      return nextState;
    } catch {
      setTimerError("The exam state could not be saved. Please try again.");
      return null;
    }
  }, [applyExamTimerState]);

  const finalizeBackendSession = useCallback(() => {
    if (!sessionId) return Promise.reject(new Error("No exam session is available"));
    // Share one finalization promise so timer expiry, clicks, and retries cannot
    // race separate requests; the backend remains the scoring authority.
    if (backendFinalizationPromiseRef.current) {
      return backendFinalizationPromiseRef.current;
    }

    const request = (async () => {
      const currentSession = await getExamSession(sessionId);
      if (currentSession.status === "submitted") {
        return {
          attempted: currentSession.attempted,
          correct: currentSession.correct,
          wrong: currentSession.wrong,
        };
      }
      const submission = await submitExamSession(sessionId);
      return submission.result;
    })();

    backendFinalizationPromiseRef.current = request;
    request.then(
      () => {
        if (backendFinalizationPromiseRef.current === request) {
          backendFinalizationPromiseRef.current = null;
        }
      },
      () => {
        if (backendFinalizationPromiseRef.current === request) {
          backendFinalizationPromiseRef.current = null;
        }
      },
    );
    return request;
  }, [sessionId]);

  const submitBackendSession = useCallback(async () => {
    setFinalizationStatus("pending");
    try {
      const result = await finalizeBackendSession();
      setExamResult(result);
      if (examTimerState.status === "active") {
        const localState = await finishExam("manual");
        if (!localState) throw new Error("Local exam finalization failed");
      }
      setFinalizationStatus("succeeded");
      setBackendStatus("connected");
      return true;
    } catch (error) {
      setFinalizationStatus("failed");
      setBackendStatus("error");
      setBackendError(error.message);
      return false;
    }
  }, [examTimerState.status, finalizeBackendSession, finishExam]);

  const recordExamEventWithRetry = useCallback((eventType, metadata = {}) => {
    if (!sessionId) return;
    let attempt = 0;
    const send = () => {
      attempt += 1;
      recordExamEvent({ sessionId, eventType, metadata }).catch(() => {
        if (attempt >= 3) return;
        const timer = setTimeout(() => {
          eventRetryTimersRef.current.delete(timer);
          send();
        }, attempt * 500);
        eventRetryTimersRef.current.add(timer);
      });
    };
    send();
  }, [sessionId]);

  const recordSubmissionEvent = useCallback((eventType, metadata) => {
    const key = `${sessionId}:${eventType}`;
    if (!sessionId || submissionEventKeysRef.current.has(key)) return;
    submissionEventKeysRef.current.add(key);
    recordExamEventWithRetry(eventType, metadata);
  }, [recordExamEventWithRetry, sessionId]);

  const recordViolation = useCallback((type) => {
    const now = Date.now();
    const lastDetectedAt = lastViolationAtRef.current.get(type) || 0;
    if (now - lastDetectedAt < 1000) return;
    lastViolationAtRef.current.set(type, now);

    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${now}-${type}`;
    setViolations((current) => [
      ...current.slice(-99),
      {
        id,
        type,
        detectedAt: new Date(now).toISOString(),
        confirmed: false,
      },
    ]);
    recordExamEventWithRetry(type, { source: "window-state" });
  }, [recordExamEventWithRetry]);

  useEffect(() => {
    examActiveRef.current = examActive;
  }, [examActive]);

  useEffect(() => {
    if (
      examActive &&
      examTimerState.status === "active" &&
      sessionId &&
      examStartEventSessionRef.current !== sessionId
    ) {
      examStartEventSessionRef.current = sessionId;
      recordExamEventWithRetry("exam-start", { source: "renderer" });
    }
  }, [examActive, examTimerState.status, recordExamEventWithRetry, sessionId]);

  useEffect(() => {
    if (!window.electronAPI?.onWindowStateChange) return undefined;

    function handleWindowStateChange(state) {
      if (
        !state ||
        typeof state.fullscreen !== "boolean" ||
        typeof state.focused !== "boolean"
      ) {
        return;
      }

      setFullscreen(state.fullscreen);
      if (!examActiveRef.current) return;

      if (!state.fullscreen) {
        recordViolation("fullscreen-exit");
        setFullscreenRecoveryRequired(true);
      } else {
        setFullscreenRecoveryRequired(false);
      }
      if (!state.focused) recordViolation("window-focus-loss");
    }

    const unsubscribe = window.electronAPI.onWindowStateChange(
      handleWindowStateChange,
    );
    window.electronAPI
      .getWindowState?.()
      .then(handleWindowStateChange)
      .catch(() => undefined);

    return () => unsubscribe?.();
  }, [recordViolation]);

  useEffect(() => {
    mountedRef.current = true;
    const video = videoRef.current;
    const eventRetryTimers = eventRetryTimersRef.current;

    return () => {
      mountedRef.current = false;
      requestInFlightRef.current = false;
      examActiveRef.current = false;
      examStartInFlightRef.current = false;
      requestIdRef.current += 1;
      stopSnapshotTimer(captureTimerRef, captureGenerationRef);
      for (const timer of eventRetryTimers) clearTimeout(timer);
      eventRetryTimers.clear();
      if (examTimerIntervalRef.current !== null) {
        clearInterval(examTimerIntervalRef.current);
        examTimerIntervalRef.current = null;
      }
      const stream = streamRef.current;
      streamRef.current = null;
      imageCaptureRef.current = null;
      stopMediaStream(stream);

      // Release the video element's reference as well as the hardware tracks.
      if (video) video.srcObject = null;
    };
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onExamStateChange) return undefined;

    let subscribed = true;
    const handleExamStateChange = (state) => {
      if (subscribed) applyExamTimerState(state);
    };
    const unsubscribe = window.electronAPI.onExamStateChange(handleExamStateChange);
    window.electronAPI
      .getExamTimer?.()
      .then((state) => handleExamStateChange(state))
      .catch(() => setTimerError("The saved exam timer could not be loaded."));

    return () => {
      subscribed = false;
      unsubscribe?.();
    };
  }, [applyExamTimerState]);

  useEffect(() => {
    if (!sessionId) return undefined;

    let current = true;
    getExamSession(sessionId)
      .then((session) => {
        if (!current) return;
        setBackendStatus("connected");
        setAnswers(
          Object.fromEntries(
            session.answers.map((answer) => [answer.questionId, answer.selectedAnswer]),
          ),
        );
        if (session.status === "submitted") {
          setExamResult({
            attempted: session.attempted,
            correct: session.correct,
            wrong: session.wrong,
          });
          setFinalizationStatus("succeeded");
          if (examTimerState.status === "active") void finishExam("manual");
        }
      })
      .catch((error) => {
        if (!current) return;
        setBackendStatus("error");
        setBackendError(error.message);
      });

    return () => {
      current = false;
    };
  }, [examTimerState.status, finishExam, sessionId]);

  useEffect(() => {
    if (
      !sessionId ||
      backendStatus !== "connected" ||
      examTimerState.status !== "active"
    ) {
      return undefined;
    }

    let current = true;
    const loadQuestions = setTimeout(() => {
      setQuestionsLoading(true);
      setQuestionError("");
      Promise.all([getExamQuestionTotal(), getExamQuestions()])
        .then(([totalResponse, questionResponse]) => {
          if (!current) return;
          if (!Array.isArray(questionResponse) || questionResponse.length === 0) {
            throw new Error("The backend returned no exam questions");
          }
          setQuestionCount(totalResponse?.total ?? questionResponse.length);
          setQuestions(questionResponse);
          setQuestionIndex((index) => Math.min(index, questionResponse.length - 1));
        })
        .catch((error) => {
          if (current) setQuestionError(error.message);
        })
        .finally(() => {
          if (current) setQuestionsLoading(false);
        });
    }, 0);

    return () => {
      current = false;
      clearTimeout(loadQuestions);
    };
  }, [backendStatus, examTimerState.status, sessionId]);

  useEffect(() => {
    if (examTimerState.status !== "submitted" || !sessionId) return;
    const retry = setTimeout(() => void submitBackendSession(), 0);
    return () => clearTimeout(retry);
  }, [examTimerState.status, sessionId, submitBackendSession]);

  useEffect(() => {
    if (examTimerState.status !== "submitted" || finalizationStatus !== "succeeded") return;
    if (examTimerState.completionReason === "time-expired") {
      recordSubmissionEvent("timer-expired", { source: "main-process" });
    }
    recordSubmissionEvent("exam-submission", { source: "renderer" });
  }, [examTimerState.completionReason, examTimerState.status, finalizationStatus, recordSubmissionEvent]);

  useEffect(() => {
    if (examTimerIntervalRef.current !== null) {
      clearInterval(examTimerIntervalRef.current);
      examTimerIntervalRef.current = null;
    }
    if (examTimerState.status !== "active" || !examTimerState.deadlineAt) {
      return undefined;
    }

    const updateRemainingTime = () => {
      const nextRemainingMs = Math.max(0, examTimerState.deadlineAt - Date.now());
      setRemainingMs((current) =>
        current === nextRemainingMs ? current : nextRemainingMs,
      );
    };

    // The persisted deadline, not interval count, decides when the exam expires.
    updateRemainingTime();
    examTimerIntervalRef.current = setInterval(updateRemainingTime, 1000);

    return () => {
      if (examTimerIntervalRef.current !== null) {
        clearInterval(examTimerIntervalRef.current);
        examTimerIntervalRef.current = null;
      }
    };
  }, [examTimerState.status, examTimerState.deadlineAt]);

  async function requestCamera() {
    if (requestInFlightRef.current || streamRef.current) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus(CAMERA_STATUS.UNAVAILABLE);
      setStatusMessage("This environment does not support camera access.");
      return;
    }

    requestInFlightRef.current = true;
    const requestId = ++requestIdRef.current;
    setCameraStatus(CAMERA_STATUS.REQUESTING);
    setStatusMessage("Requesting camera permission…");

    try {
      // getUserMedia is the authoritative availability check; Permissions.query
      // can be unsupported or stale and is intentionally not used as a gate.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });

      if (!mountedRef.current || requestId !== requestIdRef.current) {
        stopMediaStream(stream);
        return;
      }

      const video = videoRef.current;
      if (!video || stream.getVideoTracks().length === 0) {
        stopMediaStream(stream);
        setCameraStatus(CAMERA_STATUS.UNAVAILABLE);
        setStatusMessage("No usable camera stream was returned.");
        return;
      }

      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      try {
        imageCaptureRef.current =
          typeof ImageCapture === "function" ? new ImageCapture(track) : null;
      } catch {
        imageCaptureRef.current = null;
      }
      video.srcObject = stream;
      await video.play();

      stream.getVideoTracks()[0].addEventListener("ended", () => {
        if (!mountedRef.current || streamRef.current !== stream) return;
        stopSnapshotTimer(captureTimerRef, captureGenerationRef);
        recordExamEventWithRetry("camera-stream-interrupted", { reason: "track-ended" });
        void finishExam("cancelled");
        examActiveRef.current = false;
        setExamActive(false);
        streamRef.current = null;
        imageCaptureRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        setCameraStatus(CAMERA_STATUS.UNAVAILABLE);
        setStatusMessage("The camera stopped unexpectedly. Please try again.");
      });

      setCameraStatus(CAMERA_STATUS.READY);
      setStatusMessage("Camera is ready for the proctored exam.");
      recordExamEventWithRetry("camera-access-granted", { source: "user-action" });
    } catch (error) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      const stream = streamRef.current;
      streamRef.current = null;
      stopMediaStream(stream);
      if (videoRef.current) videoRef.current.srcObject = null;
      setCameraStatus(CAMERA_STATUS.UNAVAILABLE);
      setStatusMessage(getCameraErrorMessage(error));
      const eventType = ["NotAllowedError", "PermissionDeniedError"].includes(error?.name)
        ? "camera-access-denied"
        : "camera-stream-interrupted";
      recordExamEventWithRetry(eventType, { reason: error?.name || "unknown" });
    } finally {
      if (requestId === requestIdRef.current) requestInFlightRef.current = false;
    }
  }

  function disableCamera() {
    requestInFlightRef.current = false;
    requestIdRef.current += 1;
    stopSnapshotTimer(captureTimerRef, captureGenerationRef);
    if (examActiveRef.current) void finishExam("cancelled");
    examActiveRef.current = false;
    setExamActive(false);
    const stream = streamRef.current;
    streamRef.current = null;
    imageCaptureRef.current = null;
    stopMediaStream(stream);
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraStatus(CAMERA_STATUS.NOT_CONFIGURED);
    setStatusMessage("Camera access has been disabled.");
  }

  const cameraReady = cameraStatus === CAMERA_STATUS.READY;
  const cameraRequesting = cameraStatus === CAMERA_STATUS.REQUESTING;

  async function enterFullscreen() {
    if (!window.electronAPI?.setFullscreen) {
      setFullscreenError("Fullscreen controls are unavailable in this environment.");
      return;
    }

    setFullscreenRequesting(true);
    setFullscreenError("");
    try {
      const isFullscreen = await window.electronAPI.setFullscreen(true);
      setFullscreen(Boolean(isFullscreen));
    } catch {
      setFullscreenError("Fullscreen could not be enabled. Please try again.");
    } finally {
      setFullscreenRequesting(false);
    }
  }

  useEffect(() => {
    if (
      !examActive ||
      examTimerState.status !== "active" ||
      backendStatus !== "connected" ||
      !rulesAccepted ||
      !cameraReady ||
      !streamRef.current
    ) {
      return undefined;
    }

    let stopped = false;
    const generation = ++captureGenerationRef.current;

    async function captureAndSave() {
      if (stopped || captureInFlightRef.current) return;
      captureInFlightRef.current = true;

      try {
        const imageBytes = await captureImageBytes(
          videoRef,
          imageCaptureRef,
          canvasRef,
        );
        if (stopped || generation !== captureGenerationRef.current) return;
        if (!window.electronAPI?.saveSnapshot) {
          throw new Error("Snapshot storage is unavailable");
        }

        await window.electronAPI.saveSnapshot(imageBytes);
        if (!stopped && generation === captureGenerationRef.current) {
          setCaptureStatus("Latest snapshot saved locally.");
        }
      } catch {
        if (!stopped && generation === captureGenerationRef.current) {
          setCaptureStatus("Snapshot capture failed; the exam can continue.");
          if (Date.now() - lastCaptureFailureAtRef.current >= 30000) {
            lastCaptureFailureAtRef.current = Date.now();
            recordExamEventWithRetry("capture-failure", { reason: "capture-or-save-failed" });
          }
        }
      } finally {
        captureInFlightRef.current = false;
      }
    }

    // Capture once immediately, then continue at the documented five-second interval.
    captureAndSave();
    const timer = setInterval(captureAndSave, SNAPSHOT_INTERVAL_MS);
    captureTimerRef.current = timer;

    return () => {
      stopped = true;
      clearInterval(timer);
      if (captureTimerRef.current === timer) captureTimerRef.current = null;
      captureGenerationRef.current += 1;
    };
  }, [
    backendStatus,
    cameraReady,
    examActive,
    examTimerState.status,
    recordExamEventWithRetry,
    rulesAccepted,
  ]);

  async function startExam() {
    if (examStartInFlightRef.current || examTimerState.status === "active") return;
    if (!cameraReady || !rulesAccepted || !fullscreen) {
      setFullscreenError("Enter fullscreen before starting the exam.");
      return;
    }
    if (!studentId.trim() || !studentName.trim()) {
      setBackendError("Enter your student ID and name before starting the exam.");
      return;
    }

    examStartInFlightRef.current = true;
    setTimerError("");
    setBackendError("");
    setBackendStatus("connecting");
    try {
      const session = await startExamSession({
        userId: studentId.trim(),
        name: studentName.trim(),
      });
      if (!session?.sessionId) throw new Error("The backend returned no session ID");
      setSessionId(session.sessionId);
      storeSessionId(session.sessionId);
      setBackendStatus("connected");
      const nextState = await window.electronAPI.startExamTimer();
      applyExamTimerState(nextState);
      setCaptureStatus("Exam active; snapshots save locally every five seconds.");
    } catch {
      setBackendStatus("error");
      setBackendError("The exam session could not be created. Check the backend and try again.");
      setTimerError("The exam could not be started. Please try again.");
    } finally {
      examStartInFlightRef.current = false;
    }
  }

  function selectAnswer(questionId, selectedAnswer) {
    if (
      examTimerState.status !== "active" ||
      !sessionId ||
      answerInFlightRef.current.has(questionId)
    ) {
      return;
    }

    const previousAnswer = answers[questionId];
    answerInFlightRef.current.add(questionId);
    setAnswerSavingId(questionId);
    setAnswers((current) => ({ ...current, [questionId]: selectedAnswer }));

    saveExamAnswer({ sessionId, questionId, selectedAnswer })
      .then(() => setQuestionError(""))
      .catch((error) => {
        setAnswers((current) => {
          const restored = { ...current };
          if (previousAnswer === undefined) delete restored[questionId];
          else restored[questionId] = previousAnswer;
          return restored;
        });
        setQuestionError(`Answer could not be saved: ${error.message}`);
      })
      .finally(() => {
        answerInFlightRef.current.delete(questionId);
        setAnswerSavingId((current) =>
          current === questionId ? null : current,
        );
      });
  }

  function goToQuestion(index) {
    if (questions.length === 0) return;
    setQuestionIndex(Math.max(0, Math.min(index, questions.length - 1)));
  }

  async function completeSubmission() {
    if (submissionInFlightRef.current || !sessionId) return;
    submissionInFlightRef.current = true;
    setSubmissionInFlight(true);
    setFinalizationStatus("pending");
    setSubmissionConfirmation(false);
    setSubmissionWarning(0);
    setQuestionError("");
    try {
      const result = await finalizeBackendSession();
      setExamResult(result);
      const nextState = await finishExam("manual");
      if (!nextState) throw new Error("Local exam finalization failed");
      setFinalizationStatus("succeeded");
      setCaptureStatus("Exam submitted; snapshots stopped.");
      recordSubmissionEvent("exam-submission", { source: "renderer" });
    } catch (error) {
      setFinalizationStatus("failed");
      setQuestionError(`Exam submission failed: ${error.message}`);
    } finally {
      submissionInFlightRef.current = false;
      setSubmissionInFlight(false);
    }
  }

  function requestSubmission() {
    if (answerInFlightRef.current.size > 0) {
      setQuestionError("Wait for the selected answer to finish saving before submitting.");
      return;
    }
    const unansweredCount = questions.filter(
      (question) => answers[question.id] === undefined,
    ).length;
    if (unansweredCount > 0) {
      setSubmissionConfirmation(false);
      setSubmissionWarning(unansweredCount);
      const firstUnanswered = questions.findIndex(
        (question) => answers[question.id] === undefined,
      );
      if (firstUnanswered >= 0) setQuestionIndex(firstUnanswered);
      return;
    }
    setSubmissionConfirmation(true);
  }

  function endExam() {
    requestSubmission();
  }

  const currentQuestion = questions[questionIndex];
  const answeredCount = questions.filter(
    (question) => answers[question.id] !== undefined,
  ).length;

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-12 text-slate-100">
      <section className="mx-auto max-w-3xl space-y-8">
        <header className="space-y-3">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-400">
            Athena Exam
          </p>
          <h1 className="text-4xl font-bold tracking-tight">
            Prepare your camera
          </h1>
          <p className="max-w-2xl text-slate-300">
            Camera access is required before a proctored exam so the exam
            environment can verify that your camera is available. After you
            accept the rules and start the exam, snapshots are captured locally
            every five seconds and are never uploaded by this app.
          </p>
        </header>

        <div className="grid gap-6 rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl md:grid-cols-[1fr_1.2fr]">
          <div className="space-y-5">
            <div>
              <h2 className="text-xl font-semibold">Camera permission</h2>
              <p className="mt-2 text-sm text-slate-400">
                Choose Allow when your system asks for camera access.
              </p>
            </div>

            <div
              aria-live="polite"
              className="rounded-lg border border-slate-700 bg-slate-950/60 p-4"
            >
              <p className="text-sm font-medium">
                Status: {cameraStatus.replace("-", " ")}
              </p>
              <p className="mt-1 text-sm text-slate-400">{statusMessage}</p>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={requestCamera}
                disabled={cameraRequesting || cameraReady}
                className="rounded-lg bg-cyan-400 px-4 py-2 font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {cameraRequesting ? "Requesting…" : "Allow camera access"}
              </button>
              {cameraReady && (
                <button
                  type="button"
                  onClick={disableCamera}
                  className="rounded-lg border border-slate-600 px-4 py-2 font-semibold text-slate-200 transition hover:bg-slate-800"
                >
                  Disable camera
                </button>
              )}
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-700 bg-black">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              aria-label="Live camera preview"
              className={`aspect-video h-full min-h-64 w-full object-cover ${
                cameraReady ? "" : "hidden"
              }`}
            />
            {!cameraReady && (
              <div className="flex aspect-video min-h-64 items-center justify-center p-6 text-center text-sm text-slate-500">
                Your live preview will appear here after permission is granted.
              </div>
            )}
          </div>
        </div>

        <section className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl">
          <div>
            <h2 className="text-xl font-semibold">Exam fullscreen</h2>
            <p className="mt-2 text-sm text-slate-400">
              Enter the normal application fullscreen before starting. Athena
              does not use kiosk mode and cannot prevent every operating-system
              shortcut or access to another application.
            </p>
          </div>

          <div
            aria-live="polite"
            className={`rounded-lg border p-4 ${
              fullscreenRecoveryRequired
                ? "border-rose-400/60 bg-rose-950/30"
                : "border-slate-700 bg-slate-950/60"
            }`}
          >
            <p className="text-sm font-medium">
              Status: {fullscreen ? "fullscreen ready" : "not fullscreen"}
            </p>
            <p className="mt-1 text-sm text-slate-400">
              {fullscreenRecoveryRequired
                ? "Fullscreen was exited during the active exam. This is a detected event, not proof of cheating. Re-enter fullscreen to continue."
                : fullscreenError ||
                  "Fullscreen is required before the exam can start."}
            </p>
          </div>

          <button
            type="button"
            onClick={enterFullscreen}
            disabled={fullscreenRequesting || (fullscreen && !fullscreenRecoveryRequired)}
            className="rounded-lg bg-indigo-400 px-4 py-2 font-semibold text-slate-950 transition hover:bg-indigo-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {fullscreenRequesting
              ? "Entering fullscreen…"
              : fullscreenRecoveryRequired
                ? "Re-enter fullscreen"
                : "Enter fullscreen"}
          </button>
        </section>

        <section className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl">
          <div>
            <h2 className="text-xl font-semibold">Proctoring rules</h2>
            <p className="mt-2 text-sm text-slate-400">
              During the active exam, one camera snapshot is saved locally
              every five seconds. The exam runs for 60 minutes by default;
              its deadline is saved locally so a refresh cannot reset it.
            </p>
          </div>

          {(examTimerState.status === "active" ||
            examTimerState.status === "submitted") && (
            <div
              aria-live="polite"
              className="rounded-lg border border-slate-700 bg-slate-950/60 p-4"
            >
              <p className="text-sm font-medium">
                {examTimerState.status === "active"
                  ? "Time remaining"
                  : "Exam complete"}
              </p>
              <p className="mt-1 font-mono text-2xl text-cyan-300">
                {examTimerState.status === "active"
                  ? formatTimeLeft(remainingMs)
                  : examTimerState.completionReason === "time-expired"
                    ? "00:00"
                    : "Submitted"}
              </p>
              {examTimerState.status === "submitted" && (
                <p className="mt-1 text-sm text-slate-400">
                  This exam cannot be restarted from this window.
                </p>
              )}
            </div>
          )}

          {examTimerState.status === "submitted" && finalizationStatus === "pending" && (
            <p aria-live="polite" className="rounded-lg border border-amber-400/40 bg-amber-950/20 p-4 text-sm text-amber-100">
              Exam time has ended. Saving the final result…
            </p>
          )}

          {examTimerState.status === "submitted" && finalizationStatus === "failed" && (
            <div role="alert" className="space-y-3 rounded-lg border border-rose-400/50 bg-rose-950/30 p-4 text-sm text-rose-100">
              <p>The backend could not confirm the final result. No successful results are shown.</p>
              <button
                type="button"
                onClick={() => void submitBackendSession()}
                disabled={submissionInFlight}
                className="rounded-lg border border-rose-300 px-4 py-2 font-semibold text-rose-100 disabled:opacity-50"
              >
                Retry finalization
              </button>
            </div>
          )}

          {examResult &&
            examTimerState.status === "submitted" &&
            finalizationStatus === "succeeded" && (
              <section
                aria-labelledby="results-title"
                className="space-y-4 rounded-xl border border-emerald-400/40 bg-emerald-950/20 p-5"
              >
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-emerald-300">
                    Results
                  </p>
                  <h3 id="results-title" className="mt-1 text-2xl font-semibold text-emerald-50">
                    Exam submitted successfully
                  </h3>
                  <p className="mt-1 text-sm text-emerald-100/80">
                    Your final score was calculated and stored by the backend.
                    Correct answers are not revealed in this view.
                  </p>
                </div>
                <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                  <div className="rounded-lg bg-slate-950/40 p-3">
                    <dt className="text-slate-400">Attempted</dt>
                    <dd className="mt-1 text-xl font-semibold text-slate-100">{examResult.attempted}</dd>
                  </div>
                  <div className="rounded-lg bg-slate-950/40 p-3">
                    <dt className="text-slate-400">Correct</dt>
                    <dd className="mt-1 text-xl font-semibold text-emerald-300">{examResult.correct}</dd>
                  </div>
                  <div className="rounded-lg bg-slate-950/40 p-3">
                    <dt className="text-slate-400">Wrong</dt>
                    <dd className="mt-1 text-xl font-semibold text-rose-300">{examResult.wrong}</dd>
                  </div>
                  <div className="rounded-lg bg-slate-950/40 p-3">
                    <dt className="text-slate-400">Unanswered</dt>
                    <dd className="mt-1 text-xl font-semibold text-amber-300">
                      {Math.max(0, questions.length - examResult.attempted)}
                    </dd>
                  </div>
                </dl>
              </section>
            )}

          {timerError && (
            <p aria-live="assertive" className="text-sm text-rose-300">
              {timerError}
            </p>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-2 text-sm text-slate-300">
              <span>Student ID</span>
              <input
                value={studentId}
                onChange={(event) => setStudentId(event.target.value)}
                disabled={examActive}
                autoComplete="username"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-cyan-400 disabled:opacity-60"
                placeholder="e.g. student-101"
              />
            </label>
            <label className="space-y-2 text-sm text-slate-300">
              <span>Name</span>
              <input
                value={studentName}
                onChange={(event) => setStudentName(event.target.value)}
                disabled={examActive}
                autoComplete="name"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-cyan-400 disabled:opacity-60"
                placeholder="Your full name"
              />
            </label>
          </div>

          <div aria-live="polite" className="rounded-lg border border-slate-700 bg-slate-950/60 p-4 text-sm">
            <p className="font-medium">Backend: {backendStatus.replace("-", " ")}</p>
            <p className="mt-1 text-slate-400">
              {sessionId ? `Session: ${sessionId}` : "A session will be created when the exam starts."}
            </p>
            {backendError && <p className="mt-1 text-rose-300">{backendError}</p>}
          </div>

          <label className="flex items-start gap-3 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={rulesAccepted}
              onChange={(event) => setRulesAccepted(event.target.checked)}
              disabled={examActive}
              className="mt-1 h-4 w-4 accent-cyan-400"
            />
            <span>
              I understand and accept local proctoring snapshots at the
              five-second interval while my exam is active.
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            {examTimerState.status === "idle" ? (
              <button
                type="button"
                onClick={startExam}
                disabled={!cameraReady || !rulesAccepted || !fullscreen}
                className="rounded-lg bg-cyan-400 px-4 py-2 font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Start proctored exam
              </button>
            ) : examTimerState.status === "active" ? (
              <button
                type="button"
                onClick={endExam}
                className="rounded-lg border border-rose-400 px-4 py-2 font-semibold text-rose-300 transition hover:bg-rose-950/40"
              >
                End exam
              </button>
            ) : (
              <p className="text-sm font-medium text-slate-300">
                This exam has already been submitted.
              </p>
            )}
            <p aria-live="polite" className="text-sm text-slate-400">
              {examActive ? captureStatus : "Snapshots are currently off."}
            </p>
          </div>

          {violations.length > 0 && (
            <div className="space-y-3 rounded-lg border border-amber-400/40 bg-amber-950/20 p-4">
              <div>
                <h3 className="font-semibold text-amber-200">
                  Detected proctoring events
                </h3>
                <p className="mt-1 text-sm text-amber-100/70">
                  These are observations for review, not automatic cheating
                  findings.
                </p>
              </div>
              <ul className="space-y-1 text-sm text-slate-300">
                {violations.slice(-5).map((event) => (
                  <li key={event.id}>
                    {event.type === "fullscreen-exit"
                      ? "Fullscreen exited"
                      : "Window focus lost"}{" "}
                    <time dateTime={event.detectedAt}>
                      {new Date(event.detectedAt).toLocaleTimeString()}
                    </time>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {examTimerState.status === "active" && (
          <section
            aria-labelledby="exam-question-title"
            className="space-y-6 rounded-2xl border border-cyan-400/30 bg-slate-900 p-6 shadow-xl"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-cyan-400">
                  Examination
                </p>
                <h2 id="exam-question-title" className="mt-1 text-2xl font-semibold">
                  {questionCount || questions.length} questions
                </h2>
                <p className="mt-1 text-sm text-slate-400">
                  {answeredCount} answered · answers save immediately and can be changed
                  before submission.
                </p>
              </div>
              <div className="rounded-lg border border-cyan-400/40 px-4 py-2 text-right">
                <p className="text-xs uppercase tracking-wide text-slate-400">Time left</p>
                <p className="font-mono text-2xl text-cyan-300">
                  {formatTimeLeft(remainingMs)}
                </p>
              </div>
            </div>

            {questionsLoading && (
              <p aria-live="polite" className="text-sm text-slate-300">
                Loading exam questions…
              </p>
            )}
            {questionError && (
              <div role="alert" className="rounded-lg border border-rose-400/50 bg-rose-950/30 p-4 text-sm text-rose-200">
                {questionError}
              </div>
            )}
            {!questionsLoading && !questionError && questions.length === 0 && (
              <p className="rounded-lg border border-amber-400/50 bg-amber-950/20 p-4 text-sm text-amber-100">
                No questions are available for this session. Submission is disabled until
                the backend provides an exam.
              </p>
            )}

            {currentQuestion && (
              <>
                <div className="space-y-5 rounded-xl border border-slate-700 bg-slate-950/50 p-5">
                  <div className="flex items-center justify-between gap-3 text-sm text-slate-400">
                    <span>
                      Question {questionIndex + 1} of {questions.length}
                    </span>
                    <span>
                      {answers[currentQuestion.id] === undefined ? "Unanswered" : "Answered"}
                    </span>
                  </div>
                  <h3 className="text-xl font-medium leading-relaxed text-slate-100">
                    {currentQuestion.question}
                  </h3>
                  <fieldset className="space-y-3">
                    <legend className="sr-only">Answer options</legend>
                    {currentQuestion.options.map((option, optionIndex) => {
                      const selected = answers[currentQuestion.id] === optionIndex;
                      return (
                        <label
                          key={`${currentQuestion.id}-${optionIndex}`}
                          className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition ${
                            selected
                              ? "border-cyan-400 bg-cyan-400/10"
                              : "border-slate-700 hover:border-slate-500"
                          }`}
                        >
                          <input
                            type="radio"
                            name={`question-${currentQuestion.id}`}
                            checked={selected}
                            onChange={() => selectAnswer(currentQuestion.id, optionIndex)}
                            disabled={answerSavingId === currentQuestion.id}
                            className="mt-1 accent-cyan-400"
                          />
                          <span className="text-slate-200">{option}</span>
                        </label>
                      );
                    })}
                  </fieldset>
                  <p aria-live="polite" className="min-h-5 text-sm text-slate-400">
                    {answerSavingId === currentQuestion.id ? "Saving answer…" : ""}
                  </p>
                </div>

                <nav aria-label="Question palette" className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {questions.map((question, index) => {
                      const answered = answers[question.id] !== undefined;
                      const current = index === questionIndex;
                      return (
                        <button
                          key={question.id}
                          type="button"
                          aria-label={`Question ${index + 1}${answered ? ", answered" : ", unanswered"}`}
                          aria-current={current ? "step" : undefined}
                          onClick={() => goToQuestion(index)}
                          className={`h-10 w-10 rounded-lg border text-sm font-semibold transition ${
                            current
                              ? "border-cyan-300 bg-cyan-400 text-slate-950"
                              : answered
                                ? "border-emerald-400/70 bg-emerald-400/10 text-emerald-200"
                                : "border-slate-600 text-slate-400 hover:border-slate-400"
                          }`}
                        >
                          {index + 1}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-slate-500">
                    Palette: cyan is current, green is answered, and gray is unanswered.
                  </p>
                </nav>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => goToQuestion(questionIndex - 1)}
                    disabled={questionIndex === 0}
                    className="rounded-lg border border-slate-600 px-4 py-2 font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => goToQuestion(questionIndex + 1)}
                    disabled={questionIndex === questions.length - 1}
                    className="rounded-lg border border-slate-600 px-4 py-2 font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>

                <button
                  type="button"
                  onClick={requestSubmission}
                  disabled={submissionInFlight || answerSavingId !== null}
                  className="w-full rounded-lg bg-rose-400 px-4 py-3 font-semibold text-slate-950 transition hover:bg-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Submit exam
                </button>
              </>
            )}

            {submissionWarning > 0 && (
              <div role="alert" className="space-y-3 rounded-lg border border-amber-400/50 bg-amber-950/30 p-4">
                <p className="text-sm text-amber-100">
                  {submissionWarning} question{submissionWarning === 1 ? " remains" : "s remain"} unanswered.
                  You can review them or submit anyway.
                </p>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => setSubmissionWarning(0)}
                    className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200"
                  >
                    Review questions
                  </button>
                  <button
                    type="button"
                    onClick={() => setSubmissionConfirmation(true)}
                    className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-slate-950"
                  >
                    Submit anyway
                  </button>
                </div>
              </div>
            )}

            {submissionConfirmation && (
              <div role="alertdialog" aria-labelledby="submit-confirmation-title" className="space-y-3 rounded-lg border border-rose-400/50 bg-rose-950/30 p-4">
                <h3 id="submit-confirmation-title" className="font-semibold text-rose-100">
                  Submit your final exam now?
                </h3>
                <p className="text-sm text-rose-100/80">
                  After confirmation, the timer and camera snapshots will stop. You cannot return to the active exam.
                </p>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => setSubmissionConfirmation(false)}
                    className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200"
                  >
                    Continue exam
                  </button>
                  <button
                    type="button"
                    onClick={() => void completeSubmission()}
                    disabled={submissionInFlight || answerSavingId !== null}
                    className="rounded-lg bg-rose-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
                  >
                    Confirm final submission
                  </button>
                </div>
              </div>
            )}

          </section>
        )}
      </section>
    </main>
  );
}

export default App;
