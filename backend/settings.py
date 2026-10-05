from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://eraseops:eraseops_local_only@localhost:5432/eraseops"

    model_config = SettingsConfigDict(env_file=".env", env_prefix="ERASEOPS_", extra="ignore")


settings = Settings()
