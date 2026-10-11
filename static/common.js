// Shared helpers for the host screen and the player phone.

export function roomCodeFromPath() {
  const parts = location.pathname.split("/").filter(Boolean);
  return (parts[parts.length - 1] || "").toUpperCase();
}

export function wsUrl(path) {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}${path}`;
}

// Close codes after which reconnecting is pointless.
const FINAL_CLOSE_CODES = new Set([4000, 4401, 4404]);

/**
 * WebSocket with automatic reconnection (exponential backoff, capped at 5 s).
 * `onOpen` runs on every (re)connection, so it is the place to (re)join.
 */
export function connect(url, { onOpen, onMessage, onStatus }) {
  let ws = null;
  let attempt = 0;
  let stopped = false;

  function open() {
    ws = new WebSocket(url);
    onStatus?.("connecting");
    ws.onopen = () => {
      attempt = 0;
      onStatus?.("open");
      onOpen?.();
    };
    ws.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch (err) {
        console.error("Bad message", err, event.data);
      }
    };
    ws.onclose = (event) => {
      onStatus?.(FINAL_CLOSE_CODES.has(event.code) ? "closed" : "reconnecting");
      if (stopped || FINAL_CLOSE_CODES.has(event.code)) return;
      const delay = Math.min(500 * 2 ** attempt++, 5000);
      setTimeout(open, delay);
    };
  }

  open();
  return {
    send(message) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
        return true;
      }
      return false;
    },
    isOpen() {
      return Boolean(ws && ws.readyState === WebSocket.OPEN);
    },
    close() {
      stopped = true;
      ws?.close();
    },
  };
}

export function pick(list, seed) {
  if (seed === undefined) return list[Math.floor(Math.random() * list.length)];
  let hash = 0;
  for (const char of String(seed)) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return list[Math.abs(hash) % list.length];
}

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function storage(kind = "session") {
  // Storage can throw in private modes; the game must keep working without it.
  const backend = kind === "session" ? "sessionStorage" : "localStorage";
  return {
    get(key) {
      try { return JSON.parse(window[backend].getItem(key)); } catch { return null; }
    },
    set(key, value) {
      try { window[backend].setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
    },
  };
}

const NOTE_GLYPHS = ["♪", "♫", "♬", "♩"];
const NOTE_COLORS = ["#ff2e88", "#25e3ff", "#ffc93c", "#9d5cff"];

/** Background decoration: music notes drifting up the page. */
export function scatterNotes(count = 14) {
  const layer = document.createElement("div");
  layer.className = "notes";
  layer.setAttribute("aria-hidden", "true");
  for (let i = 0; i < count; i++) {
    const note = document.createElement("span");
    note.textContent = NOTE_GLYPHS[i % NOTE_GLYPHS.length];
    note.style.left = `${(i * 97) % 100}%`;
    note.style.setProperty("--s", `${1.2 + ((i * 7) % 5) * 0.5}rem`);
    note.style.setProperty("--c", NOTE_COLORS[i % NOTE_COLORS.length]);
    note.style.setProperty("--d", `${14 + ((i * 5) % 12)}s`);
    note.style.setProperty("--delay", `${-((i * 3.7) % 20)}s`);
    layer.append(note);
  }
  document.body.prepend(layer);
}

/** Fills an element with equalizer bars, each with its own tempo (animated by CSS). */
export function equalizer(element, bars = 24) {
  element.replaceChildren(...Array.from({ length: bars }, (_, i) => {
    const bar = document.createElement("span");
    bar.style.setProperty("--d", `${0.45 + ((i * 37) % 50) / 100}s`);
    bar.style.setProperty("--delay", `${-((i * 13) % 40) / 100}s`);
    bar.style.setProperty("--h", `${55 + ((i * 29) % 45)}%`);
    return bar;
  }));
}
