"""Runtime configuration.

Every secret here is server-side only. Nothing in this module may ever be
serialised into a response: the Drive refresh token reaches Drive, the stream
signing key never leaves the process, and the client sees neither.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

MIN_SIGNING_KEY_CHARS = 32
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    """Resolved from the environment, falling back to api/.env.

    The env file path is absolute on purpose. Relative to the working
    directory it loads when uvicorn is started from `api/` and silently
    resolves to nothing from anywhere else, which reads as "no config" rather
    than as an error.
    """

    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore")

    google_client_id: str = ""
    google_client_secret: str = ""
    drive_refresh_token: str = ""

    stream_jwt_secret: str = ""
    stream_token_ttl_s: int = 3600

    anthropic_api_key: str = ""
    youtube_api_key: str = ""

    study_timezone: str = "Europe/Zurich"
    daily_new_cap: int = 30
    daily_review_cap: int = 60

    firebase_project_id: str = "ig-study"
    allowed_origins: str = (
        "https://ig-study.web.app,https://ig-study.firebaseapp.com,http://localhost:5173"
    )

    @property
    def cors_origins(self) -> list[str]:
        """Exact origins allowed to call the JSON API.

        The video element never triggers a preflight, so this list only gates
        fetch() traffic. It is a list of exact origins rather than a wildcard
        because the service runs --allow-unauthenticated.
        """
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]

    def missing(self) -> list[str]:
        """Names of required settings that are absent or too weak to use.

        The length floor on the signing key is the RFC 7518 minimum for
        HMAC-SHA256. A short key here would weaken the only thing guarding the
        video bytes, and it would fail quietly -- PyJWT warns and signs anyway.
        """
        required = {
            "GOOGLE_CLIENT_ID": self.google_client_id,
            "GOOGLE_CLIENT_SECRET": self.google_client_secret,
            "DRIVE_REFRESH_TOKEN": self.drive_refresh_token,
            "STREAM_JWT_SECRET": self.stream_jwt_secret,
        }
        problems = [name for name, value in required.items() if not value]
        if self.stream_jwt_secret and len(self.stream_jwt_secret) < MIN_SIGNING_KEY_CHARS:
            problems.append(f"STREAM_JWT_SECRET (under {MIN_SIGNING_KEY_CHARS} chars)")
        return problems


@lru_cache
def settings() -> Settings:
    return Settings()
