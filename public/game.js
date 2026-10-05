import { createPractice, updatePractice, bestCleanLap } from "./physics.js";
export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const m = Math.floor(seconds / 60),
    s = seconds % 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}
export function startPractice({ track, canvas, onUpdate, onComplete }) {
  const ctx = canvas.getContext("2d");
  canvas.width = 800;
  canvas.height = 600;
  let state = createPractice(track.id),
    frame,
    last = 0,
    accumulator = 0,
    running = false,
    disposed = false;
  const input = { throttle: false, brake: false, left: false, right: false };
  const keys = {
    ArrowUp: "throttle",
    w: "throttle",
    ArrowDown: "brake",
    s: "brake",
    ArrowLeft: "left",
    a: "left",
    ArrowRight: "right",
    d: "right",
  };
  const key = (e, pressed) => {
    const k = keys[e.key];
    if (k && !e.target.closest("input,textarea,dialog")) {
      e.preventDefault();
      input[k] = pressed;
    }
  };
  const down = (e) => key(e, true),
    up = (e) => key(e, false);
  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  const releases = [];
  for (const button of document.querySelectorAll("[data-drive]")) {
    const action = button.dataset.drive;
    const press = (e) => {
      e.preventDefault();
      button.setPointerCapture(e.pointerId);
      input[action] = true;
      button.classList.add("pressed");
    };
    const release = () => {
      input[action] = false;
      button.classList.remove("pressed");
    };
    button.addEventListener("pointerdown", press);
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
    releases.push(() => {
      button.removeEventListener("pointerdown", press);
      button.removeEventListener("pointerup", release);
      button.removeEventListener("pointercancel", release);
      button.removeEventListener("lostpointercapture", release);
    });
  }
  const clearInput = () => {
    for (const k of Object.keys(input)) input[k] = false;
    document
      .querySelectorAll(".pressed")
      .forEach((x) => x.classList.remove("pressed"));
  };
  const visibility = () => {
    if (document.hidden) pause();
  };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("blur", pause);
  function draw() {
    const p = state.preset;
    ctx.fillStyle = track.id === "night" ? "#0c1823" : "#122722";
    ctx.fillRect(0, 0, 800, 600);
    for (let x = 0; x < 800; x += 40) {
      ctx.strokeStyle = "#b1e7d008";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 600);
      ctx.stroke();
    }
    for (let y = 0; y < 600; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(800, y);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.ellipse(400, 300, p.rx * 1.27, p.ry * 1.27, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#65746b";
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(400, 300, p.rx * 1.22, p.ry * 1.22, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#263a43";
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(400, 300, p.rx * 0.78, p.ry * 0.78, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#17352c";
    ctx.fill();
    ctx.setLineDash([12, 18]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#8fa79a77";
    ctx.beginPath();
    ctx.ellipse(400, 300, p.rx, p.ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = "#c6d9b1";
    ctx.lineWidth = 3;
    for (const radius of [0.78, 1.22]) {
      ctx.beginPath();
      ctx.ellipse(400, 300, p.rx * radius, p.ry * radius, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let i = 0; i < 12; i++) {
      ctx.fillStyle = i % 2 ? "#cfd9d2" : "#26333c";
      ctx.fillRect(
        400 + p.rx * 0.78 + (i * p.rx * 0.44) / 12,
        294,
        (p.rx * 0.44) / 12,
        12,
      );
    }
    ctx.fillStyle = "#c3e2cb19";
    ctx.font = "italic 900 52px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("R / ESCROW", 400, 287);
    ctx.font = "12px system-ui";
    ctx.fillStyle = "#9fb8aa";
    ctx.fillText("FREE PRACTICE  •  " + track.title.toUpperCase(), 400, 320);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      ctx.fillStyle = "#b2c1b39c";
      ctx.font = "10px system-ui";
      ctx.fillText(
        i === 0 ? "START / FINISH" : `SECTOR ${i}`,
        400 + Math.cos(a) * p.rx * 1.4,
        300 + Math.sin(a) * p.ry * 1.4,
      );
    }
    ctx.save();
    ctx.translate(state.x, state.y);
    ctx.rotate(state.heading);
    ctx.shadowColor = "#c5ff6e55";
    ctx.shadowBlur = 15;
    ctx.fillStyle = "#071017";
    ctx.fillRect(-15, -10, 30, 20);
    ctx.fillStyle = state.dirty ? "#eea584" : "#c3f16b";
    ctx.beginPath();
    ctx.roundRect(-17, -8, 35, 16, 4);
    ctx.fill();
    ctx.fillStyle = "#15332d";
    ctx.fillRect(1, -6, 8, 12);
    ctx.fillRect(-9, -5, 6, 10);
    ctx.fillStyle = "#e3ffe0";
    ctx.fillRect(13, -7, 3, 4);
    ctx.fillRect(13, 3, 3, 4);
    ctx.fillStyle = "#daeab6";
    ctx.fillRect(-16, -10, 3, 20);
    ctx.restore();
    if (!running && !state.complete) {
      ctx.fillStyle = "#09131bcc";
      ctx.fillRect(0, 0, 800, 600);
      ctx.fillStyle = "#dbead5";
      ctx.font = "700 27px system-ui";
      ctx.fillText(
        state.time ? "SESSION PAUSED" : "YOUR LAP STARTS HERE",
        400,
        267,
      );
      ctx.font = "15px system-ui";
      ctx.fillStyle = "#a8c0b1";
      ctx.fillText(
        "Tap Drive to begin. Stay between the track edges.",
        400,
        302,
      );
    }
  }
  function tick(now) {
    if (disposed) return;
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
    last = now;
    if (running) {
      accumulator += dt;
      while (accumulator >= 1 / 120) {
        updatePractice(state, input, 1 / 120);
        accumulator -= 1 / 120;
        if (state.complete) {
          running = false;
          clearInput();
          onComplete({
            track_id: track.id,
            laps: structuredClone(state.laps),
            best: bestCleanLap(state.laps),
            completed_at: new Date().toISOString(),
          });
          break;
        }
      }
    }
    draw();
    onUpdate(state, running);
    frame = requestAnimationFrame(tick);
  }
  function play() {
    if (state.complete) return;
    running = true;
    last = 0;
    accumulator = 0;
  }
  function pause() {
    running = false;
    clearInput();
  }
  function reset() {
    pause();
    state = createPractice(track.id);
    last = 0;
    accumulator = 0;
  }
  frame = requestAnimationFrame(tick);
  return {
    play,
    pause,
    reset,
    getState: () => state,
    destroy() {
      disposed = true;
      cancelAnimationFrame(frame);
      clearInput();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", pause);
      document.removeEventListener("visibilitychange", visibility);
      releases.forEach((r) => r());
    },
  };
}
