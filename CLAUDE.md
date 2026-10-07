# CLAUDE.md

Quiz Host: a party quiz where an ElevenLabs Agents voice host reads the questions and players buzz from their phones' browsers. See `README.md` for the design and `DX_NOTES.md` for SDK notes.

## Commands

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload      # http://localhost:8000
python -m pytest                   # tests
python agent/create_agent.py --dry-run
```

## Conventions

- Code, comments and docs in English; everything players or the agent read (UI, prompts, tool results, game errors) in French.
- The server is the source of truth. `app/game.py` is a pure, synchronous state machine: time is passed in, methods return events. Keep I/O out of it.
- `app/room.py` owns sockets and timers. Rooms live in memory: run a single worker.
- Front: vanilla ES modules in `static/`, no build step. The ElevenLabs SDK is loaded from a pinned jsDelivr URL in `static/agent.js`.
- Agent config lives in `agent/agent-config.json` + `agent/system_prompt.fr.txt`; `agent/agent-config.md` embeds the prompt verbatim (a test checks it). Tool names must match the `tools` map in `static/host.js` (also tested).
- The ElevenLabs API key never reaches the browser; host-only endpoints require the room's host key.
