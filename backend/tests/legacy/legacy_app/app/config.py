# ruff: noqa
# VERBATIM copy of backend/app/config.py at git commit 63d4171955b2c6b2a0e5349f7da9e656334cf874 (the legacy, pre-multi-event application).
# Frozen test fixture: DO NOT EDIT, DO NOT IMPORT. tests/legacy/builder.py runs it in a subprocess to
# reproduce the exact production schema. See tests/legacy/README.md.
"""
Application configuration using Pydantic Settings
"""
from pydantic_settings import BaseSettings
from pydantic import field_validator
from typing import List, Union


class Settings(BaseSettings):
    """
    Application settings loaded from environment variables
    """
    # API Configuration
    BASE_PATH: str = ""  # e.g., "/event-name/quiz" or empty for root
    
    # Database
    DATABASE_URL: str = "postgresql://quiz_user:quiz_password@db:5432/gravitee_quiz"
    
    # Security
    SECRET_KEY: str = "your-secret-key-change-in-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24  # 24 hours
    
    # Admin credentials
    ADMIN_USERNAME: str = "admin"
    ADMIN_PASSWORD: str = "admin"
    
    # CORS
    CORS_ORIGINS: Union[str, List[str]] = [
        "http://localhost:8080",
        "http://localhost:8081",
        "http://localhost:8082"
    ]
    
    @field_validator('CORS_ORIGINS', mode='before')
    @classmethod
    def parse_cors_origins(cls, v):
        if isinstance(v, str):
            return [origin.strip() for origin in v.split(',')]
        return v
    
    # Game defaults
    DEFAULT_QUESTIONS_PER_GAME: int = 15
    DEFAULT_TIMER_SECONDS: int = 20
    DEFAULT_POINTS_CORRECT: int = 100
    DEFAULT_POINTS_WRONG: int = 0
    DEFAULT_TIME_BONUS_MAX: int = 50  # Maximum bonus points for fast answers
    
    class Config:
        env_file = ".env"


settings = Settings()
