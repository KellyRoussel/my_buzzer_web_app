"""Quiz Host app: pages, REST API and WebSockets.

    uvicorn app.main:app --reload

Rooms live in memory: run a single worker.
"""
import logging

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.routes import PAGES_DIR, router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")

app = FastAPI(title="Quiz Host")
app.include_router(router)
app.mount("/static", StaticFiles(directory=PAGES_DIR), name="static")


@app.get("/health", include_in_schema=False)
def health():
    return {"status": "ok"}
