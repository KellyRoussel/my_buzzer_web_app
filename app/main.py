"""Blind Test app: pages, REST API and WebSockets.

    uvicorn app.main:app --reload

Rooms live in memory: run a single worker.
"""
import logging

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.routes import NO_CACHE, PAGES_DIR, router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")



class RevalidatedStaticFiles(StaticFiles):
    """Static files the browser must revalidate on every load.

    The pages are ES modules importing each other: without this, a browser can reuse a stale
    common.js next to a fresh host.js after an update. Revalidation is cheap (ETag -> 304).
    """

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers.update(NO_CACHE)
        return response


app = FastAPI(title="Blind Test")
app.include_router(router)
app.mount("/static", RevalidatedStaticFiles(directory=PAGES_DIR), name="static")


@app.get("/health", include_in_schema=False)
def health():
    return {"status": "ok"}
