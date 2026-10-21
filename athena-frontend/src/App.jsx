import { useEffect, useRef, useState } from "react";

const CAMERA_STATUS = {
  NOT_CONFIGURED: "not-configured",
  REQUESTING: "requesting",
  READY: "ready",
  UNAVAILABLE: "unavailable",
};
const SNAPSHOT_INTERVAL_MS = 5000;

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
  const [cameraStatus, setCameraStatus] = useState(
    CAMERA_STATUS.NOT_CONFIGURED,
  );
  const [statusMessage, setStatusMessage] = useState(
    "Camera access has not been requested.",
  );
  const [rulesAccepted, setRulesAccepted] = useState(false);
  const [examActive, setExamActive] = useState(false);
  const [captureStatus, setCaptureStatus] = useState(
    "Snapshots are off until you start the exam.",
  );

  useEffect(() => {
    mountedRef.current = true;
    const video = videoRef.current;

    return () => {
      mountedRef.current = false;
      requestInFlightRef.current = false;
      requestIdRef.current += 1;
      stopSnapshotTimer(captureTimerRef, captureGenerationRef);
      const stream = streamRef.current;
      streamRef.current = null;
      imageCaptureRef.current = null;
      stopMediaStream(stream);

      // Release the video element's reference as well as the hardware tracks.
      if (video) video.srcObject = null;
    };
  }, []);

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
        setExamActive(false);
        streamRef.current = null;
        imageCaptureRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        setCameraStatus(CAMERA_STATUS.UNAVAILABLE);
        setStatusMessage("The camera stopped unexpectedly. Please try again.");
      });

      setCameraStatus(CAMERA_STATUS.READY);
      setStatusMessage("Camera is ready for the proctored exam.");
    } catch (error) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      const stream = streamRef.current;
      streamRef.current = null;
      stopMediaStream(stream);
      if (videoRef.current) videoRef.current.srcObject = null;
      setCameraStatus(CAMERA_STATUS.UNAVAILABLE);
      setStatusMessage(getCameraErrorMessage(error));
    } finally {
      if (requestId === requestIdRef.current) requestInFlightRef.current = false;
    }
  }

  function disableCamera() {
    requestInFlightRef.current = false;
    requestIdRef.current += 1;
    stopSnapshotTimer(captureTimerRef, captureGenerationRef);
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

  useEffect(() => {
    if (!examActive || !rulesAccepted || !cameraReady || !streamRef.current) {
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
  }, [cameraReady, examActive, rulesAccepted]);

  function startExam() {
    if (!cameraReady || !rulesAccepted) return;
    setCaptureStatus("Starting local snapshots every five seconds…");
    setExamActive(true);
  }

  function endExam() {
    stopSnapshotTimer(captureTimerRef, captureGenerationRef);
    setExamActive(false);
    setCaptureStatus("Snapshots stopped because the exam ended.");
  }

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
            <h2 className="text-xl font-semibold">Proctoring rules</h2>
            <p className="mt-2 text-sm text-slate-400">
              During the active exam, one camera snapshot is saved locally
              every five seconds. Snapshots stop when you end the exam or the
              camera becomes unavailable.
            </p>
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
            {!examActive ? (
              <button
                type="button"
                onClick={startExam}
                disabled={!cameraReady || !rulesAccepted}
                className="rounded-lg bg-cyan-400 px-4 py-2 font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Start proctored exam
              </button>
            ) : (
              <button
                type="button"
                onClick={endExam}
                className="rounded-lg border border-rose-400 px-4 py-2 font-semibold text-rose-300 transition hover:bg-rose-950/40"
              >
                End exam
              </button>
            )}
            <p aria-live="polite" className="text-sm text-slate-400">
              {examActive ? captureStatus : "Snapshots are currently off."}
            </p>
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;
