// ElevenLabs Agents integration, used by the host screen only.
// The SDK is loaded lazily so the game stays playable (with manual buttons) without it.

const SDK_URL = "https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.26.0/dist/lib.iife.js";
const DUCK_SAFETY_MS = 2500;

let sdkPromise = null;

function loadSdk() {
  if (window.ElevenLabsClient) return Promise.resolve(window.ElevenLabsClient);
  sdkPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.onload = () => resolve(window.ElevenLabsClient);
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error("Impossible de charger le SDK ElevenLabs"));
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

export class QuizAgent {
  /**
   * @param {object} options
   * @param {() => Promise<object>} options.getCredentials  resolves to { mode, conversationToken | agentId }
   * @param {Record<string, (params: any) => Promise<any>>} options.tools  client tools, by name
   * @param {(status: string) => void} options.onStatus
   * @param {(mode: string, previous: string) => void} options.onMode
   * @param {(kind: string, text: string, data?: any) => void} options.onLog
   */
  constructor({ getCredentials, tools, onStatus, onMode, onLog }) {
    this.getCredentials = getCredentials;
    this.tools = tools;
    this.onStatus = onStatus;
    this.onMode = onMode;
    this.onLog = onLog;
    this.conversation = null;
    this.status = "disconnected";
    this.mode = "listening";
    this.micMuted = null;
    this.paused = false;
    this.ducked = null;
  }

  get connected() {
    return this.status === "connected" && this.conversation !== null;
  }

  async start() {
    if (this.conversation) return;
    this.setStatus("connecting");
    try {
      const { Conversation } = await loadSdk();
      const credentials = await this.getCredentials();
      const options = {
        connectionType: "webrtc",
        clientTools: this.wrapTools(),
        onConnect: ({ conversationId }) => this.onLog("agent", `connected (${conversationId})`),
        onDisconnect: (details) => {
          this.onLog("agent", `disconnected: ${details?.reason ?? "?"}`, details);
          this.conversation = null;
          this.micMuted = null;
          this.setStatus("disconnected");
        },
        onStatusChange: ({ status }) => this.setStatus(status),
        onModeChange: ({ mode }) => this.setMode(mode),
        onMessage: ({ role, message }) => this.onLog("agent", `${role === "agent" ? "🗣️" : "👂"} ${message}`),
        onError: (message, context) => this.onLog("error", `agent error: ${message}`, context),
      };
      if (credentials.mode === "token") options.conversationToken = credentials.conversationToken;
      else options.agentId = credentials.agentId;
      this.conversation = await Conversation.startSession(options);
      this.micMuted = null; // unknown until the first setMicMuted call
      this.setStatus("connected");
    } catch (err) {
      this.conversation = null;
      this.setStatus("disconnected");
      throw err;
    }
  }

  async stop() {
    const conversation = this.conversation;
    this.conversation = null;
    await conversation?.endSession();
    this.setStatus("disconnected");
  }

  setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    this.onStatus(status);
  }

  setMode(mode) {
    const previous = this.mode;
    this.mode = mode;
    if (mode === "speaking" && this.ducked) this.unduck();
    this.onMode(mode, previous);
  }

  wrapTools() {
    const wrapped = {};
    for (const [name, fn] of Object.entries(this.tools)) {
      wrapped[name] = async (params) => {
        this.onLog("tool", `→ ${name}(${JSON.stringify(params ?? {})})`);
        try {
          const result = await fn(params ?? {});
          this.onLog("tool", `← ${name}`, result);
          // The SDK stringifies objects itself, but its type says string | number | void.
          return JSON.stringify(result);
        } catch (err) {
          this.onLog("error", `← ${name} failed: ${err.message}`);
          throw err; // reported to the agent as a tool error
        }
      };
    }
    return wrapped;
  }

  setMicMuted(muted) {
    if (!this.connected || this.micMuted === muted) return;
    this.conversation.setMicMuted(muted);
    this.micMuted = muted;
    this.onLog("agent", muted ? "mic muted" : "mic open");
  }

  /** Triggers an immediate agent turn. */
  say(text) {
    if (!this.connected) return;
    this.conversation.sendUserMessage(text);
    this.onLog("agent", `sendUserMessage: ${text}`);
  }

  /** Adds silent context; the agent uses it on its next turn. */
  context(text) {
    if (!this.connected) return;
    this.conversation.sendContextualUpdate(text);
    this.onLog("agent", `sendContextualUpdate: ${text}`);
  }

  /**
   * Silences the agent mid-sentence (e.g. when someone buzzes during the question),
   * until its next turn starts speaking, with a safety timeout.
   */
  duck() {
    if (!this.connected || this.mode !== "speaking" || this.paused) return;
    this.conversation.setVolume({ volume: 0 });
    clearTimeout(this.ducked);
    this.ducked = setTimeout(() => this.unduck(), DUCK_SAFETY_MS);
    this.onLog("agent", "ducked (agent was speaking during buzz)");
  }

  unduck() {
    clearTimeout(this.ducked);
    this.ducked = null;
    if (this.connected && !this.paused) this.conversation.setVolume({ volume: 1 });
  }

  setPaused(paused) {
    this.paused = paused;
    if (!this.connected) return;
    this.conversation.setVolume({ volume: paused ? 0 : 1 });
  }
}
