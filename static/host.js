// Host screen: shows the game on the TV and bridges the game server and the voice agent.
//
// The game server owns the state. The voice agent never holds it: it reads and changes it
// through client tools, which this page relays to the server over the host WebSocket.
import { QuizAgent } from "/static/agent.js";
import { connect, escapeHtml, roomCodeFromPath, storage, wsUrl } from "/static/common.js";
import { celebrate, sfx, unlockAudio } from "/static/effects.js";

const code = roomCodeFromPath();
const session = storage("session");
const $ = (id) => document.getElementById(id);

const ACTIVE_PHASES = ["QUESTION_READING", "BUZZ_OPEN", "ANSWERING", "REVEAL"];
const START_FALLBACK_MS = 8000;
// After a buzz the agent calls the player ("Kelly ?"); the mic opens once it stops talking.
const FLOOR_GRACE_MS = 250;     // let the last syllable play out before opening the mic
const FLOOR_SILENT_MS = 2500;   // the agent did not say anything: open anyway
const FLOOR_MAX_MS = 4500;      // never wait longer (the server opens it at 5 s regardless)
// The agent calls start_timer as soon as the LLM emits it, often while the question audio is
// still playing: the countdown really starts when the agent stops talking.
const TIMER_DEFER_MAX_MS = 15000;
// The agent read the question but forgot start_timer: start it after this much silence.
const TIMER_FALLBACK_MS = 4000;
// When the answer window closes mid-sentence, the mic is muted at once (nothing said later is
// heard) but the transcript of what was said in time arrives a moment later: wait for it
// before asking the agent to judge, unless the agent judges on its own first.
const ANSWER_TRANSCRIPT_GRACE_MS = 2500;

let state = null;
let agentConfigured = false;
let answerTimeUp = false;
let questionSpoken = false; // has the agent actually read the current question out loud?
let floorGate = null; // pending "open the floor" after a buzz: { sentAt, sawSpeech, timers }
let timerRequest = null; // start_timer called while the agent was still talking
let answerHeard = []; // transcripts of the player's answer, captured while their mic was open
let timeUpTimer = null;
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
  const secretKeys = new Set(["acceptedAnswers", "answer", "artist", "title", "acceptedArtists", "acceptedTitles"]);
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
  onOpen: () => socket.send({ type: "auth", key: hostKey }),
  onStatus: (status) => {
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
function action(name, params = {}) {
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
    submit_verdict: ({ playerId, correct }) => action("submit_verdict", { playerId, correct, by: "agent" }),
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
    // A *new* speaking turn after the BUZZ message (an ongoing one is the old, ducked speech).
    if (mode === "speaking" && previous !== "speaking" && floorGate) floorGate.sawSpeech = true;
    if (mode === "speaking") clearTimerTimeouts({ keepRequest: true });
    if (previous !== "speaking" || mode !== "listening") return;
    // The agent stopped talking after calling the player who buzzed: give them the floor.
    if (floorGate?.sawSpeech) setTimeout(() => openFloor("agent done"), FLOOR_GRACE_MS);
    if (state?.phase !== "QUESTION_READING") return;
    // start_timer was called during the question: the audio has now finished playing.
    if (timerRequest) startTimer("agent finished speaking");
    // The agent read the question but did not call start_timer: start it after a short silence.
    else if (questionSpoken) timerFallback = setTimeout(() => startTimer("fallback, no start_timer"), TIMER_FALLBACK_MS);
  },
  onUserText: (text) => {
    // The mic is only open during the answer window, so this is what the player said in time.
    if (state?.phase === "ANSWERING" && state.floorOpen) answerHeard.push(text);
  },
  onAgentText: (text) => {
    if (floorGate) floorGate.sawSpeech = true;
    if (state?.phase === "QUESTION_READING" && !questionSpoken && state.question
        && mentionsQuestion(text, state.question.text)) {
      questionSpoken = true;
      log("agent", "question read out loud");
      render();
    }
  },
  onLog: log,
});

/** start_timer tool: start the countdown once the agent has finished reading the question. */
function requestTimerFromAgent() {
  if (state?.phase === "BUZZ_OPEN") return { ok: true, note: "Le chrono tourne déjà. Tais-toi et attends BUZZ ou TIMEOUT." };
  if (state?.phase !== "QUESTION_READING") throw new Error("Aucune question n'attend de chrono en ce moment.");
  if (agent.mode === "speaking") {
    clearTimerTimeouts();
    timerRequest = setTimeout(() => startTimer("agent still talking after 15 s"), TIMER_DEFER_MAX_MS);
    log("agent", "start_timer: deferred until the agent stops talking");
  } else {
    startTimer("agent");
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

/** The room microphone is open only when someone is expected to talk to the agent. */
function desiredMicOpen() {
  if (!agent.connected || !state || state.paused) return false;
  if (state.phase === "LOBBY" || state.phase === "FINISHED") return true;
  return state.phase === "ANSWERING" && state.floorOpen && !answerTimeUp;
}

const normalize = (text) => text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/\[[^\]]*\]/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

/** Does what the agent said contain the question? (Tolerates small rewordings.) */
function mentionsQuestion(said, question) {
  const saidWords = new Set(normalize(said).split(" "));
  const keyWords = normalize(question).split(" ").filter((w) => w.length > 3);
  if (keyWords.length === 0) return true;
  return keyWords.filter((w) => saidWords.has(w)).length / keyWords.length >= 0.6;
}

function armFloorGate() {
  clearFloorGate();
  floorGate = { sentAt: performance.now(), sawSpeech: false, timers: [] };
  floorGate.timers.push(setTimeout(() => {
    if (floorGate && !floorGate.sawSpeech && agent.mode !== "speaking") openFloor("agent silent");
  }, FLOOR_SILENT_MS));
  floorGate.timers.push(setTimeout(() => openFloor("timeout"), FLOOR_MAX_MS));
}

function clearFloorGate() {
  if (floorGate) floorGate.timers.forEach(clearTimeout);
  floorGate = null;
}

function openFloor(reason) {
  if (!floorGate) return;
  clearFloorGate();
  log("agent", `floor open (${reason})`);
  action("open_floor").catch(() => {});
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
      // Without the agent, the host reads the question aloud right away: start the countdown.
      if (!agent.connected) action("start_timer").catch(() => {});
      break;
    case "buzz_winner": {
      answerTimeUp = false;
      sfx("buzz");
      if (!agent.connected) {
        action("open_floor").catch(() => {});
        break;
      }
      agent.duck();
      armFloorGate();
      const speed = event.reactionS != null ? ` en ${String(event.reactionS).replace(".", ",")} s` : "";
      const text = `BUZZ: ${event.name} (id ${event.playerId}) a buzzé en premier${speed}. `
        + `Arrête-toi immédiatement et dis UNIQUEMENT « ${event.name} ? », rien d'autre : son micro s'ouvre `
        + `dès que tu te tais. Écoute UNE réponse, puis appelle submit_verdict avec playerId "${event.playerId}"`
        + (isSongRound() ? " et artist / title (true ou false). La musique est coupée." : ".");
      if ($("buzz-as-context").checked) agent.context(text);
      else tellAgent(text);
      break;
    }
    case "floor_open": {
      clearFloorGate();
      answerHeard = [];
      break;
    }
    case "buzz_timeout":
      sfx("timeout");
      tellAgent("TIMEOUT: personne n'a buzzé à temps. Moque gentiment ce silence gênant, "
        + "appelle reveal_answer, annonce la réponse, puis appelle next_question.");
      break;
    case "answer_time_up":
      answerTimeUp = true; // mutes the mic (applyMic below): what is said from now on does not count
      clearTimeout(timeUpTimer);
      timeUpTimer = setTimeout(() => {
        if (state?.phase !== "ANSWERING" || state.answering !== event.playerId) return; // already judged
        const heard = answerHeard.join(" ").trim();
        tellAgent(`FIN_DU_TEMPS: le temps de ${event.name} est écoulé et son micro est coupé. `
          + (heard ? `Voici tout ce qu'il ou elle a dit dans le temps imparti : « ${heard} ». `
              + "Juge la réponse donnée là-dedans, même si elle est suivie de blabla, et ignore tout ce qui viendrait après. "
            : "Aucune réponse n'a été captée dans le temps imparti : c'est faux. ")
          + `Appelle submit_verdict (playerId "${event.playerId}"${isSongRound() ? ", avec artist et title" : ""}).`);
      }, ANSWER_TRANSCRIPT_GRACE_MS);
      break;
    case "verdict":
      clearTimeout(timeUpTimer);
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
  const what = !event.found ? "la réponse"
    : event.found.artist && event.found.title ? "l'artiste et le titre"
    : event.found.artist ? "l'artiste (mais pas le titre)" : "le titre (mais pas l'artiste)";
  const who = event.by === "timeout" ? `TROP_LENT: ${event.name} n'a pas répondu à temps, c'est compté faux.`
    : event.correct ? `VERDICT_HOTE: l'hôte a validé ${what} pour ${event.name}, +${event.points} point${event.points > 1 ? "s" : ""}.`
    : `VERDICT_HOTE: l'hôte a refusé la réponse de ${event.name}.`;
  if (event.correct) return `${who} Réagis en une phrase, puis appelle next_question.`;
  if (event.next === "BUZZ_OPEN") return `${who} Chambre-le ou la en une phrase, relance ${event.remaining.join(", ")}, puis tais-toi.`;
  return `${who} Plus personne ne peut répondre : appelle reveal_answer, annonce la réponse, puis next_question.`;
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
        if (!isSongRound() && (name === "artist" || name === "title")) throw new Error("Pas de chanson en cours.");
        const params = { playerId: state.answering, by: "host" };
        if (!isSongRound()) params.correct = name === "correct";
        else if (name === "wrong") params.correct = false;
        else Object.assign(params, { artist: name !== "title", title: name !== "artist" }); // "correct" = both
        await action("submit_verdict", params);
        break;
      }
      case "timer":
        if (state?.phase !== "QUESTION_READING") throw new Error("Le chrono tourne déjà, ou aucune question n'est en cours.");
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
  } else if (result.kind === "chanson") {
    tellAgent(`QUESTION_HOTE: ${why} (chanson ${result.index}/${result.total}). Annonce-la en une phrase, `
      + `appelle start_timer, puis tais-toi pendant la musique. Réponse secrète : ${result.artist} — ${result.title}.`);
  } else {
    tellAgent(`QUESTION_HOTE: ${why} (${result.index}/${result.total}, ${result.category}). `
      + `Lis exactement : « ${result.question} » Réponses acceptées, secrètes : ${result.acceptedAnswers.join(", ")}. `
      + "Puis appelle start_timer et tais-toi.");
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
  agent.say("DEPART: l'hôte lance la partie ! Fais une intro de deux phrases maximum, appelle start_game et lis la première question.");
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

function isSongRound() {
  return state?.question?.kind === "song";
}

// Blind test: the host screen plays the Deezer preview while buzzing is open, pauses it when
// someone has the hand, and plays it softly under the agent's voice once the answer is out.
let currentClip = null;

function syncClip() {
  const audio = $("clip");
  const url = isSongRound() ? state.question.clipUrl : null;
  if (url !== currentClip) {
    currentClip = url;
    audio.pause();
    if (url) audio.src = url;
    else audio.removeAttribute("src");
  }
  if (!url) return;
  const reveal = state.phase === "REVEAL" && Boolean(state.answer);
  const playing = !state.paused && (state.phase === "BUZZ_OPEN" || reveal);
  audio.volume = reveal ? 0.25 : 1;
  if (playing && audio.paused) audio.play().catch((err) => log("error", `clip: ${err.message}`));
  if (!playing && !audio.paused) audio.pause();
}

function onState(next) {
  state = next;
  syncClip();
  if (state.phase !== "ANSWERING" || state.floorOpen) clearFloorGate();
  if (state.phase !== "QUESTION_READING") clearTimerTimeouts();
  deadlineAt = state.deadlineIn != null ? performance.now() / 1000 + state.deadlineIn : null;
  render();
  applyMic();
}

function render() {
  const phase = state.phase;
  $("room-pill").textContent = `Salle ${code}${state.mode === "blindtest" ? " · 🎵 Blind test" : ""}`;
  for (const button of document.querySelectorAll(".song-only")) button.classList.toggle("hidden", state.mode !== "blindtest");
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

function renderLobby() {
  if (!qrLoaded) {
    qrLoaded = true;
    $("qr").src = `/api/rooms/${code}/qr.svg`;
    $("code-big").textContent = code;
    fetch(`/api/rooms/${code}`).then((r) => r.json()).then((room) => {
      $("join-url").textContent = room.joinUrl;
    });
  }
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
  // With the agent, the question appears on screen as it is read out, not before.
  const visible = !agent.connected || questionSpoken || state.phase !== "QUESTION_READING"
    || question?.kind === "song"; // nothing to give away: the song is the question
  const key = `${state.questionNumber}-${visible}`;
  if (question && renderedQuestion !== key) {
    renderedQuestion = key;
    // Re-insert the node to replay the entrance animation.
    const node = $("q-text");
    node.textContent = visible ? question.text : "🎙️ Écoutez bien…";
    node.replaceWith(node.cloneNode(true));
  }
  $("q-progress").textContent = `Question ${state.questionNumber}/${state.totalQuestions}`;
  if (question && !$("q-category").textContent.startsWith("⚠️")) $("q-category").textContent = question.category;
  $("paused-pill").classList.toggle("hidden", !state.paused);

  const answering = state.phase === "ANSWERING" ? state.answering : null;
  $("answering").classList.toggle("hidden", !answering);
  if (answering) {
    const name = playerName(answering);
    $("answering-text").textContent = !state.floorOpen ? `🔔 ${name} a buzzé !`
      : agent.connected && !answerTimeUp ? `🎙️ À l'écoute de ${name}` : `${name} a la main`;
  }

  $("answer").classList.toggle("hidden", !state.answer);
  $("answer-text").textContent = state.answer ?? "";
  $("cover").classList.toggle("hidden", !state.coverUrl);
  if (state.coverUrl && $("cover").getAttribute("src") !== state.coverUrl) $("cover").src = state.coverUrl;

  const colors = Object.fromEntries(state.players.map((p) => [p.id, p]));
  $("scores").innerHTML = state.ranking.map((row) => {
    const player = colors[row.playerId];
    const classes = [
      row.playerId === state.answering ? "hand" : "",
      player?.locked ? "locked" : "",
      player?.connected === false ? "offline" : "",
    ].join(" ");
    const streak = row.streak >= 2 ? ` <span class="streak">🔥${row.streak}</span>` : "";
    return `<li class="score-row ${classes}">
      <span class="rank">${row.rank}.</span>
      <span class="name"><span class="swatch" style="background:${player?.color}"></span>${escapeHtml(row.name)}${streak}</span>
      <span class="pts">${row.score}</span></li>`;
  }).join("");
}

function renderFinished() {
  const ranking = state.ranking;
  const byRank = (rank) => ranking.filter((r) => r.rank === rank);
  const step = (rank, cls) => {
    const names = byRank(rank).map((r) => escapeHtml(r.name)).join("<br>");
    return names ? `<div class="step ${cls}"><span class="who">${names}</span><div class="block">${rank}</div></div>` : "";
  };
  $("podium").innerHTML = step(2, "r2") + step(1, "r1") + step(3, "r3");
  $("final-scores").innerHTML = ranking.map((r) =>
    `<li class="score-row"><span class="rank">${r.rank}.</span><span class="name">${escapeHtml(r.name)}</span><span class="pts">${r.score}</span></li>`).join("");
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
    $("agent-help").textContent = "Aucun agent ElevenLabs configuré (ELEVENLABS_AGENT_ID) : lisez les questions vous-même et jugez avec les boutons.";
  } else if (agent.connected && state?.phase === "LOBBY") {
    $("agent-help").textContent = "L'animateur vous écoute : discutez avec lui, puis démarrez la partie.";
  } else if (!$("agent-help").textContent.startsWith("Impossible")) {
    $("agent-help").textContent = "Le navigateur va demander l'accès au micro : il sert à entendre les réponses des joueurs.";
  }
}

function animateTimer() {
  const bar = $("timer-bar");
  if (state && deadlineAt && !state.paused && !["reading", "floor"].includes(state.deadlineKind)) {
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
  renderAgent();
  animateTimer();
}
