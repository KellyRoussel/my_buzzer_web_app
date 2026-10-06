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
const READING_MIN_MS = 1500; // ignore agent pauses right after a question opens
const START_FALLBACK_MS = 8000;

let state = null;
let agentConfigured = false;
let answerTimeUp = false;
let questionStartedAt = 0;
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
  const secretKeys = new Set(["acceptedAnswers", "answer"]);
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
    // The agent stopped talking after reading the question: start the buzz countdown.
    if (previous === "speaking" && mode === "listening" && state?.phase === "QUESTION_READING"
        && performance.now() - questionStartedAt > READING_MIN_MS) {
      action("reading_done").catch(() => {});
    }
  },
  onLog: log,
});

/** The room microphone is open only when someone is expected to talk to the agent. */
function desiredMicOpen() {
  if (!agent.connected || !state || state.paused) return false;
  if (state.phase === "LOBBY" || state.phase === "FINISHED") return true;
  return state.phase === "ANSWERING" && !answerTimeUp;
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
      questionStartedAt = performance.now();
      answerTimeUp = false;
      sfx("question");
      break;
    case "buzz_winner": {
      answerTimeUp = false;
      sfx("buzz");
      agent.duck();
      const speed = event.reactionS != null ? ` en ${String(event.reactionS).replace(".", ",")} s` : "";
      const text = `BUZZ: ${event.name} (id ${event.playerId}) a buzzé en premier${speed}. `
        + `Arrête-toi immédiatement, donne-lui la parole en trois mots (« ${event.name}, on t'écoute ! ») `
        + `et écoute UNE réponse, puis appelle submit_verdict avec playerId "${event.playerId}".`;
      if ($("buzz-as-context").checked) agent.context(text);
      else tellAgent(text);
      break;
    }
    case "buzz_timeout":
      sfx("timeout");
      tellAgent("TIMEOUT: personne n'a buzzé à temps. Moque gentiment ce silence gênant, "
        + "appelle reveal_answer, annonce la réponse, puis appelle next_question.");
      break;
    case "answer_time_up":
      answerTimeUp = true;
      tellAgent(`FIN_DU_TEMPS: le micro de ${event.name} est coupé. Juge maintenant ce que tu as entendu `
        + `avec submit_verdict (playerId "${event.playerId}"). Si tu n'as rien entendu de clair, c'est faux.`);
      break;
    case "verdict":
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
  const who = event.by === "timeout" ? `TROP_LENT: ${event.name} n'a pas répondu à temps, c'est compté faux.`
    : event.correct ? `VERDICT_HOTE: l'hôte a validé la réponse de ${event.name}, +1 point.`
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
        if (state?.phase !== "ANSWERING") throw new Error("Personne n'a la main.");
        await action("submit_verdict", { playerId: state.answering, correct: name === "correct", by: "host" });
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
    tellAgent(`QUESTION_HOTE: ${why} (${result.index}/${result.total}, ${result.category}). `
      + `Lis exactement : « ${result.question} » Réponses acceptées, secrètes : ${result.acceptedAnswers.join(", ")}. Puis tais-toi.`);
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

const SHORTCUTS = { c: "correct", f: "wrong", r: "reveal", n: "next", p: "pause" };
document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.target.matches("input, select, textarea")) return;
  const key = event.key.toLowerCase();
  if (key === "d") $("debug").classList.toggle("hidden");
  else if (SHORTCUTS[key] && state && state.phase !== "LOBBY") hostControl(SHORTCUTS[key]);
});

// ------------------------------------------------------------------ render

function onState(next) {
  state = next;
  deadlineAt = state.deadlineIn != null ? performance.now() / 1000 + state.deadlineIn : null;
  render();
  applyMic();
}

function render() {
  const phase = state.phase;
  $("room-pill").textContent = `Salle ${code}`;
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
  const key = `${state.questionNumber}`;
  if (question && renderedQuestion !== key) {
    renderedQuestion = key;
    // Re-insert the node to replay the entrance animation.
    const node = $("q-text");
    node.textContent = question.text;
    node.replaceWith(node.cloneNode(true));
  }
  $("q-progress").textContent = `Question ${state.questionNumber}/${state.totalQuestions}`;
  if (question && !$("q-category").textContent.startsWith("⚠️")) $("q-category").textContent = question.category;
  $("paused-pill").classList.toggle("hidden", !state.paused);

  const answering = state.phase === "ANSWERING" ? state.answering : null;
  $("answering").classList.toggle("hidden", !answering);
  if (answering) {
    const listening = agent.connected && !answerTimeUp;
    $("answering-text").textContent = listening ? `🎙️ À l'écoute de ${playerName(answering)}` : `${playerName(answering)} a la main`;
  }

  $("answer").classList.toggle("hidden", !state.answer);
  $("answer-text").textContent = state.answer ?? "";

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
  if (state && deadlineAt && !state.paused && state.deadlineKind !== "reading") {
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
