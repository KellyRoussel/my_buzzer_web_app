from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    elevenlabs_api_key: str = ""  # server-side only, used to mint conversation tokens
    elevenlabs_agent_id: str = ""  # ElevenLabs Agents agent id
    public_base_url: str = ""  # public URL encoded in the join QR code (e.g. a tunnel URL)


settings = Settings()
