"""Checks on the agent configuration files."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AGENT_DIR = ROOT / "agent"


def test_agent_markdown_embeds_the_current_prompt():
    prompt = (AGENT_DIR / "system_prompt.fr.txt").read_text(encoding="utf-8").strip()
    assert prompt in (AGENT_DIR / "agent-config.md").read_text(encoding="utf-8")


def test_agent_tools_match_the_host_screen_tools():
    config = json.loads((AGENT_DIR / "agent-config.json").read_text(encoding="utf-8"))
    configured = {tool["name"] for tool in config["tools"]}
    host_js = (ROOT / "static" / "host.js").read_text(encoding="utf-8")
    tools_block = host_js.split("tools: {", 1)[1].split("},\n  onStatus", 1)[0]
    implemented = set(re.findall(r"^\s+(\w+): ", tools_block, flags=re.M))
    assert configured == implemented


def test_host_relays_every_submit_verdict_parameter():
    """The host screen must pass on every parameter the agent's tool declares."""
    config = json.loads((AGENT_DIR / "agent-config.json").read_text(encoding="utf-8"))
    verdict = next(tool for tool in config["tools"] if tool["name"] == "submit_verdict")
    host_js = (ROOT / "static" / "host.js").read_text(encoding="utf-8")
    relay = host_js.split("submit_verdict: (", 1)[1].split("}),", 1)[0]
    for name in verdict["parameters"]["properties"]:
        assert relay.count(name) >= 2, f"{name} is not relayed to the game server"
