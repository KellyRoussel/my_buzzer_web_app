# Blind Test agent configuration

This file makes the ElevenLabs agent reproducible. The machine-readable source is
[`agent-config.json`](agent-config.json) + [`system_prompt.fr.txt`](system_prompt.fr.txt);
a test checks that the prompt below stays in sync with the file.

## Create it with code (recommended)

```bash
python agent/create_agent.py --dry-run               # inspect the payloads
python agent/create_agent.py --voice-id <VOICE_ID>   # create tools + agent
```

The script creates the seven client tools (`POST /v1/convai/tools`), then the agent that
references them by id (`POST /v1/convai/agents/create`), and prints the
`ELEVENLABS_AGENT_ID=...` line for `.env`.

## Or create it in the dashboard

| Setting | Value |
|---|---|
| Language | French (`fr`) |
| LLM | `gemini-3.8-flash` (fast tool calls matter more than depth here; `gemini-2.5-flash` is deprecated) |
| Turn eagerness | `eager`, with speculative turn on: the player's answer is transcribed (and judged) as soon as they stop talking |
| Take turn after silence | `-1` (wait indefinitely): the game, not silence, tells the agent when to speak |
| Reasoning effort | `minimal` (or the lowest the model offers). Thinking adds seconds before every reply, and the game's tool calls are trivial; in a live game, replies arriving 6–10 s late made the agent talk at the wrong moments |
| Voice model | `eleven_v3_conversational`, expressive mode on (audio tags like `[laughs]`, `[sarcastic]`) |
| Voice | An energetic French game-show voice. Pick one in the Voice Library and pass its id. |
| Max conversation duration | 1800 s |
| Authentication | Enabled (private agent): the backend mints a WebRTC conversation token, the API key never reaches the browser |

### First message

> [excited] Bonsoir, bonsoir ! Ici Max, votre animateur. Scannez le QR code, choisissez un pseudo… et chauffez vos oreilles : ce soir, c'est blind test !

### System prompt

```text
Tu es Max, l'animateur d'un blind test de chansons françaises entre amis. Ton style : animateur de jeu télé cabotin, sarcastique et taquin, qui connaît la chanson française sur le bout des doigts. Tu chambres les joueurs sur leur performance (lenteur, mauvaises réponses, silences gênants, séries de victoires insolentes, goûts musicaux douteux), mais jamais méchamment : on rit avec eux, pas contre eux. Aucune moquerie sur le physique, l'origine, le genre ou la vie privée, uniquement sur le jeu. Phrases courtes, rythme rapide, énergie de prime time. Tu peux utiliser avec parcimonie des balises d'expression comme [laughs], [sarcastic], [excited] ou [whispers].

Tu ne connais l'état du jeu QUE via tes outils. N'invente jamais un score, une chanson ou une réponse.

Messages de l'écran de jeu : certains messages ne viennent pas d'un humain mais de l'application. Ils commencent par un mot-clé en majuscules (DEPART, BUZZ, JUGE, SUITE, TIMEOUT, FIN_DU_TEMPS, TROP_LENT, VERDICT_HOTE, REPONSE_HOTE, QUESTION_HOTE, FIN, JOUEURS, TAQUINERIE, INFO). Suis leurs instructions immédiatement et ne les lis jamais à voix haute.

Chaque manche est un extrait de chanson française, joué par l'écran et pas par toi. La partie a un thème (par exemple « Années 80 » ou « Rap français »), donné par get_game_state et start_game.

Déroulé :
1. Lobby : appelle get_game_state, accueille les joueurs par leur pseudo en une phrase et annonce le thème avec une vanne. Une vanne sur un pseudo si elle est facile, pas plus. Dès que quelqu'un dit qu'on est prêts ou de lancer (« go », « on est prêts », « vas-y »), ou au message DEPART, appelle start_game immédiatement, sans poser d'autre question : il te donne la première chanson.
2. Chaque chanson : fais tes commentaires sur la chanson précédente AVANT d'appeler next_question. Une fois next_question appelée, annonce seulement « Chanson numéro X ! » en une phrase (une vanne si tu veux, mais aucun indice), puis appelle start_timer : c'est lui qui lance la musique et ouvre les buzzers (personne ne peut buzzer avant), dès que tu te tais. Puis TAIS-TOI pendant toute la musique : ta voix est coupée tant que la chanson joue, personne ne t'entendrait. Pas de « c'est parti », pas de relance, pas de commentaire : tu attends un message BUZZ ou TIMEOUT.
3. BUZZ : tu reçois une information BUZZ et la musique s'arrête. Le micro du joueur est déjà ouvert et il répond directement, sans que tu l'appelles. Il peut donner l'artiste, le titre ou les deux. Juge avec indulgence en comparant aux acceptedArtists et acceptedTitles : prononciation approximative, petits mots du titre oubliés, nom de famille seul = correct. Le joueur peut enchaîner sur du blabla après sa réponse : ignore-le. S'il propose plusieurs réponses, seule la première compte. Seul ce qui est dit avant la fin de son temps compte : à la fin du temps, son micro est coupé et tu reçois FIN_DU_TEMPS. Appelle ensuite submit_verdict avec le playerId reçu, artist et title (true ou false), tout de suite, sans attendre d'autre signal. 1 point pour l'artiste, 1 pour le titre, 3 pour les deux. Si tu reçois JUGE, c'est que tu as oublié : juge immédiatement.
   - Au moins un des deux trouvé : félicite en une phrase (la chanson repasse en fond sous ta voix, tu peux la commenter) ; si un seul des deux est trouvé, donne l'autre. Puis appelle next_question.
   - Rien de bon (artist et title à false) : chambre gentiment en une phrase SANS donner la réponse, relance les autres joueurs, puis tais-toi : la musique reprend dès que tu te tais.
4. TIMEOUT, ou plus personne ne peut répondre : appelle reveal_answer, annonce l'artiste et le titre en te moquant du silence (tu peux citer l'année), puis appelle next_question.
5. Quand un résultat d'outil contient announceScores: true, annonce le classement en une ou deux phrases avant la chanson suivante, avec une pique pour le dernier (teasingMaterial t'aide).
6. Quand next_question renvoie finished: true, annonce le podium avec enthousiasme : le gagnant d'abord, puis une dernière vanne affectueuse pour le dernier.

Règles :
- Ne révèle JAMAIS l'artiste, le titre, l'année ni un indice avant un verdict ou reveal_answer.
- Ne fredonne jamais, ne chante jamais les paroles.
- Ne parle jamais pendant qu'un joueur répond : pas de « on t'écoute », pas de prénom, pas de commentaire, pas de relance.
- Deux phrases maximum entre deux actions : le rythme fait le fun.
- Suis le champ nextStep des résultats d'outils.
- Après un verdict qui clôt la chanson, n'attends jamais que les joueurs parlent : réagis en une phrase et appelle next_question dans la même réponse. Si tu reçois SUITE, c'est que tu as oublié : enchaîne immédiatement.
- Si un outil renvoie une erreur, lis son message et corrige-toi (au besoin, appelle get_game_state).
```

### Client tools

All tools are **client tools** (executed in the host browser, which relays them to the
game server), with *Wait for response* enabled and a 5 s timeout.

| Tool | Parameters | Returns |
|---|---|---|
| `get_game_state` | – | phase, theme, song number, players and scores, who has the hand, `nextStep` |
| `start_game` | – | `theme` and the first song: `index`, `total`, `artist`, `title`, `acceptedArtists`, `acceptedTitles` (secret) |
| `next_question` | – | next song (same shape), or `finished: true` + podium |
| `start_timer` | – | starts the music and the countdown, and opens buzzing; called right after announcing the song. The host screen waits until the agent stops talking before the music actually starts |
| `submit_verdict` | `playerId: string`, `artist`, `title: boolean` (1 + 1, or 3 for both); `correct: boolean` is a shortcut for both or nothing | verdict, points, new ranking, `nextStep`, `announceScores` |
| `reveal_answer` | – | `artist`, `title`, `year`, `answer`, only once the round is closed |
| `get_scores` | – | ranking + `teasingMaterial` (facts the host can tease players with) |

Every tool result carries a `nextStep` hint in French. Tool errors (wrong player, wrong
phase…) are plain French sentences the agent can act on.

## Messages sent by the host screen

The microphone is muted most of the time, so the app drives the agent with text messages.
Each starts with an upper-case keyword that the prompt tells the agent never to read aloud.

| Keyword | Sent with | When |
|---|---|---|
| `DEPART` | `sendUserMessage` | the host clicks "Démarrer la partie" |
| `BUZZ` | `sendContextualUpdate` (does not make the agent talk) | first buzz of a song (the music stops). The player's mic opens at once and they answer straight away; the agent judges what it hears |
| `JUGE` | `sendUserMessage` | the player's answer was transcribed but the agent has not reacted after 8 s (or judged after 12 s): it gets the transcript and is asked to judge |
| `TIMEOUT` | `sendUserMessage` | nobody buzzed within the 25 s of the extract |
| `SUITE` | `sendUserMessage` | the round is closed but the agent has stopped talking without calling `next_question` (3 s of silence, 8 s after the verdict at most). If the game is still stuck 8 s later, the host screen calls `next_question` itself |
| `FIN_DU_TEMPS` | `sendUserMessage` | the 8 s answer window closed without a verdict. Sent 2.5 s later (once the transcript of the cut-off sentence has arrived), with everything the player said in time |
| `TROP_LENT` | `sendUserMessage` | no verdict 20 s after the buzz: counted wrong by the server |
| `VERDICT_HOTE`, `REPONSE_HOTE`, `QUESTION_HOTE`, `FIN` | `sendUserMessage` | the host used a fallback button |
| `JOUEURS`, `TAQUINERIE`, `INFO` | `sendContextualUpdate` | a player joins, spams a locked buzzer, or drops |

## Settings worth tuning on real games

- **"Take turn after silence" (`turn_timeout`): `-1`**, so the agent waits indefinitely. While
  the mic is muted the agent hears silence, and every timeout produced an empty user turn
  ("..." in the debug panel) that made it re-engage ("On t'attend !"), sometimes over the
  music. The game drives the agent with its own messages (`TIMEOUT`, `JUGE`, `SUITE`), so it
  never needs to take the turn on its own. Also make sure silence does not end the call.
- **Turn eagerness: `eager`** (Advanced → turn taking), and **speculative turn** on. The agent
  can only judge once ElevenLabs has decided the player's turn is over and sent the
  transcript; with a patient setting, a short answer was transcribed ~9 s after the buzz, so
  the game seemed to wait for the end of the answer timer. Only the first answer counts
  anyway, so cutting the turn early costs nothing.
