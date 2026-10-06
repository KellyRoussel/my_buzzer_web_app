"""Server-side helpers for ElevenLabs Agents. The API key never leaves the server."""
import httpx

ELEVENLABS_API_URL = "https://api.elevenlabs.io"


class ElevenLabsError(Exception):
    pass


async def get_conversation_token(api_key: str, agent_id: str) -> str:
    """Mints a short-lived WebRTC conversation token for a private agent."""
    async with httpx.AsyncClient(base_url=ELEVENLABS_API_URL, timeout=10) as client:
        response = await client.get(
            "/v1/convai/conversation/token",
            params={"agent_id": agent_id},
            headers={"xi-api-key": api_key},
        )
    if response.status_code != 200:
        raise ElevenLabsError(f"ElevenLabs returned {response.status_code}: {response.text[:200]}")
    token = response.json().get("token")
    if not token:
        raise ElevenLabsError("ElevenLabs response did not contain a token")
    return token
