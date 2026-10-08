// Host screen: plays the songs on the TV and bridges the game server and the voice agent.
//
// The game server owns the state. The voice agent never holds it: it reads and changes it
// through client tools, which this page relays to the server over the host WebSocket.
import { QuizAgent } from "/static/agent.js";
import { connect, equalizer, escapeHtml, roomCodeFromPath, scatterNotes, storage, wsUrl } from "/static/common.js";
import { celebrate, sfx, unlockAudio } from "/static/effects.js";

const code = roomCodeFromPath();
const session = storage("session");
const $ = (id) => document.getElementById(id);

const ACTIVE_PHASES = ["QUESTION_READING", "BUZZ_OPEN", "ANSWERING", "REVEAL"];
const START_FALLBACK_MS = 8000;
// The agent calls start_timer as soon as the LLM emits it, often while the question audio is
// still playing: the countdown really starts when the agent stops talking.
const TIMER_DEFER_MAX_MS = 15000;
// The tool call often arrives *before* the audio of the sentence generated with it (TTS takes
// a couple of seconds): if the agent is not speaking yet, wait this long for it to start.
const TIMER_SPEECH_WAIT_MS = 3000;
// In WebRTC, muting the mic stops sending audio altogether, so cutting a player mid-sentence
// leaves ElevenLabs waiting for the end of their turn. At the end of the answer window, keep
// the mic open a moment so the end of the sentence (and the silence after it) gets through.
const MIC_TAIL_MS = 1500;
// Tool calls made while the connection to the game server is down wait this long for it.
const RECONNECT_WAIT_MS = 8000;
// The agent read the question but forgot start_timer: start it after this much silence.
const TIMER_FALLBACK_MS = 1500;
// The SDK reports "listening" during short pauses inside one sentence (between expression tags,
// for instance). Only treat the agent as done once it has been quiet this long.
const AGENT_DONE_MS = 800;
// After the answer, the song plays under the agent's reaction, then stops shortly after.
const REVEAL_OUTRO_MS = 1500;
const REVEAL_MUSIC_MAX_MS = 12000;
// The agent must chain next_question after a question closes. If it is quiet this long in
// REVEAL, it gets a SUITE nudge; if the game is still stuck after that, the host moves on.
const ADVANCE_NUDGE_MS = 3000;
const ADVANCE_FIRST_NUDGE_MS = 8000; // right after the verdict: leave time for the agent's reaction
const ADVANCE_FORCE_MS = 8000;
// When the answer window closes mid-sentence, the mic is muted at once (nothing said later is
// heard) but the transcript of what was said in time arrives a moment later: wait for it
// before asking the agent to judge, unless the agent judges on its own first.
const ANSWER_TRANSCRIPT_GRACE_MS = 2500;
// Once the player's answer is transcribed, the agent should judge it on its own. If it has not
// started talking after this delay, the host screen asks it explicitly (and again later if
// there is still no verdict).
// Not too early: the agent often needs several seconds (transcription + LLM) before it speaks,
// and a nudge sent while it is still thinking makes it answer twice.
const JUDGE_NUDGE_MS = 8000;
const JUDGE_NUDGE_AGAIN_MS = 12000;

let state = null;
let agentConfigured = false;
let answerTimeUp = false;
let questionSpoken = false; // has the agent actually announced the current song out loud?
let timerRequest = null; // start_timer called while the agent was still talking
let answerHeard = []; // transcripts of the player's answer, captured while their mic was open
let timeUpTimer = null;
let micTail = false;
let agentDoneTimer = null;
let agentTalking = false; // speaking, or in a short pause inside a sentence
let revealMusicOver = false;
let revealMusicTimers = [];
let advanceTimers = [];
let previousPhase = null;
let reconnectWaiters = [];
let judgeNudges = [];
let timerFallback = null;
let deadlineAt = null;
let renderedQuestion = null;
let celebrated = false;
const pending = new Map();
let requestSeq = 0;

// ---------------------------------------------------------------- host key

function readHostKey() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("key");
  if (fromHash) {
    session.set(`quiz.hostKey.${code}`, fromHash);
    history.replaceState(null, "", location.pathname);
    return fromHash;
  }
  return session.get(`quiz.hostKey.${code}`);
}

const hostKey = readHostKey();

function fatal(html) {
  for (const id of ["lobby", "stage", "finished", "controls"]) $(id).classList.add("hidden");
  $("fatal").innerHTML = html;
  $("fatal").classList.remove("hidden");
}

// ------------------------------------------------------------- debug log

const log = (() => {
  const list = $("log");
  const showSecrets = $("show-secrets");
  const secretKeys = new Set(["answer", "artist", "title", "year", "acceptedArtists", "acceptedTitles"]);
  return (kind, text, data) => {
    const item = document.createElement("li");
    const time = new Date().toISOString().slice(11, 23);
    let detail = "";
    if (data !== undefined) {
      // The debug panel is on the TV: hide answers unless explicitly asked.
      detail = " " + JSON.stringify(data, (key, value) =>
        secretKeys.has(key) && !showSecrets.checked && !state?.answer ? "•••" : value);
    }
    item.innerHTML = `<span class="t">${time}</span><span class="k-${kind}">${escapeHtml(text)}</span>${escapeHtml(detail)}`;
    list.prepend(item);
    while (list.children.length > 300) list.lastChild.remove();
  };
})();

// ------------------------------------------------------------- server link

const socket = connect(wsUrl(`/ws/${code}/host`), {
  onOpen: () => {
    socket.send({ type: "auth", key: hostKey });
    reconnectWaiters.forEach((resolve) => resolve(true));
    reconnectWaiters = [];
  },
  onStatus: (status) => {
    log(status === "open" ? "ws" : "error", `game server connection: ${status}`);
    $("conn-pill").textContent = { open: "En ligne", connecting: "Connexion…", reconnecting: "Reconnexion…", closed: "Hors ligne" }[status];
    $("conn-pill").classList.toggle("warn", status !== "open");
  },
  onMessage: (message) => {
    switch (message.type) {
      case "welcome":
        agentConfigured = message.agentConfigured;
        renderAgent();
        break;
      case "state":
        onState(message.state);
        break;
      case "event":
        log("ws", `event ${message.event.type}`, message.event);
        onEvent(message.event);
        break;
      case "result": {
        const request = pending.get(message.id);
        if (!request) break;
        pending.delete(message.id);
        clearTimeout(request.timer);
        message.ok ? request.resolve(message.data) : request.reject(new Error(message.error));
        break;
      }
      case "error":
        if (message.code === "unauthorized") {
          fatal(`Cette salle n'existe plus ou la clé hôte manque.<br><a href="/">Créer une nouvelle partie</a>`);
        }
        break;
    }
  },
});

/** Sends a host action and resolves with its result (or rejects with the game's error message). */
async function action(name, params = {}) {
  if (!socket.isOpen()) {
    // The connection dropped (Wi-Fi, tunnel…): wait for the automatic reconnection.
    const back = await new Promise((resolve) => {
      reconnectWaiters.push(resolve);
      setTimeout(() => resolve(false), RECONNECT_WAIT_MS);
    });
    if (!back) throw new Error("Pas connecté au serveur de jeu.");
  }
  return new Promise((resolve, reject) => {
    const id = String(++requestSeq);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Le serveur de jeu ne répond pas."));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    if (!socket.send({ type: "action", id, action: name, params })) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error("Pas connecté au serveur de jeu."));
    }
  });
}

// ------------------------------------------------------------------ agent

const agent = new QuizAgent({
  getCredentials: async () => {
    const response = await fetch(`/api/rooms/${code}/eleven-token`, { headers: { "X-Host-Key": hostKey } });
    if (!response.ok) throw new Error((await response.json()).detail || response.statusText);
    return response.json();
  },
  tools: {
    get_game_state: () => action("get_game_state"),
    start_game: () => action("start_game"),
    next_question: () => action("next_question"),
    submit_verdict: ({ playerId, correct, artist, title }) =>
      action("submit_verdict", { playerId, correct, artist, title, by: "agent" }),
    start_timer: () => requestTimerFromAgent(),
    reveal_answer: () => action("reveal_answer"),
    get_scores: () => action("get_scores"),
  },
  onStatus: (status) => {
    log("agent", `status ${status}`);
    renderAgent();
    applyMic();
  },
  onMode: (mode, previous) => {
    renderAgent();
    if (mode === "speaking") agentTalking = true;
    if (state) syncClip(); // reveal music ducks under the agent's voice
    if (mode === "speaking") {
      clearTimeout(agentDoneTimer); // a pause inside a sentence, not the end of it
      clearTimerTimeouts({ keepRequest: true });
      clearAdvanceTimers();
      if (timerRequest) { // the announcement started playing: now wait for its end
        clearTimeout(timerRequest);
        timerRequest = setTimeout(() => startTimer("agent still talking after 15 s"), TIMER_DEFER_MAX_MS);
      }
      if (musicHold) { // the relaunch line started: let it finish, whatever the hold timeout
        clearTimeout(musicHold);
        musicHold = setTimeout(() => releaseMusic("agent still talking after 10 s"), 10000);
      }
    }
    if (previous === "speaking" && mode === "listening") {
      clearTimeout(agentDoneTimer);
      agentDoneTimer = setTimeout(onAgentDone, AGENT_DONE_MS);
    }
  },
  onUserText: (text) => {
    // The mic is only open during the answer window, so this is what the player said in time.
    if (state?.phase !== "ANSWERING" || answerHeard.length > 0) return;
    answerHeard.push(text);
    onAnswerHeard(state.answering, text);
  },
  onAgentText: (text) => {
    if (state?.phase === "QUESTION_READING" && !questionSpoken && announcesSong(text)) {
      questionSpoken = true;
      log("agent", "song announced out loud");
    }
  },
  onLog: log,
});

/**
 * The player's answer is in: close their mic (only the first answer counts), stop the answer
 * countdown, and make sure the agent judges it.
 */
function onAnswerHeard(playerId, text) {
  log("agent", `answer heard: ${text}`);
  applyMic();
  syncClip(); // the agent's voice comes back
  action("answer_heard").catch(() => {});
  const nudge = (force) => () => {
    if (state?.phase !== "ANSWERING" || state.answering !== playerId) return; // judged meanwhile
    if (!force && agent.mode === "speaking") return; // it is reacting: give it time
    const name = playerName(playerId);
    log("agent", "agent has not judged yet: nudging it");
    tellAgent(`JUGE: ${name} a répondu « ${text} ». Juge cette réponse maintenant avec submit_verdict `
      + `(playerId "${playerId}", avec artist et title), puis réagis en une phrase.`);
  };
  clearJudgeNudges();
  judgeNudges = [setTimeout(nudge(false), JUDGE_NUDGE_MS), setTimeout(nudge(true), JUDGE_NUDGE_AGAIN_MS)];
}

function clearJudgeNudges() {
  judgeNudges.forEach(clearTimeout);
  judgeNudges = [];
}

/** start_timer tool: start the music and the countdown once the agent has announced the song. */
function requestTimerFromAgent() {
  if (state?.phase === "BUZZ_OPEN") return { ok: true, note: "Le chrono tourne déjà. Tais-toi et attends BUZZ ou TIMEOUT." };
  if (state?.phase !== "QUESTION_READING") throw new Error("Aucune question n'attend de chrono en ce moment.");
  clearTimerTimeouts();
  if (agent.mode === "speaking") {
    timerRequest = setTimeout(() => startTimer("agent still talking after 15 s"), TIMER_DEFER_MAX_MS);
    log("agent", "start_timer: deferred until the agent stops talking");
  } else if (questionSpoken) {
    startTimer("agent"); // the song has been announced and the agent is silent: go
  } else {
    timerRequest = setTimeout(() => startTimer("agent did not speak after start_timer"), TIMER_SPEECH_WAIT_MS);
    log("agent", "start_timer: waiting for the agent's announcement to play");
  }
  return { ok: true, nextStep: "Le chrono démarre dès que tu te tais. Tais-toi et attends un message BUZZ ou TIMEOUT." };
}

function clearTimerTimeouts({ keepRequest = false } = {}) {
  clearTimeout(timerFallback);
  timerFallback = null;
  if (!keepRequest) {
    clearTimeout(timerRequest);
    timerRequest = null;
  }
}

function startTimer(reason) {
  clearTimerTimeouts();
  if (state?.phase !== "QUESTION_READING") return;
  log("agent", `timer started (${reason})`);
  action("start_timer").catch(() => {});
}

/** The agent has finished what it was saying (not just a pause between two words). */
function onAgentDone() {
  if (!state || agent.mode === "speaking") return;
  agentTalking = false;
  syncClip(); // reveal music back up
  if (musicHold) releaseMusic("agent done");
  if (state.phase === "QUESTION_READING") {
    // start_timer was called during the announcement: the audio has now finished playing.
    if (timerRequest) startTimer("agent finished speaking");
    // The agent announced the song but did not call start_timer: start it after a short silence.
    else if (questionSpoken) timerFallback = setTimeout(() => startTimer("fallback, no start_timer"), TIMER_FALLBACK_MS);
  }
  if (state.phase === "REVEAL") {
    stopRevealMusicSoon(REVEAL_OUTRO_MS);
    scheduleAdvance();
  }
}

function stopRevealMusicSoon(delay) {
  revealMusicTimers.push(setTimeout(() => { revealMusicOver = true; if (state) syncClip(); }, delay));
}

/** After a question closes, make sure the game moves on even if the agent forgets to. */
function scheduleAdvance(delay = ADVANCE_NUDGE_MS) {
  clearAdvanceTimers();
  if (!agent.connected || state?.paused) return;
  const question = state.questionNumber;
  const stillStuck = () => state?.phase === "REVEAL" && state.questionNumber === question && !state.paused;
  advanceTimers.push(setTimeout(() => {
    if (!stillStuck()) return;
    log("agent", "agent has not moved on: nudging it");
    tellAgent("SUITE: la manche est terminée. Si l'artiste et le titre n'ont pas été dits, appelle reveal_answer et "
      + "annonce-les en une phrase ; puis appelle next_question tout de suite, sans attendre les joueurs.");
    advanceTimers.push(setTimeout(async () => {
      if (!stillStuck()) return;
      log("agent", "still stuck: the host moves on");
      try {
        announceQuestion(await action("next_question"), "on passe à la suite");
      } catch (err) {
        log("error", err.message);
      }
    }, ADVANCE_FORCE_MS));
  }, delay));
}

function clearAdvanceTimers() {
  advanceTimers.forEach(clearTimeout);
  advanceTimers = [];
}

/** The room microphone is open only when someone is expected to talk to the agent. */
function desiredMicOpen() {
  if (!agent.connected || !state || state.paused) return false;
  if (state.phase === "LOBBY" || state.phase === "FINISHED") return true;
  return state.phase === "ANSWERING" && answerHeard.length === 0 && (!answerTimeUp || micTail);
}

const normalize = (text) => text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/\[[^\]]*\]/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

/** Did the agent announce the song ("Chanson numéro 3 !")? */
function announcesSong(said) {
  return normalize(said).split(" ").includes("chanson");
}

function applyMic() {
  const open = desiredMicOpen();
  agent.setMicMuted(!open);
  const name = state?.answering && playerName(state.answering);
  $("mic-text").textContent = !agent.connected ? "🎙️ —" : open ? `🎙️ À l'écoute${name ? ` de ${name}` : ""}` : "🎙️ Micro coupé";
  $("mic-pill").classList.toggle("open", open);
}

async function toggleAgent() {
  unlockAudio();
  try {
    if (agent.connected || agent.status === "connecting") await agent.stop();
    else await agent.start();
  } catch (err) {
    log("error", err.message);
    $("agent-help").textContent = `Impossible de lancer l'animateur : ${err.message}`;
  }
}

function tellAgent(text) {
  if (agent.connected) agent.say(text);
}

function playerName(id) {
  return state?.players.find((p) => p.id === id)?.name ?? "?";
}

// ----------------------------------------------------------------- events

function onEvent(event) {
  switch (event.type) {
    case "player_joined": {
      sfx("join");
      if (state?.phase === "LOBBY" && agent.connected) {
        const names = new Set([...(state?.players ?? []).map((p) => p.name), event.name]);
        agent.context(`JOUEURS: ${[...names].join(", ")}. ${event.name} vient d'arriver.`);
      }
      break;
    }
    case "player_connection":
      if (!event.connected && state && state.phase !== "LOBBY") {
        agent.context(`INFO: ${event.name} a perdu la connexion (ou a fui).`);
      }
      break;
    case "question":
      answerTimeUp = false;
      questionSpoken = !agent.connected;
      clearTimerTimeouts();
      sfx("question");
      // Without the agent, there is nothing to announce: the music starts right away.
      if (!agent.connected) action("start_timer").catch(() => {});
      break;
    case "buzz_winner": {
      // The player's mic opens at once (applyMic below): they answer straight away. The agent is
      // told with a contextual update, which does not make it talk over the player.
      answerTimeUp = false;
      answerHeard = [];
      clearJudgeNudges();
      sfx("buzz");
      const speed = event.reactionS != null ? ` en ${String(event.reactionS).replace(".", ",")} s` : "";
      agent.context(`BUZZ: ${event.name} (id ${event.playerId}) a buzzé en premier${speed} et répond directement `
        + "dans son micro, sans que tu l'appelles. Dès que tu entends sa réponse, juge-la avec submit_verdict "
        + `(playerId "${event.playerId}", avec artist et title), puis réagis. La musique est coupée.`);
      break;
    }
    case "buzz_timeout":
      sfx("timeout");
      tellAgent("TIMEOUT: personne n'a buzzé à temps. Moque gentiment ce silence gênant, "
        + "appelle reveal_answer, annonce l'artiste et le titre, puis appelle next_question.");
      break;
    case "answer_time_up":
      // Time is up: the mic closes after a short tail (see MIC_TAIL_MS). If the player's answer
      // is transcribed meanwhile, onAnswerHeard takes over; otherwise ask the agent to judge.
      answerTimeUp = true;
      micTail = true;
      setTimeout(() => { micTail = false; applyMic(); }, MIC_TAIL_MS);
      syncClip();
      clearTimeout(timeUpTimer);
      timeUpTimer = setTimeout(() => {
        if (state?.phase !== "ANSWERING" || state.answering !== event.playerId) return; // already judged
        if (answerHeard.length > 0) return; // the answer arrived: onAnswerHeard is on it
        tellAgent(`FIN_DU_TEMPS: le temps de ${event.name} est écoulé et son micro est coupé. `
          + "Juge ce que tu as entendu dans le temps imparti, en ignorant le blabla ; si tu n'as rien entendu de clair, c'est faux. "
          + `Appelle submit_verdict (playerId "${event.playerId}", avec artist et title).`);
      }, ANSWER_TRANSCRIPT_GRACE_MS);
      break;
    case "verdict":
      clearTimeout(timeUpTimer);
      clearJudgeNudges();
      if (!event.correct && event.next === "BUZZ_OPEN" && agent.connected) holdMusicForAgent();
      answerTimeUp = false;
      sfx(event.correct ? "correct" : "wrong");
      if (event.by !== "agent") tellAgent(verdictMessage(event));
      break;
    case "locked_spam":
      agent.context(`TAQUINERIE: ${event.name} tape sur son buzzer alors qu'il ou elle est bloqué·e `
        + `(${event.attempts} fois). Tu peux le ou la chambrer à ta prochaine prise de parole.`);
      break;
    case "finished":
      sfx("fanfare");
      break;
  }
  applyMic();
}

function verdictMessage(event) {
  const what = event.found?.artist && event.found?.title ? "l'artiste et le titre"
    : event.found.artist ? "l'artiste (mais pas le titre)" : "le titre (mais pas l'artiste)";
  const who = event.by === "timeout" ? `TROP_LENT: ${event.name} n'a pas répondu à temps, c'est compté faux.`
    : event.correct ? `VERDICT_HOTE: l'hôte a validé ${what} pour ${event.name}, +${event.points} point${event.points > 1 ? "s" : ""}.`
    : `VERDICT_HOTE: l'hôte a refusé la réponse de ${event.name}.`;
  if (event.correct) return `${who} Réagis en une phrase, puis appelle next_question.`;
  if (event.next === "BUZZ_OPEN") return `${who} Chambre-le ou la en une phrase, relance ${event.remaining.join(", ")}, puis tais-toi.`;
  return `${who} Plus personne ne peut répondre : appelle reveal_answer, annonce l'artiste et le titre, puis next_question.`;
}

// ------------------------------------------------------------- controls

async function hostControl(name) {
  unlockAudio();
  try {
    switch (name) {
      case "correct":
      case "wrong":
      case "artist":
      case "title": {
        if (state?.phase !== "ANSWERING") throw new Error("Personne n'a la main.");
        const params = { playerId: state.answering, by: "host" };
        if (name === "wrong") params.correct = false;
        else Object.assign(params, { artist: name !== "title", title: name !== "artist" }); // "correct" = both
        await action("submit_verdict", params);
        break;
      }
      case "timer":
        if (state?.phase !== "QUESTION_READING") throw new Error("La musique tourne déjà, ou aucune chanson n'est en cours.");
        startTimer("host");
        break;
      case "reveal": {
        const result = await action("reveal_answer");
        tellAgent(`REPONSE_HOTE: l'hôte a affiché la réponse (${result.answer}). Commente en une phrase, puis appelle next_question.`);
        break;
      }
      case "next": {
        const result = await action("next_question", { force: true });
        announceQuestion(result, "l'hôte passe à la question suivante");
        break;
      }
      case "pause": {
        const pausing = !state?.paused;
        await action(pausing ? "pause" : "resume");
        agent.setPaused(pausing);
        break;
      }
      case "agent":
        await toggleAgent();
        break;
    }
  } catch (err) {
    log("error", err.message);
    flashMessage(err.message);
  }
}

function announceQuestion(result, why) {
  if (result.finished) {
    tellAgent(`FIN: ${why}, et c'était la dernière. Gagnant·e·s : ${result.winners.join(", ")}. Annonce le podium avec panache.`);
  } else {
    tellAgent(`QUESTION_HOTE: ${why} (chanson ${result.index}/${result.total}). Annonce-la en une phrase, `
      + `appelle start_timer, puis tais-toi pendant la musique. Réponse secrète : ${result.artist} — ${result.title}.`);
  }
}

async function startGame() {
  unlockAudio();
  if (!agent.connected) {
    try {
      await action("start_game");
    } catch (err) {
      flashMessage(err.message);
    }
    return;
  }
  agent.say("DEPART: l'hôte lance la partie ! Fais une intro de deux phrases maximum sur le thème, appelle start_game et annonce la première chanson.");
  // If the agent does not pick it up, start anyway and hand it the question.
  setTimeout(async () => {
    if (state?.phase !== "LOBBY") return;
    try {
      announceQuestion(await action("start_game"), "la partie commence");
    } catch (err) {
      flashMessage(err.message);
    }
  }, START_FALLBACK_MS);
}

function flashMessage(text) {
  const hint = state?.phase === "LOBBY" ? $("agent-help") : $("q-category");
  const previous = hint.textContent;
  hint.textContent = `⚠️ ${text}`;
  setTimeout(() => { if (hint.textContent === `⚠️ ${text}`) hint.textContent = previous; }, 3000);
}

$("start-agent").addEventListener("click", toggleAgent);
$("start-game").addEventListener("click", startGame);
$("new-game").addEventListener("click", () => { location.href = "/"; });
for (const button of document.querySelectorAll("[data-action]")) {
  button.addEventListener("click", () => hostControl(button.dataset.action));
}

const SHORTCUTS = { c: "correct", f: "wrong", a: "artist", s: "title", r: "reveal", n: "next", p: "pause", t: "timer" };
document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.target.matches("input, select, textarea")) return;
  const key = event.key.toLowerCase();
  if (key === "d") $("debug").classList.toggle("hidden");
  else if (SHORTCUTS[key] && state && state.phase !== "LOBBY") hostControl(SHORTCUTS[key]);
});

// ------------------------------------------------------------------ render

function onPhaseChange(from, to) {
  if (to !== "REVEAL") clearAdvanceTimers();
  if (to === "QUESTION_READING") {
    revealMusicOver = false;
    revealMusicTimers.forEach(clearTimeout);
    revealMusicTimers = [];
  }
  if (to === "REVEAL") {
    stopRevealMusicSoon(REVEAL_MUSIC_MAX_MS);
    // The agent may judge and never speak again: start the watchdog now, it is reset each time
    // the agent finishes a sentence.
    scheduleAdvance(ADVANCE_FIRST_NUDGE_MS);
  }
}

// The host screen plays the Deezer preview while buzzing is open, pauses it when
// someone has the hand, and plays it softly under the agent's voice once the answer is out.
// Before the answer, the song has priority: the agent's voice is muted while it plays.
const REVEAL_MUSIC_VOLUME = 0.35;   // agent silent
const REVEAL_DUCKED_VOLUME = 0.12;  // agent talking: its voice stays well above the music
const MUSIC_HOLD_MAX_MS = 4000;     // after a wrong answer, wait for the agent's relaunch line
let currentClip = null;
let musicHold = null;

// The record spins, the tone arm drops and the equalizer dances while the song really plays.
for (const type of ["play", "playing", "pause", "ended", "emptied"]) {
  $("clip").addEventListener(type, () => document.body.classList.toggle("playing", !$("clip").paused));
}

function syncClip() {
  const audio = $("clip");
  const url = state.question?.clipUrl ?? null;
  if (url !== currentClip) {
    currentClip = url;
    audio.pause();
    if (url) audio.src = url;
    else audio.removeAttribute("src");
  }
  const guessing = Boolean(url) && state.phase === "BUZZ_OPEN" && !state.paused && !musicHold;
  const reveal = Boolean(url) && state.phase === "REVEAL" && Boolean(state.answer) && !state.paused && !revealMusicOver;
  // The player who buzzed is answering: nothing from the agent until their answer is heard.
  // A player is answering: anything the agent says now is late (a reaction to an earlier
  // message) and would cover the answer. Its voice comes back with the answer or the time-up.
  const playerAnswering = state.phase === "ANSWERING" && answerHeard.length === 0 && !answerTimeUp;
  agent.setSilenced(guessing || playerAnswering);
  if (!url) return;
  audio.volume = !reveal ? 1 : agent.connected && agentTalking ? REVEAL_DUCKED_VOLUME : REVEAL_MUSIC_VOLUME;
  if ((guessing || reveal) && audio.paused) audio.play().catch((err) => log("error", `clip: ${err.message}`));
  if (!guessing && !reveal && !audio.paused) audio.pause();
}

/** After a wrong answer, the agent relaunches the others: resume the song once it is done. */
function holdMusicForAgent() {
  releaseMusic();
  musicHold = setTimeout(() => releaseMusic("timeout"), MUSIC_HOLD_MAX_MS);
}

function releaseMusic(reason) {
  if (!musicHold) return;
  clearTimeout(musicHold);
  musicHold = null;
  if (reason) log("agent", `song resumes (${reason})`);
  if (state) syncClip();
}

function onState(next) {
  state = next;
  if (state.phase !== previousPhase) onPhaseChange(previousPhase, state.phase);
  previousPhase = state.phase;
  syncClip();
  if (state.phase !== "QUESTION_READING") clearTimerTimeouts();
  deadlineAt = state.deadlineIn != null ? performance.now() / 1000 + state.deadlineIn : null;
  render();
  applyMic();
}

function render() {
  const phase = state.phase;
  $("room-pill").textContent = `Salle ${code}`;
  $("theme-pill").textContent = `${themeEmoji(state.theme)} ${state.theme}`;
  $("lobby").classList.toggle("hidden", phase !== "LOBBY");
  $("stage").classList.toggle("hidden", !ACTIVE_PHASES.includes(phase));
  $("finished").classList.toggle("hidden", phase !== "FINISHED");
  $("controls").classList.toggle("hidden", !ACTIVE_PHASES.includes(phase));
  if (phase === "LOBBY") renderLobby();
  else if (phase === "FINISHED") renderFinished();
  else renderStage();
  $("pause-btn").textContent = state.paused ? "▶️ Reprendre" : "⏸️ Pause";
}

let qrLoaded = false;
const seenPlayers = new Set(); // only newcomers get the entrance animation
let themeEmojis = {};
fetch("/api/themes").then((r) => r.json()).then((themes) => {
  themeEmojis = Object.fromEntries(themes.map((t) => [t.label, t.emoji]));
  if (state) render();
}).catch(() => {});

function themeEmoji(label) {
  return themeEmojis[label] ?? "🎵";
}

function renderLobby() {
  if (!qrLoaded) {
    qrLoaded = true;
    $("qr").src = `/api/rooms/${code}/qr.svg`;
    $("code-big").textContent = code;
    fetch(`/api/rooms/${code}`).then((r) => r.json()).then((room) => {
      $("join-url").textContent = room.joinUrl;
    });
  }
  $("lobby-theme").textContent = state.theme;
  $("lobby-theme-emoji").textContent = themeEmoji(state.theme);
  const players = state.players;
  $("player-count").textContent = players.length ? `(${players.length})` : "";
  $("lobby-players").innerHTML = players.map((p) => {
    const isNew = !seenPlayers.has(p.id);
    seenPlayers.add(p.id);
    return `<li style="background:${p.color}" class="${isNew ? "new" : ""} ${p.connected ? "" : "offline"}">${escapeHtml(p.name)}</li>`;
  }).join("");
  $("lobby-hint").textContent = players.length
    ? "Tout le monde est là ? Lancez l'animateur, puis démarrez la partie."
    : "On attend les retardataires. Il y en a toujours un.";
  $("start-game").disabled = players.length === 0;
}

function renderStage() {
  const question = state.question;
  if (question && renderedQuestion !== state.questionNumber) {
    renderedQuestion = state.questionNumber;
    // Re-insert the node to replay the entrance animation.
    const node = $("q-text");
    node.textContent = question.text;
    node.replaceWith(node.cloneNode(true));
  }
  $("q-progress").textContent = `${state.questionNumber}/${state.totalQuestions}`;
  if (!$("q-category").textContent.startsWith("⚠️")) {
    $("q-category").textContent = { QUESTION_READING: "🎙️ Écoutez bien…", BUZZ_OPEN: "🎶 Qui chante ?",
      ANSWERING: "🛎️ Buzz !", REVEAL: "💿 Réponse" }[state.phase] ?? "";
  }
  $("paused-pill").classList.toggle("hidden", !state.paused);

  const answering = state.phase === "ANSWERING" ? state.answering : null;
  $("answering").classList.toggle("hidden", !answering);
  if (answering) {
    const name = playerName(answering);
    $("answering-text").textContent = answerHeard.length > 0 || answerTimeUp ? `🤔 ${name} a répondu… verdict ?`
      : agent.connected ? `🎙️ À l'écoute de ${name}` : `${name} a la main`;
  }

  $("answer").classList.toggle("hidden", !state.answer);
  $("answer-title").textContent = state.title ?? "";
  $("answer-artist").textContent = state.artist ?? "";
  $("answer-year").textContent = state.year ?? "";
  $("answer-year").classList.toggle("hidden", !state.year);
  // The record's label becomes the album cover once the answer is out.
  $("cover").classList.toggle("hidden", !state.coverUrl);
  if (state.coverUrl && $("cover").getAttribute("src") !== state.coverUrl) $("cover").src = state.coverUrl;
  $("label-text").textContent = !state.answer ? "?" : state.coverUrl ? "" : "♪";

  const colors = Object.fromEntries(state.players.map((p) => [p.id, p]));
  $("scores").innerHTML = state.ranking.map((row) => {
    const player = colors[row.playerId];
    const classes = [
      row.playerId === state.answering ? "hand" : "",
      player?.locked ? "locked" : "",
      player?.connected === false ? "offline" : "",
    ].join(" ");
    const streak = row.streak >= 2 ? ` <span class="streak">🔥${row.streak}</span>` : "";
    return `<li class="score-row top${row.rank} ${classes}">
      <span class="rank">${row.rank}</span>
      <span class="name"><span class="swatch" style="background:${player?.color}"></span>${escapeHtml(row.name)}${streak}</span>
      <span class="pts">${row.score}</span></li>`;
  }).join("");
}

function renderFinished() {
  const ranking = state.ranking;
  const byRank = (rank) => ranking.filter((r) => r.rank === rank);
  const step = (rank, cls) => {
    const names = byRank(rank).map((r) => escapeHtml(r.name)).join("<br>");
    const award = { 1: "Disque d'or", 2: "Platine… presque", 3: "Bronze" }[rank];
    return names ? `<div class="step ${cls}"><div class="sheen vinyl"><div class="label"></div></div>`
      + `<span class="who">${names}</span><div class="block">${award}</div></div>` : "";
  };
  $("podium").innerHTML = step(2, "r2") + step(1, "r1") + step(3, "r3");
  $("final-scores").innerHTML = ranking.map((r) =>
    `<li class="score-row top${r.rank}"><span class="rank">${r.rank}</span><span class="name">${escapeHtml(r.name)}</span><span class="pts">${r.score}</span></li>`).join("");
  if (!celebrated) {
    celebrated = true;
    celebrate($("confetti"));
  }
}

function renderAgent() {
  const pill = $("agent-pill");
  const labels = {
    connected: agent.mode === "speaking" ? "Animateur parle" : "Animateur écoute",
    connecting: "Connexion de l'animateur…",
    disconnecting: "Déconnexion…",
    disconnected: agentConfigured ? "Animateur absent" : "Mode manuel (pas d'agent configuré)",
  };
  $("agent-text").textContent = labels[agent.status] ?? agent.status;
  pill.classList.toggle("speaking", agent.connected && agent.mode === "speaking");
  pill.classList.toggle("listening", agent.connected && agent.mode === "listening");

  const startButton = $("start-agent");
  startButton.disabled = !agentConfigured || agent.status === "connecting";
  startButton.textContent = agent.connected ? "🛑 Couper l'animateur" : "🎙️ Lancer l'animateur";
  $("agent-btn").textContent = agent.connected ? "🛑 Animateur" : "🎙️ Animateur";
  $("agent-btn").disabled = !agentConfigured;
  if (!agentConfigured) {
    $("agent-help").textContent = "Aucun agent ElevenLabs configuré (ELEVENLABS_AGENT_ID) : lancez les extraits et jugez avec les boutons.";
  } else if (agent.connected && state?.phase === "LOBBY") {
    $("agent-help").textContent = "L'animateur vous écoute : discutez avec lui, puis démarrez la partie.";
  } else if (!$("agent-help").textContent.startsWith("Impossible")) {
    $("agent-help").textContent = "Le navigateur va demander l'accès au micro : il sert à entendre les réponses des joueurs.";
  }
}

function animateTimer() {
  const bar = $("timer-bar");
  if (state && deadlineAt && !state.paused && !["reading", "answer_hard"].includes(state.deadlineKind)) {
    const remaining = Math.max(0, deadlineAt - performance.now() / 1000);
    bar.style.width = `${Math.min(100, (remaining / (state.deadlineTotal || 20)) * 100)}%`;
  } else {
    bar.style.width = "0";
  }
  requestAnimationFrame(animateTimer);
}

if (!hostKey) {
  fatal(`Clé hôte introuvable pour la salle ${escapeHtml(code)}.<br><a href="/">Créer une nouvelle partie</a>`);
  socket.close();
} else {
  scatterNotes();
  equalizer($("eq"), 28);
  renderAgent();
  animateTimer();
}
