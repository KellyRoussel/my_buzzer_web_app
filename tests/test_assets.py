"""Checks on the question bank and the agent configuration files."""
import json
import re
from pathlib import Path

from app.questions import load_questions

ROOT = Path(__file__).resolve().parents[1]
AGENT_DIR = ROOT / "agent"


def test_question_bank_is_large_and_well_formed():
    questions = load_questions()
    assert len(questions) >= 20
    assert len({q.question for q in questions}) == len(questions)
    for q in questions:
        assert q.question.endswith("?"), q.id
        assert q.acceptedAnswers, q.id
        assert all(a == a.lower() for a in q.acceptedAnswers), q.id


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
