# Developer notes: ElevenLabs Agents SDK

An honest log of building Quiz Host on ElevenLabs Agents: what was easy, where it hurt,
and what I would change. I updated it during development.

**Versions:** `@elevenlabs/client` 1.26.0 (browser) and the `elevenlabs` Python SDK 2.71.0,
whose types I used to build the agent-creation payload.

**How I worked:** the documentation site was not reachable from my sandboxed dev
environment, so I worked from the published packages themselves: the npm README, the
`.d.ts` files and the compiled `dist/`, plus the Python SDK's generated types. That turned
out to be a useful test in itself: how far can you get with only what ships in the
package? Everything that depends on a live voice session is listed at the end under
**To verify live**. Those points stay open until they are measured on a real game.

## What was simple

- **One call to start.** `Conversation.startSession({ conversationToken, connectionType: "webrtc", clientTools, ...callbacks })`
  is the whole integration surface. The session config is a discriminated union
  (`PublicSessionConfig | PrivateWebRTCSessionConfig | PrivateWebSocketSessionConfig`, with
  `never` on the forbidden fields), so mixing `agentId` with `conversationToken`, or a
  signed URL with WebRTC, fails at compile time. Good API design.
- **Client tools are plain async functions.** `clientTools: { submit_verdict: async ({ playerId, correct }) => ... }`.
  A thrown error is sent back to the agent as `is_error: true` with the message. That made
  self-correction easy: the game server's French error messages ("Ce n'est pas ce joueur
  qui a la main. C'est Léa.") go straight to the LLM.
- **The primitives a room-mic app needs exist.** `setMicMuted`, `sendUserMessage`,
  `sendContextualUpdate`, `setVolume`, and `onModeChange` (speaking / listening). That last
  one gave me a free "the agent finished reading the question" signal to start the buzz
  countdown.
- **No bundler required.** The package ships an IIFE build (`dist/lib.iife.js`, global
  `ElevenLabsClient`), so a vanilla-JS page can load a pinned version from a CDN.
- **Private agents are easy to secure.** One server-side `GET /v1/convai/conversation/token?agent_id=…`
  with `xi-api-key`, and the browser only ever sees a short-lived token.

## Friction points

1. **Tool return type vs runtime.** `ClientToolsConfig` types tool results as
   `string | number | void`, but `handleClientToolCall` runs `JSON.stringify` on objects
   anyway. Returning an object, the natural thing for game state, works at runtime but is a
   type error, so TypeScript users end up stringifying by hand. *Suggestion:* type the result
   as any JSON-serialisable value and document the serialisation.
2. **Silent default tool result.** A tool that returns `undefined` reports
   `"Client tool execution successful."` to the agent. That is sensible, but it is only
   visible in the compiled code. *Suggestion:* document it next to `clientTools`.
3. **Two sources of truth for tools.** A client tool must be declared on the agent (in the
   dashboard or the API) *and* implemented in `clientTools`, and nothing checks that they
   match. A typo shows up only when the LLM calls the tool mid-conversation. I added a test
   that compares `agent-config.json` with the host page's tool map. *Suggestion:* on
   connect, warn in the console about tools declared on the agent but missing on the
   client.
4. **No JSDoc on the key methods.** `sendContextualUpdate` and `sendUserMessage` have no
   doc comments in the `.d.ts`. Their names suggest "silent context" vs "triggers a turn",
   but whether `sendUserMessage` **interrupts** an agent that is currently speaking is not
   stated. A quiz needs exactly that: someone buzzes mid-question. I added a client-side
   workaround that ducks the agent's volume to 0 until its next turn starts.
   *Suggestion:* an explicit `conversation.interrupt()`, plus one sentence on each
   method's interruption semantics.
5. **Muted mic and turn-taking.** The app keeps the mic muted for up to 20 s while players
   think. `TurnConfig.turn_timeout` ("Maximum wait time for the user's reply before
   re-engaging the user") and `silence_end_call_timeout` document neither units, ranges
   nor how to disable them, so I could not tell from the types whether a long muted
   silence makes the agent re-engage or end the call. *Suggestion:* a documented
   "push-to-talk / app-driven turns" recipe, since it is a common pattern for kiosks, games
   and noisy rooms.
6. **Similar token models.** The Python SDK has both `TokenResponseModel { token, conversation_id }`
   (what `GET /v1/convai/conversation/token` returns, and what the JS SDK reads as
   `data.token`) and `ConversationTokenResponseModel { agent_id, conversation_token }`.
   When you write the token endpoint by hand, it is easy to pick the wrong field.
7. **Naming drift.** The same product appears as `convai` (API paths), `conversational_ai`
   (Python SDK), "Agents Platform" and "ElevenAgents" (npm README). It is fine once you
   know, but it slows down searching for answers.
8. **Creating an agent by code is now two steps.** `prompt.tools` is marked "use tool_ids
   instead", so you first create each tool (`POST /v1/convai/tools`), then the agent with
   the ids. It is clean for reuse but heavier for a quickstart. `agent/create_agent.py`
   wraps it.
9. **Silent model-dependent flags.** `expressive_mode` is "automatically disabled for non-v3
   models". It would be friendlier if the API returned a warning when the flag is set on a
   model that ignores it.

10. **No deprecation signal in the SDK.** `gemini-2.5-flash` turned out to be deprecated on
    the platform, but the Python SDK's `Llm` type lists it next to its successors with no
    marker, so the creation script happily used it. *Suggestion:* flag deprecated models in
    the generated types or return a warning from the agent-creation API.

## Observed in the first live game

1. **The agent talked over the player.** After a buzz, the agent said "Kelly, on t'écoute !"
   while the mic was already open, so the player answered over the agent and the
   transcription was garbled. In a voice app with external turn triggers, *when* to open
   the mic is the app's job. First fix: the agent only says the name, and the host screen
   opens the mic on the agent's next speaking → listening transition. Players found waiting
   for their name too slow, so the final design keeps the agent out of the loop: the mic
   opens on the buzz and the agent is told with `sendContextualUpdate` (which does not trigger
   a reply).
3. **A silent agent stalls the game.** The first version of that told the agent "ne dis RIEN"
   at the buzz and muted its voice until the player's transcript arrived. In the live game,
   the player answered and nothing happened: the agent never judged. Either instruction can
   cause it (an LLM told to stay silent may stay silent on the next turn too), and nothing in
   the SDK says whether a user turn after a contextual update is guaranteed to get a reply.
   The fix: no "say nothing" wording, no muting; the host closes the mic as soon as the
   answer is transcribed and, if the agent has not reacted 2.5 s later, sends the transcript
   with an explicit "judge now" message. *Suggestion:* document how contextual updates and
   the following user turn interact.
2. **`onModeChange` is not "the agent finished reading".** The agent often comments on the
   previous answer, calls `next_question`, then reads the question, sometimes as separate
   turns with a listening gap in between. Using the first speaking → listening transition
   started the buzz countdown before the question was even heard. First fix: watch the
   agent's text (`onMessage`, role `agent`) for the question, then wait for the end of that
   turn. Final design: the agent starts the countdown itself with a `start_timer` tool. But a
   client tool runs when the LLM *emits* the call, while the TTS audio of the question is
   often still playing, so the host defers the real start until `onModeChange` reports
   `listening`. The transcript matching stays as a fallback when the agent forgets the tool. *Suggestion:* expose turn boundaries tied to tool calls (for example "the turn that
   follows this tool result has finished playing"), so apps don't have to match transcripts.

4. **`setMicMuted(true)` stops the audio stream in WebRTC.** It calls LiveKit's
   `track.mute()`, which stops sending packets instead of sending silence. Muting a player
   mid-sentence therefore hid the end of their turn from the server: the transcript of
   "C'est Dalida, « Laissez-moi danser »" arrived 9 s after the mute, after the game had moved
   on. The fix: keep the mic open 1.5 s after the deadline. *Suggestion:* document this, or
   offer a "mute but keep the turn detection fed with silence" mode.
5. **Latency decides the game feel.** In the same game, the agent replied 6 to 10 s after a
   message, so its reactions landed during the next player's answer. Thinking is likely the
   main cost: `reasoning_effort` is now `minimal` in the config. The app also mutes any agent
   speech while a player is answering, and gives the agent 15 s to judge once the answer is
   in. *Suggestion:* surface per-turn latency (ASR, LLM, TTS) in the conversation metadata,
   so developers can see where the seconds go.
6. **Tool calls run before the audio they come with.** The agent generated "Chanson numéro
   un !" and the `start_timer` call together; the call ran at once and the audio started
   2.3 s later. Waiting for `listening` was not enough, since the agent was not speaking yet:
   the host now waits up to 3 s for the speech to start, then for it to end.

7. **The app cannot end a user turn.** Once the answer is out, the game wants it judged
   right away, but the transcript (and so the agent's reply) only comes when the server
   decides the turn is over. With a patient turn setting, a short answer was transcribed
   ~9 s after the buzz. Muting the mic does not help in WebRTC (see 4). The knobs are
   `turn_eagerness: eager` and `speculative_turn`. *Suggestion:* a client event such as
   `conversation.endUserTurn()` for apps that know when the user is done (push-to-talk,
   buzzers, kiosks).

## To verify live

Measured on real games with the debug panel (`D` on the host screen, which logs WebSocket
events and tool calls with timestamps).

| Question | Result |
|---|---|
| `sendContextualUpdate("BUZZ: …")` then the player's speech: does the agent use the BUZZ context (right `playerId`) when it judges? | _to measure_ |
| Does the agent stay silent after a contextual update (the voice is muted anyway until the answer)? | _to measure_ |
| With the mic muted for 20 s, does the agent re-engage or end the call? | _to measure_ |
| Are `[sarcastic]` / `[laughs]` tags rendered in French with `eleven_v3_conversational`? | _to measure_ |
| Does `create_agent.py` work against the live API as written? | _to run_ |
