// Practice only. These browser measurements never enter coin settlement.
export const PRESETS = {
  coastal: { rx: 260, ry: 150, maxSpeed: 175, grip: 2.7 },
  club: { rx: 230, ry: 132, maxSpeed: 155, grip: 3.1 },
  night: { rx: 275, ry: 145, maxSpeed: 195, grip: 2.6 },
};
export function createPractice(track = "coastal") {
  const preset = PRESETS[track] ?? PRESETS.coastal;
  return {
    preset,
    x: 400 + preset.rx,
    y: 300,
    heading: Math.PI / 2,
    speed: 0,
    time: 0,
    lapStart: 0,
    dirty: false,
    sector: 0,
    gates: 0,
    laps: [],
    complete: false,
  };
}
export function updatePractice(state, input, dt) {
  if (state.complete) return state;
  dt = Math.max(0, Math.min(dt, 1 / 30));
  state.time += dt;
  const { preset } = state;
  state.speed = Math.max(
    0,
    Math.min(
      preset.maxSpeed,
      state.speed +
        ((input.throttle ? 75 : 0) - (input.brake ? 160 : 0) - 18) * dt,
    ),
  );
  const steer = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  state.heading +=
    steer * preset.grip * (0.25 + (0.75 * state.speed) / preset.maxSpeed) * dt;
  state.x += Math.cos(state.heading) * state.speed * dt;
  state.y += Math.sin(state.heading) * state.speed * dt;
  const dx = (state.x - 400) / preset.rx,
    dy = (state.y - 300) / preset.ry;
  const radius = Math.hypot(dx, dy);
  if (radius < 0.78 || radius > 1.22) {
    state.dirty = true;
    state.speed *= Math.exp(-5 * dt);
  }
  state.x = Math.max(30, Math.min(770, state.x));
  state.y = Math.max(30, Math.min(570, state.y));
  let angle = Math.atan2(dy, dx);
  if (angle < 0) angle += Math.PI * 2;
  const sector = Math.floor(angle / (Math.PI / 2)) % 4;
  if (sector !== state.sector) {
    if (sector === (state.sector + 1) % 4) {
      if (sector === 0) {
        if (state.gates === 3 && state.time - state.lapStart > 6) {
          state.laps.push({
            seconds: state.time - state.lapStart,
            is_clean: !state.dirty,
          });
          state.lapStart = state.time;
          state.dirty = false;
          if (state.laps.length === 3) state.complete = true;
        } else state.dirty = true;
        state.gates = 0;
      } else if (sector === state.gates + 1) state.gates = sector;
      else state.dirty = true;
    } else state.dirty = true;
    state.sector = sector;
  }
  return state;
}
export function bestCleanLap(laps) {
  const valid = laps.filter(
    (l) => l.is_clean === true && Number.isFinite(l.seconds) && l.seconds > 0,
  );
  return valid.length ? Math.min(...valid.map((l) => l.seconds)) : null;
}
