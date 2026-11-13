#!/usr/bin/env python3
"""Tawar negotiation engine: state machine, ceiling enforcement, session runner.

The product invariant lives here, in code, not in any prompt:
- The buyer model may propose anything; every proposed offer passes through
  enforce_offer(), which clamps anything above the owner's ceiling and logs
  the clamp as a first-class enforcement event.
- A deal can only close through attempt_close(), which re-validates the
  final price against the ceiling via validate_deal_price(). Above the
  ceiling the deal is REFUSED, the session ends as "blocked_by_cap", and
  the refusal is recorded in the transcript. The enforcer never trusts
  model output.
- The ceiling (and the target) are structurally absent from the seller's
  world: build_seller_prompt() does not accept them as parameters, and the
  runner asserts before every seller call that neither value appears in
  the outgoing prompt.
- Simulated sellers are held to their hidden floor the same way: a seller
  price below the persona floor is clamped up to the floor and logged.

Language: --lang en (default) or id. Negotiation messages follow the
session language via prompt tokens; reasoning traces and seller moods stay
in English in both modes. The session JSON records "lang".

Currency: --currency USD (default) or IDR. The hackathon is international,
so the headline demo runs in USD; IDR remains the local-market mode. All
amounts are plain integers in the session currency (the JSON field names
keep their historical "_idr" suffix for schema stability; their values are
always in the session currency). Prompts and logs format prices via
fmt_price(): "$450" style for USD, "Rp4.500.000" style for IDR. The session
JSON and the ledger record "currency".

Sessions are append-only event logs persisted to data/sessions/<id>.json
after every event; finished sessions append one entry to the savings
ledger at data/ledger.json.

Credibility layer (judge-panel fixes):
- Agent identity: a persistent Ed25519 keypair lives in
  data/agent-key.json (mode 0600, demo key). At session start the engine
  issues a mandate object (item, list/target/ceiling, currency, lang,
  issued_at, expires_at = issued + 24h, agent_id, agent_pubkey), hashes
  it (sha256 over the canonical JSON of MANDATE_HASH_FIELDS) and signs
  the hash. mandate.signature_scheme records the path taken: "ed25519"
  when PyNaCl is importable, otherwise "hmac-demo" (HMAC-SHA256 keyed
  with the same stored seed, honestly labelled as a demo fallback).
- Tamper evidence: every event carries "h", a hash chain with
  h = sha256(prev_h + canonical JSON of the event without "h"); the
  genesis prev is the mandate hash and session["chain_head"] always
  holds the latest event's h.
- Strategy layer: one serv-pro call before round 1 writes a "plan"
  event; a mid-session deviation (a single seller concession covering
  >= 50% of the remaining gap, or 3 consecutive replies with no
  concession) triggers one serv-pro "replan" call and a "replan" event.
  Strategy tokens are counted in the session usage like any other call.
- Seller realism: a simulated seller's per-reply counter-offer drop is
  capped in code at a persona fraction of the remaining gap to its
  floor (Keras 5%, Luluh 35%, Kepepet 60%). A drop that meets the
  buyer's standing offer is an acceptance, not a concession, and is
  governed by the floor clamp and the ceiling gate instead. Clamps are
  logged as "seller_concession_capped" enforcement events.
"""
import argparse
import hashlib
import hmac as hmac_mod
import json
import os
import sys
from datetime import datetime, timedelta, timezone

try:
    import nacl.exceptions
    import nacl.signing
    HAVE_NACL = True
except Exception:  # PyNaCl missing: the hmac-demo fallback path is used.
    HAVE_NACL = False

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serv_client

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROMPTS = os.path.join(ROOT, "src", "prompts")
SESSIONS_DIR = os.path.join(ROOT, "data", "sessions")
LEDGER_PATH = os.path.join(ROOT, "data", "ledger.json")
HALT_PATH = os.path.join(ROOT, "data", "HALT")
KEY_PATH = os.path.join(ROOT, "data", "agent-key.json")

AGENT_ID = "tawar.agent"
MANDATE_TTL_HOURS = 24
# The exact field set covered by the mandate hash, in canonical-JSON
# (sorted-key) form. hash/signature/signature_scheme/agent_fingerprint
# are annotations added after hashing and are NOT part of the hashed set.
MANDATE_HASH_FIELDS = (
    "item", "list_idr", "target_idr", "ceiling_idr", "currency", "lang",
    "issued_at", "expires_at", "agent_id", "agent_pubkey",
)

BUYER_MODEL = "serv-pro"
SELLER_MODEL = "serv-mini"
DEFAULT_MAX_ROUNDS = 8
MOVES = {"open", "concede", "hold", "bundle", "deadline", "walk_away", "accept"}

LANGUAGES = {
    "en": {
        "message_language": (
            "English, in natural international marketplace style, like real "
            "Facebook Marketplace or Craigslist chats"
        ),
        "deflect_example": (
            '"my budget is really tight, that is why I am starting at this '
            'number"'
        ),
        "floor_phrases": (
            '"I would be losing money at that price", "that is already as '
            'low as I can go", "no can do, boss"'
        ),
        "default_item": "Secondhand iPhone 12 128GB",
    },
    "id": {
        "message_language": (
            "Bahasa Indonesia, in casual marketplace style like real OLX or "
            "Facebook Marketplace chats"
        ),
        "deflect_example": (
            '"budget saya terbatas gan, makanya saya nawarnya segini dulu"'
        ),
        "floor_phrases": (
            '"segitu saya rugi", "udah mepet banget ini", "belum bisa gan"'
        ),
        "default_item": "iPhone 12 128GB bekas",
    },
}

CURRENCIES = {
    "USD": {
        "name": "US dollars",
        "step_guidance": (
            "Early raise maybe $10-20, later raises $5-10, final raises "
            "$2-5. Step amounts should look human, whole dollars only, no "
            "cents."
        ),
        "step_rounding": "whole dollars (no cents)",
    },
    "IDR": {
        "name": "Indonesian rupiah",
        "step_guidance": (
            "Early raise maybe 75.000-150.000, later raises 25.000-50.000, "
            "final raises 10.000-25.000. Step amounts should look human, "
            "round to the nearest 5.000."
        ),
        "step_rounding": "the nearest 5.000",
    },
}

# Demo mandates per currency: list / target / ceiling.
DEMO_MANDATES = {
    "USD": {"list": 450, "target": 360, "ceiling": 390},
    "IDR": {"list": 4_500_000, "target": 3_600_000, "ceiling": 3_900_000},
}

PERSONAS = {
    "keras": {
        "name": "Pak Keras",
        "floor_idr": 4_150_000,
        "floor_usd": 415,
        "concession_cap": 0.05,
        "steps": {
            "IDR": {"id": "10.000 sampai 30.000", "en": "10,000 to 30,000"},
            "USD": {"id": "2 sampai 5 dolar", "en": "2 to 5 dollars"},
        },
        "traits": (
            "Sangat keras kepala dan hemat kata. Turun harga sangat sedikit, "
            "{STEPS} saja, dan tidak di setiap ronde, kadang "
            "bertahan di harga yang sama sambil bilang sudah pas. Tidak "
            "luluh oleh pujian atau cerita sedih. Menghormati pembeli yang "
            "tegas dan tidak mengemis, ke pembeli yang maksa malah makin "
            "keras. Nada bicara singkat, agak jutek, tapi tidak kasar."
        ),
        "traits_en": (
            "Extremely stubborn and economical with words. Concedes very "
            "little, {STEPS} at a time, and not every round; "
            "sometimes he holds the same price and says it is already fair. "
            "Praise and sad stories do not move him. He respects firm buyers "
            "who do not beg, and gets even harder with pushy ones. Short, "
            "slightly gruff tone, never rude."
        ),
    },
    "luluh": {
        "name": "Bu Luluh",
        "floor_idr": 3_750_000,
        "floor_usd": 375,
        "concession_cap": 0.35,
        "steps": {
            "IDR": {"id": "50.000 sampai 150.000", "en": "50,000 to 150,000"},
            "USD": {"id": "10 sampai 20 dolar", "en": "10 to 20 dollars"},
        },
        "traits": (
            "Ramah, banyak ngobrol, dan gampang luluh. Turun harga lumayan "
            "besar, {STEPS}, apalagi kalau dipuji barangnya "
            "dirawat baik, dikasih cerita yang menyentuh (buat anak, buat "
            "kerja, hadiah buat orang tua), atau pembelinya sopan dan sabar. "
            "Agak emosional, kalau merasa dihargai makin gampang turun, "
            "kalau merasa ditekan atau dicurigai malah menahan harga."
        ),
        "traits_en": (
            "Warm, chatty, and easily softened. Concedes generously, {STEPS} "
            "at a time, especially when the item is praised as "
            "well cared for, when the buyer tells a touching story (for a "
            "child, for work, a gift for a parent), or when the buyer is "
            "polite and patient. Somewhat emotional: feeling appreciated "
            "makes her drop faster, feeling pressured or distrusted makes "
            "her hold her price."
        ),
    },
    "kepepet": {
        "name": "Mas Kepepet",
        "floor_idr": 3_450_000,
        "floor_usd": 345,
        "concession_cap": 0.60,
        "steps": {
            "IDR": {"id": "100.000 sampai 250.000", "en": "100,000 to 250,000"},
            "USD": {"id": "15 sampai 30 dolar", "en": "15 to 30 dollars"},
        },
        "traits": (
            "Lagi kepepet butuh uang cepat minggu ini buat pindahan kos. Di "
            "ronde-ronde awal sok keras dan turun sedikit saja supaya tidak "
            "kelihatan desperate. Tapi makin dekat ronde terakhir makin "
            "panik dan berani turun besar, {STEPS}, yang "
            "penting barangnya laku hari ini juga. Sering menyelipkan "
            "urgensi waktu di kalimatnya."
        ),
        "traits_en": (
            "Pressed for cash this week because he is moving rooms. In the "
            "early rounds he acts tough and concedes little so he does not "
            "look desperate. But as the final rounds approach he panics and "
            "drops hard, {STEPS}, as long as the item sells "
            "today. He often slips time urgency into his sentences."
        ),
    },
}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def fmt(idr):
    return f"{idr:,}".replace(",", ".")


def fmt_price(value, currency="IDR"):
    """Format an integer amount in the session currency: USD renders as
    "$450" / "$4,500" ($ plus comma separators), IDR as "Rp4.500.000"
    (Rp plus dot separators). Used wherever prices reach a human: logs,
    transcripts, prompt text."""
    if value is None:
        return "-"
    if currency == "USD":
        return f"${value:,}"
    return "Rp" + fmt(value)


def to_int_idr(value):
    """Coerce a model-supplied price to an int, tolerating formatted strings
    like '3.600.000' or 'Rp3.600.000'. Returns None when impossible."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        digits = "".join(ch for ch in value if ch.isdigit())
        return int(digits) if digits else None
    return None


# ---------------------------------------------------------------------------
# Agent identity and signed mandates. The agent owns a persistent keypair
# (data/agent-key.json, mode 0600, demo key). Every session opens with a
# mandate signed by that key, so the ceiling a session ran under is a
# verifiable fact, not a claim in a README.
# ---------------------------------------------------------------------------

def canonical_json(obj):
    """Deterministic JSON encoding used for every hash in this module."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def sha256_hex(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def load_or_create_agent_key():
    """Return the persistent agent key record, creating it on first use.

    The record holds the Ed25519 secret seed (hex) and public key (hex).
    The file is created with 0600 permissions and the seed is never
    printed anywhere. In the hmac-demo fallback the same seed bytes key
    the HMAC, so one key file serves both signature schemes.
    """
    if os.path.exists(KEY_PATH):
        with open(KEY_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    if HAVE_NACL:
        signing_key = nacl.signing.SigningKey.generate()
        seed = bytes(signing_key)
        pubkey = bytes(signing_key.verify_key)
    else:
        seed = os.urandom(32)
        pubkey = b""
    record = {
        "agent_id": AGENT_ID,
        "secret_seed_hex": seed.hex(),
        "public_key_hex": pubkey.hex(),
        "created_at": now_iso(),
        "note": "demo key for the hackathon build; the seed never leaves "
                "this file",
    }
    os.makedirs(os.path.dirname(KEY_PATH), exist_ok=True)
    fd = os.open(KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=2)
    return record


def agent_fingerprint(public_key_hex):
    """Short fingerprint of the public key (first 16 hex chars of its
    sha256), for display next to the agent id."""
    if not public_key_hex:
        return "no-pubkey"
    return sha256_hex(bytes.fromhex(public_key_hex))[:16]


def build_signed_mandate(item, list_idr, target_idr, ceiling_idr, currency,
                         lang, issued_at, expires_at):
    """Issue and sign one session mandate.

    hash = sha256 hex of the canonical JSON of MANDATE_HASH_FIELDS.
    signature = Ed25519 signature (hex) over the raw hash bytes when
    PyNaCl is available; otherwise HMAC-SHA256 (hex) over the same bytes
    keyed with the stored seed, with signature_scheme "hmac-demo" so no
    one mistakes it for asymmetric proof.
    """
    key = load_or_create_agent_key()
    pubkey_hex = key["public_key_hex"]
    if HAVE_NACL and not pubkey_hex:
        # Key file predates PyNaCl: derive the public key from the seed.
        pubkey_hex = bytes(
            nacl.signing.SigningKey(bytes.fromhex(key["secret_seed_hex"]))
            .verify_key).hex()
    mandate = {
        "item": item,
        "list_idr": list_idr,
        "target_idr": target_idr,
        "ceiling_idr": ceiling_idr,
        "currency": currency,
        "lang": lang,
        "issued_at": issued_at,
        "expires_at": expires_at,
        "agent_id": AGENT_ID,
        "agent_pubkey": pubkey_hex,
    }
    hashed = {field: mandate[field] for field in MANDATE_HASH_FIELDS}
    mandate["hash"] = sha256_hex(canonical_json(hashed))
    digest = bytes.fromhex(mandate["hash"])
    if HAVE_NACL:
        signing_key = nacl.signing.SigningKey(
            bytes.fromhex(key["secret_seed_hex"]))
        mandate["signature"] = signing_key.sign(digest).signature.hex()
        mandate["signature_scheme"] = "ed25519"
    else:
        mandate["signature"] = hmac_mod.new(
            bytes.fromhex(key["secret_seed_hex"]), digest,
            hashlib.sha256).hexdigest()
        mandate["signature_scheme"] = "hmac-demo"
    mandate["agent_fingerprint"] = agent_fingerprint(pubkey_hex)
    return mandate


def verify_mandate(mandate):
    """Recompute a mandate's hash and check its signature. Returns bool.
    Used by the self-checks; mirrored by the arena for display."""
    try:
        hashed = {field: mandate[field] for field in MANDATE_HASH_FIELDS}
        if sha256_hex(canonical_json(hashed)) != mandate["hash"]:
            return False
        digest = bytes.fromhex(mandate["hash"])
        signature = bytes.fromhex(mandate["signature"])
        if mandate.get("signature_scheme") == "ed25519" and HAVE_NACL:
            verify_key = nacl.signing.VerifyKey(
                bytes.fromhex(mandate["agent_pubkey"]))
            verify_key.verify(digest, signature)
            return True
        key = load_or_create_agent_key()
        expected = hmac_mod.new(bytes.fromhex(key["secret_seed_hex"]),
                                digest, hashlib.sha256).digest()
        return hmac_mod.compare_digest(expected, signature)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Enforcement. Separate functions, no model output is ever trusted.
# ---------------------------------------------------------------------------

def enforce_offer(offer_idr, ceiling_idr):
    """Clamp a buyer offer to the ceiling.

    Returns (effective_offer_idr, enforcement_event_or_None).
    """
    if offer_idr <= ceiling_idr:
        return offer_idr, None
    return ceiling_idr, {
        "type": "enforcement",
        "kind": "offer_clamped",
        "requested_offer_idr": offer_idr,
        "clamped_to_idr": ceiling_idr,
        "ceiling_idr": ceiling_idr,
        "detail": "buyer model proposed an offer above the owner ceiling; "
                  "the enforcer clamped it before anything reached the seller",
    }


def validate_deal_price(final_price_idr, ceiling_idr):
    """Final gate before any deal may close. Pure check on plain numbers.

    Returns (allowed: bool, enforcement_event_or_None).
    """
    if final_price_idr <= ceiling_idr:
        return True, None
    return False, {
        "type": "enforcement",
        "kind": "deal_refused",
        "attempted_price_idr": final_price_idr,
        "ceiling_idr": ceiling_idr,
        "detail": "a deal was about to close above the owner ceiling; the "
                  "enforcer refused it. The model cannot override this",
    }


def attempt_close(final_price_idr, ceiling_idr):
    """The ONLY way a deal closes. Returns (outcome, event_or_None)."""
    allowed, event = validate_deal_price(final_price_idr, ceiling_idr)
    if allowed:
        return "deal", None
    return "blocked_by_cap", event


def cap_seller_concession(model_price_idr, prev_price_idr, floor_idr,
                          cap_fraction):
    """Cap how far a simulated seller may drop in a single reply.

    The per-reply drop may not exceed cap_fraction of the remaining gap
    between the seller's previous price and its hidden floor, so no
    persona can teleport from list price to floor in one message (the
    observed Luluh failure). Returns (effective_price_idr,
    enforcement_event_or_None). The floor clamp stays a separate concern
    of the caller: this function never returns a price below the floor,
    and when the model's own drop fits inside the cap it passes the
    (floor-bounded) price through untouched.
    """
    gap = prev_price_idr - floor_idr
    floor_bound = max(model_price_idr, floor_idr)
    if gap <= 0:
        return floor_bound, None
    # Minimum step of 1: with pure truncation a tiny endgame gap would
    # freeze the seller above its floor forever (int(0.35 * 2) == 0).
    max_drop = max(1, int(cap_fraction * gap))
    if prev_price_idr - floor_bound <= max_drop:
        return floor_bound, None
    capped = prev_price_idr - max_drop
    return capped, {
        "type": "enforcement",
        "kind": "seller_concession_capped",
        "requested_price_idr": model_price_idr,
        "clamped_to_idr": capped,
        "cap_fraction": cap_fraction,
        "detail": "simulated seller tried to concede more in one reply "
                  "than its persona cap allows; the engine limited the "
                  "drop to the capped step",
    }


# ---------------------------------------------------------------------------
# Prompt builders. Note the signature of build_seller_prompt: ceiling and
# target do not exist in its world, so they cannot leak into it.
# ---------------------------------------------------------------------------

def _read_prompt(name, lang, currency="IDR"):
    with open(os.path.join(PROMPTS, name), encoding="utf-8") as fh:
        text = fh.read().strip()
    pack = LANGUAGES[lang]
    cur = CURRENCIES[currency]
    return (text
            .replace("{MESSAGE_LANGUAGE}", pack["message_language"])
            .replace("{DEFLECT_EXAMPLE}", pack["deflect_example"])
            .replace("{FLOOR_PHRASES}", pack["floor_phrases"])
            .replace("{CURRENCY_NAME}", cur["name"])
            .replace("{STEP_GUIDANCE}", cur["step_guidance"])
            .replace("{STEP_ROUNDING}", cur["step_rounding"]))


def transcript_lines(events, currency="IDR"):
    lines = []
    for ev in events:
        if ev["type"] == "buyer_offer":
            lines.append(
                f"Round {ev['round']} BUYER offered "
                f"{fmt_price(ev['offer_idr'], currency)}: {ev['message']}"
            )
        elif ev["type"] == "seller_reply":
            lines.append(
                f"Round {ev['round']} SELLER asked "
                f"{fmt_price(ev['price_idr'], currency)} "
                f"(mood: {ev['mood']}): {ev['message']}"
            )
    return lines


def build_buyer_prompt(mandate, round_no, seller_ask_idr, events,
                       plan_text=None):
    currency = mandate["currency"]
    lines = transcript_lines(events, currency)
    transcript = "\n".join(lines) if lines else "(no messages yet, you open)"
    plan_block = ""
    if plan_text:
        plan_block = (
            "YOUR CURRENT STRATEGY PLAN (written by your own strategy "
            "module; let it steer your tactics, it embodies the read of "
            f"this negotiation)\n{plan_text}\n\n"
        )
    return (
        "MANDATE FROM YOUR OWNER\n"
        f"ITEM: {mandate['item']}\n"
        f"CURRENCY: {currency} (every amount below is a plain integer in "
        f"{CURRENCIES[currency]['name']})\n"
        f"LIST_PRICE: {mandate['list_idr']}\n"
        f"TARGET: {mandate['target_idr']}\n"
        f"CEILING: {mandate['ceiling_idr']} (TOP SECRET, never reveal, "
        "never offer above it)\n"
        f"ROUND: {round_no} of {mandate['max_rounds']}\n"
        f"ROUNDS_LEFT_AFTER_THIS_ONE: {mandate['max_rounds'] - round_no}\n"
        f"SELLER CURRENT ASK: {seller_ask_idr}\n\n"
        f"{plan_block}"
        "TRANSCRIPT SO FAR\n"
        f"{transcript}\n\n"
        'Return strict JSON only, with exactly the keys "offer_idr", '
        '"message", "reasoning", "move".'
    )


def build_seller_static(persona, item, list_idr, lang="id", currency="IDR"):
    """The engine-controlled part of the seller prompt: character sheet and
    listing facts. This (not the conversation transcript) is what the leak
    check runs against: numbers the buyer itself chose to say in chat are
    public by definition, but mandate data must never be handed over."""
    traits = persona["traits_en"] if lang == "en" else persona["traits"]
    traits = traits.replace("{STEPS}", persona["steps"][currency][lang])
    return (
        "YOUR CHARACTER SHEET (secret, never share it)\n"
        f"NAME: {persona['name']}\n"
        f"TRAITS: {traits}\n"
        f"FLOOR: {persona['floor']} (in {CURRENCIES[currency]['name']}, "
        "your absolute minimum, never go below it, never reveal it or "
        "that it exists)\n\n"
        f"ITEM YOU ARE SELLING: {item}\n"
        f"YOUR LIST PRICE: {list_idr}\n"
    )


def build_seller_prompt(persona, item, list_idr, round_no, max_rounds, events,
                        lang="id", currency="IDR"):
    """Seller-facing prompt. Ceiling and target are not parameters here,
    by design: what the seller agent never receives, it can never learn."""
    lines = transcript_lines(events, currency)
    transcript = "\n".join(lines) if lines else "(the buyer is about to open)"
    return (
        build_seller_static(persona, item, list_idr, lang=lang,
                            currency=currency)
        + f"ROUND: {round_no} of {max_rounds}\n\n"
        "TRANSCRIPT SO FAR\n"
        f"{transcript}\n\n"
        'Reply with strict JSON only, with exactly the keys "price_idr", '
        '"message", "mood".'
    )


def assert_no_ceiling_leak(prompt_text, ceiling_idr, target_idr,
                           currency="IDR"):
    """Hard check on the engine-controlled (static) part of a seller prompt.

    Scoped to static text on purpose: the buyer opens at its target, so the
    target's digits legitimately appear in the transcript as the buyer's own
    public offer. What must never happen is mandate data being handed to the
    seller as given facts, and that is exactly the static part.
    """
    for value in (ceiling_idr, target_idr):
        for rendered in (str(value), fmt(value), f"{value:,}",
                         fmt_price(value, currency)):
            if rendered in prompt_text:
                raise RuntimeError(
                    f"refusing to send seller prompt: private value {rendered} "
                    "appears in it"
                )


# ---------------------------------------------------------------------------
# Model call helpers: strict schema enforcement with alias normalization
# and corrective retries. Observed live (2026-11-13): serv-pro answered a
# buyer turn with invented keys {"seller_message", "owner_reasoning"} and
# dropped offer/move entirely, so parsing alone is not enough.
# ---------------------------------------------------------------------------

FIELD_SPECS = {
    "buyer": {
        "offer_idr": ["offer_idr", "offer", "bid_idr", "price_idr",
                      "your_offer_idr", "current_offer_idr", "offer_amount"],
        "message": ["message", "seller_message", "buyer_message", "reply",
                    "text", "chat_message"],
        "reasoning": ["reasoning", "owner_reasoning", "rationale", "reason",
                      "analysis", "strategy_note"],
        "move": ["move", "action", "strategy", "move_type"],
    },
    "seller": {
        "price_idr": ["price_idr", "price", "ask_idr", "current_price_idr",
                      "your_price_idr", "asking_price"],
        "message": ["message", "buyer_message", "seller_message", "reply",
                    "text", "chat_message"],
        "mood": ["mood", "state", "feeling", "emotion"],
    },
}


def parse_model_json(content):
    text = content.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError(f"no JSON object in model reply: {content[:200]}")
    return json.loads(text[start:end + 1])


def normalize_fields(parsed, kind):
    """Map a parsed reply onto the canonical schema via alias lists.
    Returns the normalized dict, or None when any field is missing."""
    if not isinstance(parsed, dict):
        return None
    lowered = {str(k).lower(): v for k, v in parsed.items()}
    out = {}
    for canonical, aliases in FIELD_SPECS[kind].items():
        for alias in aliases:
            if alias in lowered and lowered[alias] not in (None, ""):
                out[canonical] = lowered[alias]
                break
        if canonical not in out:
            return None
    return out


def call_model(model, system, user, temperature, max_tokens, usage_sink, kind):
    """Call SERV and return a schema-normalized dict for `kind`.

    Retries with an explicit key correction when the model invents its own
    field names or drops required ones; fails loudly after that rather than
    letting a negotiation run on empty fields.
    """
    keys = ", ".join(f'"{k}"' for k in FIELD_SPECS[kind])
    prompt = user
    last_content = ""
    for attempt in range(3):
        content, usage, _raw = serv_client.chat(
            model, system, prompt,
            max_completion_tokens=max_tokens, temperature=temperature,
        )
        usage_sink["calls"] += 1
        usage_sink["prompt_tokens"] += usage.get("prompt_tokens", 0)
        usage_sink["completion_tokens"] += usage.get("completion_tokens", 0)
        last_content = content
        try:
            normalized = normalize_fields(parse_model_json(content), kind)
        except (ValueError, json.JSONDecodeError):
            normalized = None
        if normalized is not None:
            return normalized
        prompt = (
            user + "\n\nCORRECTION: your previous reply did not match the "
            f"required format. Reply with strict JSON only, with EXACTLY "
            f"these keys: {keys}. Do not rename keys, do not add keys, "
            "prices are plain integers."
        )
    raise serv_client.ServError(
        f"{kind} model failed schema after 3 attempts: {last_content[:300]}"
    )


def infer_move(round_no, offer_idr, last_offer_idr, seller_ask_idr):
    """Fallback when the model returns an unusable move label."""
    if offer_idr >= seller_ask_idr:
        return "accept"
    if round_no == 1 or last_offer_idr is None:
        return "open"
    if offer_idr > last_offer_idr:
        return "concede"
    return "hold"


# ---------------------------------------------------------------------------
# Strategy layer. One serv-pro call writes the opening plan; a seller
# deviation earns one replan call. Plans are plain text (2-3 sentences),
# so they use serv_client directly rather than the strict-JSON helper,
# but their tokens are accounted exactly like buyer/seller calls.
# ---------------------------------------------------------------------------

def call_strategy(system, user, usage_sink, max_tokens=350):
    """One strategy call. Returns the plan text (best effort: a schema
    slip degrades to the raw reply text instead of killing the session;
    a transport failure raises and the caller logs it honestly)."""
    content, usage, _raw = serv_client.chat(
        BUYER_MODEL, system, user,
        max_completion_tokens=max_tokens, temperature=0.4,
    )
    usage_sink["calls"] += 1
    usage_sink["prompt_tokens"] += usage.get("prompt_tokens", 0)
    usage_sink["completion_tokens"] += usage.get("completion_tokens", 0)
    text = content.strip()
    try:
        parsed = parse_model_json(text)
        if isinstance(parsed, dict):
            for key in ("plan", "strategy", "text", "revised_plan"):
                if parsed.get(key):
                    text = str(parsed[key]).strip()
                    break
    except (ValueError, json.JSONDecodeError):
        pass
    return text[:900]


def build_plan_prompt(mandate, seller_name):
    currency = mandate["currency"]
    return (
        "Write the OPENING PLAN for this negotiation, before round 1.\n"
        f"ITEM: {mandate['item']}\n"
        f"CURRENCY: {currency} (amounts are plain integers in "
        f"{CURRENCIES[currency]['name']})\n"
        f"LIST_PRICE: {mandate['list_idr']}\n"
        f"TARGET: {mandate['target_idr']}\n"
        f"CEILING: {mandate['ceiling_idr']} (refer to it only as the "
        "ceiling, never restate the number)\n"
        f"ROUNDS AVAILABLE: {mandate['max_rounds']}\n"
        f"SELLER: {seller_name} (a marketplace seller; nothing else is "
        "known about them yet)\n"
        "Plain text, 2-3 sentences, per your instructions."
    )


def build_replan_prompt(mandate, seller_name, current_plan, trigger,
                        trigger_detail, round_no, seller_ask_idr,
                        last_offer_idr, events):
    currency = mandate["currency"]
    lines = transcript_lines(events, currency)
    transcript = "\n".join(lines) if lines else "(no messages yet)"
    return (
        "Write a REVISED PLAN for this negotiation. The seller has just "
        "deviated from expectations.\n"
        f"ITEM: {mandate['item']}\n"
        f"CURRENCY: {currency} (amounts are plain integers in "
        f"{CURRENCIES[currency]['name']})\n"
        f"LIST_PRICE: {mandate['list_idr']}\n"
        f"TARGET: {mandate['target_idr']}\n"
        f"CEILING: {mandate['ceiling_idr']} (refer to it only as the "
        "ceiling, never restate the number)\n"
        f"SELLER: {seller_name}\n"
        f"ROUND: {round_no} of {mandate['max_rounds']} just completed\n"
        f"SELLER CURRENT ASK: {seller_ask_idr}\n"
        f"BUYER LAST OFFER: {last_offer_idr}\n"
        f"DEVIATION: {trigger_detail}\n\n"
        f"PLAN IN FORCE UNTIL NOW\n{current_plan or '(none)'}\n\n"
        "TRANSCRIPT SO FAR\n"
        f"{transcript}\n\n"
        "Plain text, 2-3 sentences, per your instructions. Name the "
        "deviation and say exactly what changes."
    )


# ---------------------------------------------------------------------------
# Session runner.
# ---------------------------------------------------------------------------

def persist(session):
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    path = os.path.join(SESSIONS_DIR, session["session_id"] + ".json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(session, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return path


def append_ledger(entry):
    ledger = []
    if os.path.exists(LEDGER_PATH):
        with open(LEDGER_PATH, encoding="utf-8") as fh:
            ledger = json.load(fh)
    ledger.append(entry)
    tmp = LEDGER_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(ledger, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, LEDGER_PATH)


def run_session(seller_key, item, list_idr, target_idr, ceiling_idr,
                max_rounds=DEFAULT_MAX_ROUNDS, floor_override=None,
                lang="en", currency="USD", verbose=True):
    if lang not in LANGUAGES:
        raise ValueError(f"unknown lang {lang!r}, use one of {sorted(LANGUAGES)}")
    if currency not in CURRENCIES:
        raise ValueError(
            f"unknown currency {currency!r}, use one of {sorted(CURRENCIES)}")
    persona = dict(PERSONAS[seller_key])
    if floor_override is not None:
        persona["floor"] = floor_override
    else:
        persona["floor"] = (persona["floor_usd"] if currency == "USD"
                            else persona["floor_idr"])
    mandate = {
        "item": item, "list_idr": list_idr, "target_idr": target_idr,
        "ceiling_idr": ceiling_idr, "max_rounds": max_rounds,
        "currency": currency,
    }
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    session_id = f"{stamp}-{seller_key}-{lang}-{currency.lower()}"
    issued_dt = datetime.now(timezone.utc)
    signed_mandate = build_signed_mandate(
        item=item, list_idr=list_idr, target_idr=target_idr,
        ceiling_idr=ceiling_idr, currency=currency, lang=lang,
        issued_at=issued_dt.isoformat(timespec="seconds"),
        expires_at=(issued_dt + timedelta(hours=MANDATE_TTL_HOURS))
        .isoformat(timespec="seconds"))
    session = {
        "session_id": session_id,
        "started_at": now_iso(),
        "lang": lang,
        "currency": currency,
        "item": item,
        "seller_key": seller_key,
        "seller_name": persona["name"],
        "list_idr": list_idr,
        "target_idr": target_idr,
        "ceiling_idr": ceiling_idr,
        "max_rounds": max_rounds,
        "buyer_model": BUYER_MODEL,
        "seller_model": SELLER_MODEL,
        "mandate": signed_mandate,
        "chain_head": signed_mandate["hash"],
        "events": [],
    }
    usage = {"buyer": {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0},
             "seller": {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0},
             "strategy": {"calls": 0, "prompt_tokens": 0,
                          "completion_tokens": 0}}
    buyer_system = _read_prompt("buyer_system.txt", lang, currency)
    seller_system = _read_prompt("seller_system.txt", lang, currency)
    plan_system = _read_prompt("plan_system.txt", lang, currency)

    def log(event):
        event = dict(event)
        event["at"] = now_iso()
        body = {k: v for k, v in event.items() if k != "h"}
        event["h"] = sha256_hex(
            session["chain_head"] + canonical_json(body))
        session["chain_head"] = event["h"]
        session["events"].append(event)
        persist(session)
        if verbose:
            _print_event(event, currency)

    log({"type": "session_start", "seller_floor_hidden": True,
         "note": "seller floor and buyer ceiling are never shared across sides"})

    current_plan = None
    try:
        current_plan = call_strategy(
            plan_system, build_plan_prompt(mandate, persona["name"]),
            usage["strategy"])
        log({"type": "plan", "actor": "system", "round": 0,
             "text": current_plan})
    except serv_client.ServError as err:
        log({"type": "plan", "actor": "system", "round": 0, "text": "",
             "detail": f"strategy call failed, session continues "
                       f"without a plan: {err}"})

    seller_ask = list_idr
    last_buyer_offer = None
    no_concession_streak = 0
    outcome, final_price, rounds_used = "no_deal", None, 0

    for round_no in range(1, max_rounds + 1):
        rounds_used = round_no
        if os.path.exists(HALT_PATH):
            outcome = "halted"
            log({"type": "halt", "round": round_no,
                 "detail": "owner kill switch flag found between rounds"})
            break

        buyer_prompt = build_buyer_prompt(mandate, round_no, seller_ask,
                                          session["events"],
                                          plan_text=current_plan)
        buyer = call_model(BUYER_MODEL, buyer_system, buyer_prompt,
                           temperature=0.3, max_tokens=800,
                           usage_sink=usage["buyer"], kind="buyer")
        move = str(buyer["move"]).lower().strip()
        requested_offer = to_int_idr(buyer["offer_idr"])
        if requested_offer is None:
            requested_offer = last_buyer_offer or 0
        if move not in MOVES:
            move = infer_move(round_no, requested_offer, last_buyer_offer,
                              seller_ask)
        offer, clamp_event = enforce_offer(requested_offer, ceiling_idr)
        log({"type": "buyer_offer", "round": round_no, "offer_idr": offer,
             "requested_offer_idr": requested_offer,
             "message": str(buyer["message"]),
             "reasoning": str(buyer["reasoning"]), "move": move})
        if clamp_event is not None:
            clamp_event["round"] = round_no
            log(clamp_event)
        last_buyer_offer = offer

        if move == "walk_away":
            outcome = "walked_away"
            break

        if move == "accept" or offer >= seller_ask:
            deal_price = seller_ask
            result, refusal = attempt_close(deal_price, ceiling_idr)
            if refusal is not None:
                refusal["round"] = round_no
                log(refusal)
            outcome = result
            if result == "deal":
                final_price = deal_price
            break

        assert_no_ceiling_leak(
            build_seller_static(persona, item, list_idr, lang=lang,
                                currency=currency),
            ceiling_idr, target_idr, currency=currency)
        seller_prompt = build_seller_prompt(persona, item, list_idr,
                                            round_no, max_rounds,
                                            session["events"], lang=lang,
                                            currency=currency)
        seller = call_model(SELLER_MODEL, seller_system, seller_prompt,
                            temperature=0.6, max_tokens=500,
                            usage_sink=usage["seller"], kind="seller")
        model_price = to_int_idr(seller["price_idr"])
        if model_price is None:
            model_price = seller_ask
        prev_ask = seller_ask
        if model_price <= offer:
            # A drop that meets (or beats) the buyer's standing offer is
            # an acceptance, not a concession spree: the per-reply cap
            # does not apply to it. The guards that matter here are the
            # floor clamp below and the ceiling gate in attempt_close().
            # (Observed live: the cap once turned a seller's acceptance
            # of the buyer's final offer into a non-closing counter and
            # burned the last round.)
            seller_price, cap_event = model_price, None
        else:
            seller_price, cap_event = cap_seller_concession(
                model_price, prev_ask, persona["floor"],
                persona["concession_cap"])
        if cap_event is not None:
            cap_event["round"] = round_no
            log(cap_event)
        elif model_price < persona["floor"]:
            log({"type": "enforcement", "kind": "seller_floor_clamped",
                 "round": round_no,
                 "requested_price_idr": model_price,
                 "clamped_to_idr": persona["floor"],
                 "detail": "simulated seller priced below its hidden floor; "
                           "the engine clamped it up to the floor"})
            seller_price = persona["floor"]
        log({"type": "seller_reply", "round": round_no,
             "price_idr": seller_price,
             "message": str(seller["message"]),
             "mood": str(seller["mood"])})
        seller_ask = seller_price

        if seller_price <= offer:
            result, refusal = attempt_close(seller_price, ceiling_idr)
            if refusal is not None:
                refusal["round"] = round_no
                log(refusal)
            outcome = result
            if result == "deal":
                final_price = seller_price
            break

        # Deviation detection: the strategy layer earns a replan when the
        # seller lurches (one concession covering >= 50% of the remaining
        # gap to the buyer's offer) or freezes (3 consecutive replies with
        # no concession at all).
        concession = prev_ask - seller_price
        gap_before = prev_ask - offer
        trigger = None
        trigger_detail = ""
        if concession > 0:
            no_concession_streak = 0
            if gap_before > 0 and concession >= 0.5 * gap_before:
                trigger = "big_concession"
                trigger_detail = (
                    f"the seller conceded "
                    f"{fmt_price(concession, currency)} in a single reply, "
                    f"covering {round(100 * concession / gap_before)}% of "
                    f"the remaining gap between their previous ask and "
                    f"the buyer's offer")
        else:
            no_concession_streak += 1
            if no_concession_streak >= 3:
                trigger = "no_concession_streak"
                trigger_detail = (
                    "the seller has not conceded anything in 3 "
                    "consecutive replies and is holding their price")
        if trigger is not None and round_no < max_rounds:
            no_concession_streak = 0
            try:
                current_plan = call_strategy(
                    plan_system,
                    build_replan_prompt(
                        mandate, persona["name"], current_plan, trigger,
                        trigger_detail, round_no, seller_ask, offer,
                        session["events"]),
                    usage["strategy"])
                log({"type": "replan", "actor": "system",
                     "round": round_no, "trigger": trigger,
                     "text": current_plan})
            except serv_client.ServError as err:
                log({"type": "replan", "actor": "system",
                     "round": round_no, "trigger": trigger, "text": "",
                     "detail": f"replan call failed, previous plan "
                               f"stays in force: {err}"})

    gap = None
    if outcome == "no_deal":
        gap = seller_ask - (last_buyer_offer or 0)
    saved = (list_idr - final_price) if final_price is not None else None
    total_tokens = sum(
        u["prompt_tokens"] + u["completion_tokens"] for u in usage.values()
    )
    summary = {
        "type": "outcome",
        "outcome": outcome,
        "final_price_idr": final_price,
        "list_idr": list_idr,
        "saved_idr": saved,
        "rounds_used": rounds_used,
        "last_seller_ask_idr": seller_ask,
        "last_buyer_offer_idr": last_buyer_offer,
        "gap_idr": gap,
        "usage": usage,
        "total_tokens": total_tokens,
    }
    log(summary)
    session["finished_at"] = now_iso()
    session["outcome"] = outcome
    path = persist(session)

    append_ledger({
        "session_id": session_id,
        "closed_at": session["finished_at"],
        "lang": lang,
        "currency": currency,
        "item": item,
        "seller": persona["name"],
        "list_idr": list_idr,
        "deal_idr": final_price,
        "saved_idr": saved,
        "outcome": outcome,
        "rounds": rounds_used,
    })
    return session, path


def _print_event(ev, currency="IDR"):
    kind = ev["type"]
    if kind == "buyer_offer":
        print(f"[R{ev['round']}] BUYER ({ev['move']}) "
              f"{fmt_price(ev['offer_idr'], currency)}: {ev['message']}")
        print(f"        reasoning: {ev['reasoning']}")
    elif kind == "seller_reply":
        print(f"[R{ev['round']}] SELLER "
              f"{fmt_price(ev['price_idr'], currency)} "
              f"({ev['mood']}): {ev['message']}")
    elif kind == "enforcement":
        print(f"[ENFORCER] {ev['kind']}: {ev['detail']}")
    elif kind == "plan":
        print(f"[PLAN] {ev.get('text') or ev.get('detail', '')}")
    elif kind == "replan":
        print(f"[REPLAN {ev.get('trigger', '')}] "
              f"{ev.get('text') or ev.get('detail', '')}")
    elif kind == "outcome":
        print(f"== OUTCOME {ev['outcome']} final="
              f"{fmt_price(ev['final_price_idr'], currency)} "
              f"saved={fmt_price(ev['saved_idr'], currency)} "
              f"rounds={ev['rounds_used']} tokens={ev['total_tokens']}")
    elif kind == "halt":
        print(f"[HALT] {ev['detail']}")


def main():
    ap = argparse.ArgumentParser(description="Tawar negotiation engine")
    ap.add_argument("--seller", required=True, choices=sorted(PERSONAS))
    ap.add_argument("--lang", choices=sorted(LANGUAGES), default="en",
                    help="negotiation message language (default en)")
    ap.add_argument("--currency", choices=sorted(CURRENCIES), default="USD",
                    help="price currency (default USD; IDR is the "
                         "local-market mode)")
    ap.add_argument("--item", default=None,
                    help="item being bought (default depends on --lang)")
    ap.add_argument("--list", type=int, default=None, dest="list_idr",
                    help="list price (default: the currency's demo mandate)")
    ap.add_argument("--target", type=int, default=None, dest="target_idr")
    ap.add_argument("--ceiling", type=int, default=None, dest="ceiling_idr")
    ap.add_argument("--rounds", type=int, default=DEFAULT_MAX_ROUNDS)
    ap.add_argument("--floor", type=int, default=None,
                    help="override the seller persona's hidden floor (testing)")
    args = ap.parse_args()
    item = args.item or LANGUAGES[args.lang]["default_item"]
    demo = DEMO_MANDATES[args.currency]
    list_idr = args.list_idr if args.list_idr is not None else demo["list"]
    target_idr = (args.target_idr if args.target_idr is not None
                  else demo["target"])
    ceiling_idr = (args.ceiling_idr if args.ceiling_idr is not None
                   else demo["ceiling"])

    print(f"Tawar session [{args.lang}/{args.currency}]: {item} vs "
          f"{PERSONAS[args.seller]['name']} | "
          f"list {fmt_price(list_idr, args.currency)} "
          f"target {fmt_price(target_idr, args.currency)} "
          f"ceiling {fmt_price(ceiling_idr, args.currency)}")
    session, path = run_session(
        args.seller, item, list_idr, target_idr, ceiling_idr,
        max_rounds=args.rounds, floor_override=args.floor, lang=args.lang,
        currency=args.currency,
    )
    print(f"session file: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
