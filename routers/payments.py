import hashlib
import hmac
import os
import time
import uuid

from fastapi import APIRouter, HTTPException, Request

router = APIRouter()

# In-memory unlock tokens  {token: {tickers, paid_count, created_at, order_id}}
_unlock_tokens: dict = {}

COST_PER_STOCK_INR = 30   # ₹30/stock — passes through API cost, zero markup
FREE_STOCKS        = 1    # first stock always free
TOKEN_TTL_SECONDS  = 3600 # tokens expire after 1 hour


def _razorpay_client():
    import razorpay
    key_id     = os.getenv("RAZORPAY_KEY_ID", "")
    key_secret = os.getenv("RAZORPAY_KEY_SECRET", "")
    if not key_id or not key_secret:
        raise HTTPException(status_code=503, detail="Razorpay not configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env")
    return razorpay.Client(auth=(key_id, key_secret))


@router.post("/api/payments/create-order")
async def create_order(request: Request):
    body    = await request.json()
    tickers = [t.strip().upper() for t in body.get("tickers", []) if t.strip()]
    if not tickers:
        raise HTTPException(400, "No tickers provided")

    paid_count  = max(0, len(tickers) - FREE_STOCKS)
    amount_inr  = paid_count * COST_PER_STOCK_INR
    amount_paise = amount_inr * 100

    if amount_paise == 0:
        raise HTTPException(400, "Nothing to pay — use the free scoring endpoint")

    client = _razorpay_client()
    try:
        order = client.order.create({
            "amount":   amount_paise,
            "currency": "INR",
            "notes":    {"tickers": ",".join(tickers), "paid_count": str(paid_count)},
        })
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Razorpay error: {e}")
    return {
        "order_id":    order["id"],
        "amount_inr":  amount_inr,
        "amount_paise": amount_paise,
        "currency":    "INR",
        "paid_count":  paid_count,
        "free_count":  FREE_STOCKS,
        "key_id":      os.getenv("RAZORPAY_KEY_ID", ""),
    }


@router.post("/api/payments/verify")
async def verify_payment(request: Request):
    body = await request.json()
    order_id   = body.get("razorpay_order_id", "")
    payment_id = body.get("razorpay_payment_id", "")
    signature  = body.get("razorpay_signature", "")
    tickers    = [t.strip().upper() for t in body.get("tickers", []) if t.strip()]

    key_secret = os.getenv("RAZORPAY_KEY_SECRET", "")
    expected   = hmac.new(
        key_secret.encode(),
        f"{order_id}|{payment_id}".encode(),
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(expected, signature):
        raise HTTPException(400, "Payment verification failed — signature mismatch")

    token = str(uuid.uuid4())
    _unlock_tokens[token] = {
        "tickers":    tickers,
        "paid_count": max(0, len(tickers) - FREE_STOCKS),
        "order_id":   order_id,
        "payment_id": payment_id,
        "created_at": time.time(),
    }
    return {"unlock_token": token, "tickers": tickers}


def validate_unlock_token(token: str, tickers: list[str]) -> bool:
    """Returns True if token is valid for these tickers."""
    t = _unlock_tokens.get(token)
    if not t:
        return False
    if time.time() - t["created_at"] > TOKEN_TTL_SECONDS:
        _unlock_tokens.pop(token, None)
        return False
    # tickers must match exactly
    return sorted(t["tickers"]) == sorted(tickers)


@router.get("/api/payments/config")
async def payment_config():
    """Frontend uses this to get public config."""
    return {
        "cost_per_stock_inr": COST_PER_STOCK_INR,
        "free_stocks":        FREE_STOCKS,
        "razorpay_enabled":   bool(os.getenv("RAZORPAY_KEY_ID")),
    }
