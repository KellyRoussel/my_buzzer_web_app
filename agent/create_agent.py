"""Creates the Blind Test agent on ElevenLabs from agent-config.json.

Usage (from the repository root):
    python agent/create_agent.py --voice-id <VOICE_ID>
    python agent/create_agent.py --dry-run      # print the payloads only

Reads ELEVENLABS_API_KEY from the environment (or .env). Creates the seven client
tools first (POST /v1/convai/tools), then the agent referencing them by id
(POST /v1/convai/agents/create), and prints the ELEVENLABS_AGENT_ID line to
paste into .env.
"""
import argparse
import json
import os
import sys
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))  # repository root, for app.config

API_URL = "https://api.elevenlabs.io"
EMPTY_PARAMETERS = {"type": "object", "properties": {}, "required": []}


def load_config() -> dict:
    config = json.loads((HERE / "agent-config.json").read_text(encoding="utf-8"))
    config["prompt"] = (HERE / config.pop("prompt_file")).read_text(encoding="utf-8").strip()
    return config


def tool_payload(tool: dict) -> dict:
    return {"tool_config": {**tool, "parameters": tool.get("parameters", EMPTY_PARAMETERS)}}


def agent_payload(config: dict, tool_ids: list[str], voice_id: str | None) -> dict:
    tts = dict(config["tts"])
    if voice_id:
        tts["voice_id"] = voice_id
    payload = {
        "name": config["name"],
        "conversation_config": {
            "agent": {
                "first_message": config["first_message"],
                "language": config["language"],
                "prompt": {
                    "prompt": config["prompt"],
                    "llm": config["llm"],
                    **({"reasoning_effort": config["reasoning_effort"]} if config.get("reasoning_effort") else {}),
                    "tool_ids": tool_ids,
                },
            },
            "tts": tts,
            **({"turn": config["turn"]} if config.get("turn") else {}),
            "conversation": {"max_duration_seconds": config["max_duration_seconds"]},
        },
    }
    if config.get("private"):
        # Private agent: the browser needs a conversation token minted by the backend.
        payload["platform_settings"] = {"auth": {"enable_auth": True}}
    return payload


def post(client: httpx.Client, path: str, payload: dict) -> dict:
    response = client.post(path, json=payload)
    if response.status_code >= 400:
        sys.exit(f"POST {path} failed ({response.status_code}): {response.text}")
    return response.json()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--voice-id", help="ElevenLabs voice id (an energetic French host voice)")
    parser.add_argument("--dry-run", action="store_true", help="print the payloads without calling the API")
    args = parser.parse_args()

    config = load_config()
    if args.dry_run:
        for tool in config["tools"]:
            print(json.dumps(tool_payload(tool), ensure_ascii=False, indent=2))
        ids = [f"<{tool['name']}_id>" for tool in config["tools"]]
        print(json.dumps(agent_payload(config, ids, args.voice_id), ensure_ascii=False, indent=2))
        return

    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        from app.config import settings
        api_key = settings.elevenlabs_api_key
    if not api_key:
        sys.exit("ELEVENLABS_API_KEY is not set")

    with httpx.Client(base_url=API_URL, headers={"xi-api-key": api_key}, timeout=30) as client:
        tool_ids = []
        for tool in config["tools"]:
            created = post(client, "/v1/convai/tools", tool_payload(tool))
            tool_ids.append(created["id"])
            print(f"tool {tool['name']}: {created['id']}")
        agent = post(client, "/v1/convai/agents/create", agent_payload(config, tool_ids, args.voice_id))

    print("\nAgent created. Add this line to your .env:")
    print(f"ELEVENLABS_AGENT_ID={agent['agent_id']}")


if __name__ == "__main__":
    main()
