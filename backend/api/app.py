from fastapi import FastAPI

from backend.api.approval import router as approval_router
from backend.api.audit import router as audit_router

app = FastAPI(title="EraseOps API")
app.include_router(approval_router)
app.include_router(audit_router)


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}
