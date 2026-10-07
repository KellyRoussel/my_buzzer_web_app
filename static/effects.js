// Game-show sound effects (synthesized, no assets) and end-of-game confetti.

let audio = null;

/** Browsers only allow audio after a user gesture: call this from a click handler. */
export function unlockAudio() {
  if (!audio) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    audio = new Context();
  }
  if (audio.state === "suspended") audio.resume();
}

function tone(freq, start, duration, { type = "triangle", gain = 0.15, slideTo = null } = {}) {
  const osc = audio.createOscillator();
  const amp = audio.createGain();
  const t0 = audio.currentTime + start;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + duration);
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(amp).connect(audio.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

const SOUNDS = {
  join: () => tone(880, 0, 0.12, { gain: 0.08 }),
  question: () => { tone(523, 0, 0.12); tone(784, 0.1, 0.2); },
  buzz: () => tone(180, 0, 0.45, { type: "square", gain: 0.12, slideTo: 120 }),
  correct: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.22)),
  wrong: () => { tone(392, 0, 0.3, { type: "sawtooth", gain: 0.08, slideTo: 370 }); tone(330, 0.32, 0.6, { type: "sawtooth", gain: 0.08, slideTo: 280 }); },
  timeout: () => tone(220, 0, 0.7, { type: "sine", gain: 0.12, slideTo: 110 }),
  fanfare: () => [523, 523, 523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.13, i === 7 ? 0.8 : 0.16)),
};

export function sfx(name) {
  if (!audio || audio.state !== "running") return;
  SOUNDS[name]?.();
}

export function celebrate(canvas, durationMs = 6000) {
  const ctx = canvas.getContext("2d");
  const colors = ["#ff3d7f", "#3dd6ff", "#ffd23d", "#9d5cff", "#3dff8b", "#ff8a3d"];
  const resize = () => {
    canvas.width = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
  };
  resize();
  const pieces = Array.from({ length: 180 }, () => ({
    x: Math.random() * canvas.width,
    y: -Math.random() * canvas.height,
    w: (6 + Math.random() * 8) * devicePixelRatio,
    h: (10 + Math.random() * 10) * devicePixelRatio,
    vy: (2 + Math.random() * 4) * devicePixelRatio,
    vx: (Math.random() - 0.5) * 2 * devicePixelRatio,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.2,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const end = performance.now() + durationMs;
  function frame(now) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (now > end) return;
    for (const p of pieces) {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      if (p.y > canvas.height) p.y = -p.h;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
