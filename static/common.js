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
