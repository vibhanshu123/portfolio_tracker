"""
Proxy endpoints for stockscans.in Top Ideas data.
- Session cookie stored in data.json["settings"]["stockscans_cookie"]
- Company cache stored in data.json["settings"]["stockscans_cache"]
  {companies: [...], fetched_at: ISO-string, include_popular: bool}
- GET /api/top-ideas/data  → returns cache (no external call)
- POST /api/top-ideas/refresh → hits stockscans.in, updates cache
"""
import httpx
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Request

from core.persistence import load, save

router = APIRouter()

_BASE = "https://www.stockscans.in"
_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Origin": _BASE,
    "Referer": _BASE + "/scan-match",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
}


def _stored_cookie() -> str:
    return load()["settings"].get("stockscans_cookie", "")


@router.get("/api/top-ideas/status")
def top_ideas_status():
    data = load()
    cookie = data["settings"].get("stockscans_cookie", "")
    cache  = data["settings"].get("stockscans_cache", {})
    return {
        "logged_in":    bool(cookie),
        "fetched_at":   cache.get("fetched_at"),
        "has_cache":    bool(cache.get("companies")),
        "include_popular": cache.get("include_popular", True),
    }


@router.post("/api/top-ideas/login")
async def top_ideas_login(request: Request):
    body = await request.json()
    email    = body.get("email", "").strip()
    password = body.get("password", "")
    if not email or not password:
        raise HTTPException(400, "email and password required")

    async with httpx.AsyncClient(follow_redirects=True) as client:
        resp = await client.post(
            f"{_BASE}/api/user/login",
            json={"email": email, "password": password},
            headers=_HEADERS,
            timeout=15,
        )

    if resp.status_code == 400:
        detail = resp.json().get("message", "Invalid credentials")
        raise HTTPException(400, detail)
    if resp.status_code == 429:
        raise HTTPException(429, "Too many login attempts — stockscans.in has rate-limited you. Wait a few minutes and try again.")
    if resp.status_code not in (200, 201):
        raise HTTPException(resp.status_code, f"Login failed (stockscans.in returned {resp.status_code})")

    # httpx cookies are plain (name, value_str) pairs — no .value attribute
    cookie_parts = [f"{name}={value}" for name, value in resp.cookies.items()]

    # Also pull from raw Set-Cookie headers in case httpx doesn't parse all of them
    for raw in resp.headers.get_list("set-cookie"):
        # Each Set-Cookie header: "name=value; Path=/; HttpOnly; ..."
        pair = raw.split(";")[0].strip()
        if "=" in pair and pair not in cookie_parts:
            cookie_parts.append(pair)

    cookie_str = "; ".join(cookie_parts)
    if not cookie_str:
        raise HTTPException(500, "No cookie returned from stockscans.in — login may have succeeded but auth cannot be stored")

    data = load()
    data["settings"]["stockscans_cookie"] = cookie_str
    save(data)
    return {"ok": True}


@router.post("/api/top-ideas/logout")
def top_ideas_logout():
    data = load()
    data["settings"].pop("stockscans_cookie", None)
    # keep the cache so data is still visible after logout
    save(data)
    return {"ok": True}


@router.get("/api/top-ideas/data")
def top_ideas_data():
    """Return the cached company list — no external call."""
    data  = load()
    cache = data["settings"].get("stockscans_cache", {})
    return {
        "companies":       cache.get("companies", []),
        "fetched_at":      cache.get("fetched_at"),
        "include_popular": cache.get("include_popular", True),
        "has_cache":       bool(cache.get("companies")),
    }


@router.post("/api/top-ideas/refresh")
async def top_ideas_refresh(request: Request):
    """Hit stockscans.in, update the cache, return fresh data."""
    body           = await request.json()
    include_popular = bool(body.get("includePopular", True))

    cookie = _stored_cookie()
    if not cookie:
        raise HTTPException(401, "Not logged in — please log in first")

    async with httpx.AsyncClient(follow_redirects=True) as client:
        resp = await client.post(
            f"{_BASE}/api/user/saved-scans/common-stocks",
            json={"includePopular": include_popular},
            headers={**_HEADERS, "Cookie": cookie},
            timeout=20,
        )

    if resp.status_code == 401:
        data = load()
        data["settings"].pop("stockscans_cookie", None)
        save(data)
        raise HTTPException(401, "Session expired — please log in again")
    if resp.status_code == 402:
        raise HTTPException(402, "Subscription required")
    if resp.status_code == 429:
        raise HTTPException(429, "Rate-limited by stockscans.in — please wait a few minutes before refreshing")
    if resp.status_code != 200:
        raise HTTPException(resp.status_code, f"Failed to fetch from stockscans.in ({resp.status_code})")

    companies  = resp.json().get("companies", [])
    fetched_at = datetime.now(timezone.utc).isoformat()

    data = load()
    data["settings"]["stockscans_cache"] = {
        "companies":       companies,
        "fetched_at":      fetched_at,
        "include_popular": include_popular,
    }
    save(data)
    return {"companies": companies, "fetched_at": fetched_at, "ok": True}
