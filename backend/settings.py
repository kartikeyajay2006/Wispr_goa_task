from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://user:password@localhost:5432/eraseops"

    model_config = SettingsConfigDict(env_file=".env", env_prefix="ERASEOPS_", extra="ignore")


settings = Settings()
