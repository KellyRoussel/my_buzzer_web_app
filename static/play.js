// Player phone: nickname, then one giant BUZZ button.
import { connect, pick, roomCodeFromPath, storage, wsUrl } from "/static/common.js";

const code = roomCodeFromPath();
const session = storage("session");
const storageKey = `quiz.player.${code}`;

const $ = (id) => document.getElementById(id);
const joinForm = $("join");
const game = $("game");
const buzzButton = $("buzz");

let identity = session.get(storageKey); // { playerId, name }
let state = null;
let flash = null; // short-lived feedback after a buzz ({ cls, big, small, until })
let deadlineAt = null;

const TEASES = {
  lobby: [
    "Échauffe ton pouce, ça va chauffer.",
    "L'animateur arrive. Il paraît qu'il ne fait pas de cadeaux.",
    "Profite, c'est le seul moment où tu es ex aequo avec tout le monde.",
  ],
  armed: ["Buzze si tu l'oses.", "Le premier qui buzze a la main.", "Vas-y, on y croit (un peu)."],
  hand: ["Parle fort et distinctement. Pas de pression.", "Toute la salle t'écoute. Vraiment toute.", "C'est ton moment de gloire. Ou pas."],
  late: ["Trop tard, escargot 🐌", "Raté, quelqu'un a été plus rapide.", "La prochaine fois, buzze avant de réfléchir."],
  locked: ["Bloqué·e pour cette question 🙊", "Tu as eu ta chance. Elle est partie.", "Le buzzer ne va pas changer d'avis."],
  reveal: ["Suspense…", "Prochaine question dans un instant.", "Respire, ça repart."],
  paused: ["Pause ☕", "L'animateur reprend son souffle."],
};

// ------------------------------------------------------------------ joining

function showJoin(error = "") {
  $("join-code").textContent = code;
  $("join-error").textContent = error;
  joinForm.classList.remove("hidden");
  game.classList.add("hidden");
  $("name").value = identity?.name || "";
  $("name").focus();
}

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("name").value.trim();
  if (!name) return;
  identity = { playerId: identity?.playerId || null, name };
  sendJoin();
});

function sendJoin() {
  if (!identity) return;
  socket.send({ type: "join", name: identity.name, playerId: identity.playerId });
}

// ------------------------------------------------------------------- socket

const socket = connect(wsUrl(`/ws/${code}/player`), {
  onOpen: () => {
    if (identity) sendJoin();
    else showJoin();
  },
  onStatus: (status) => {
    const conn = $("conn");
    conn.textContent = status === "open" ? "" : status === "closed" ? "Déconnecté" : "Reconnexion…";
    conn.classList.toggle("warn", status !== "open");
  },
  onMessage: (message) => {
    if (message.type === "joined") {
      identity = { playerId: message.playerId, name: message.name };
      session.set(storageKey, identity);
      joinForm.classList.add("hidden");
      game.classList.remove("hidden");
      $("me-name").textContent = message.name;
      $("me-color").style.background = message.color;
    } else if (message.type === "state") {
      state = message.state;
      deadlineAt = state.deadlineIn != null ? performance.now() / 1000 + state.deadlineIn : null;
      render();
    } else if (message.type === "buzz_result") {
      onBuzzResult(message.result);
    } else if (message.type === "error") {
      if (message.code === "room_not_found") {
        showJoin("Cette salle n'existe pas (ou plus). Vérifie le code sur l'écran.");
        $("name").disabled = true;
      } else {
        showJoin(message.message);
      }
    }
  },
});

// --------------------------------------------------------------------- buzz

function buzz(event) {
  event?.preventDefault();
  if (!state || state.phase === "LOBBY" || state.phase === "FINISHED") return;
  if (socket.send({ type: "buzz" })) navigator.vibrate?.(60);
}

buzzButton.addEventListener("pointerdown", buzz);
buzzButton.addEventListener("click", (event) => event.preventDefault());
document.addEventListener("keydown", (event) => {
  if (event.code === "Space" && !game.classList.contains("hidden")) buzz(event);
});

function onBuzzResult(result) {
  const now = performance.now();
  if (result === "too_early") {
    flash = { cls: "late", big: "TROP TÔT", small: "Attends la fin de la question, petit malin 🙃", until: now + 1400 };
  } else if (result === "too_late") {
    flash = { cls: "late", big: "TROP TARD", small: pick(TEASES.late), until: now + 1400 };
  } else if (result === "locked") {
    flash = { cls: "locked", big: "BLOQUÉ", small: pick(TEASES.locked), until: now + 1400 };
  } else if (result === "accepted") {
    navigator.vibrate?.([80, 40, 80]); // your mic is open: answer now
  }
  render();
  if (flash) setTimeout(render, 1450);
}

// ------------------------------------------------------------------- render

function view() {
  const seed = `${state.questionNumber}-${state.phase}`;
  const me = state.me;
  if (state.paused) return { cls: "waiting", big: "PAUSE", small: pick(TEASES.paused, seed) };
  switch (state.phase) {
    case "LOBBY":
      return { cls: "waiting", big: "PRÊT ?", small: `${me.playerCount} joueur·s dans la salle. ${pick(TEASES.lobby, me.id)}` };
    case "QUESTION_READING":
      return { cls: "waiting", big: "ÉCOUTE…", small: state.mode === "blindtest"
        ? "Le buzzer s'active quand la musique démarre." : "Le buzzer s'active quand le chrono démarre." };
    case "BUZZ_OPEN":
      if (state.locked) return { cls: "locked", big: "BLOQUÉ", small: pick(TEASES.locked, seed) };
      return { cls: "armed", big: "BUZZ", small: state.mode === "blindtest" ? "Qui chante ? Quel titre ?" : pick(TEASES.armed, seed), color: me.color };
    case "ANSWERING":
      if (state.hasHand) return { cls: "hand", big: "PARLE !", small: pick(TEASES.hand, seed) };
      if (state.locked) return { cls: "locked", big: "BLOQUÉ", small: `${state.answeringName} tente sa chance.` };
      return { cls: "late", big: "TROP TARD", small: `${state.answeringName} a la main.` };
    case "REVEAL":
      return { cls: "waiting", big: state.answer ? "RÉPONSE" : "…", small: state.answer || pick(TEASES.reveal, seed) };
    case "FINISHED": {
      if (me.rank === 1) return { cls: "win", big: "🏆 VICTOIRE", small: "Savoure. Ça ne durera pas." };
      const last = me.rank === me.playerCount && me.playerCount > 1;
      return {
        cls: "waiting",
        big: `#${me.rank}`,
        small: last ? "Dernier·e. Mais avec panache, on a vu." : `Sur ${me.playerCount}. Pas mal, pas ouf.`,
      };
    }
    default:
      return { cls: "waiting", big: "…", small: "" };
  }
}

function render() {
  if (!state) return;
  let v = view();
  if (flash && performance.now() < flash.until && !state.hasHand) v = { ...v, ...flash };
  else flash = null;

  buzzButton.className = v.cls + (flash ? " flash" : "");
  buzzButton.style.background = v.color && !flash ? v.color : "";
  $("buzz-big").textContent = v.big;
  $("buzz-big").classList.toggle("long", [...v.big].length > 6);
  $("buzz-small").textContent = v.small;

  const me = state.me;
  $("score").textContent = `${me.score} pt${me.score > 1 ? "s" : ""}` + (me.rank ? ` · ${me.rank}${me.rank === 1 ? "er" : "e"}/${me.playerCount}` : "");
  $("progress").textContent = state.questionNumber ? `Question ${state.questionNumber}/${state.totalQuestions}` : `Salle ${code}`;
}

function animateTimer() {
  const bar = $("timer-bar");
  if (state && deadlineAt && !state.paused && state.deadlineKind !== "reading") {
    const remaining = Math.max(0, deadlineAt - performance.now() / 1000);
    const total = state.deadlineTotal || 20;
    bar.style.width = `${Math.min(100, (remaining / total) * 100)}%`;
  } else {
    bar.style.width = "0";
  }
  requestAnimationFrame(animateTimer);
}

animateTimer();
if (!identity) showJoin();
