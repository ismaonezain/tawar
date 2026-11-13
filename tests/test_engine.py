"""Offline unit tests for the TAWAR negotiation engine (src/engine.py).

These are the tests the README and submission write-up refer to. They
cover the credibility and enforcement layer only: signed mandates and
their tamper rejection, the code-enforced ceiling on offers and closing
prices, the seller concession caps, and the guarantee that mandate data
(the ceiling above all) never reaches a seller-side prompt.

Fully offline: the suite never calls the SERV API (the buyer/seller model
calls are not exercised here), an autouse fixture hard-blocks socket
connects, and the mandate fixture substitutes a freshly generated
in-memory agent key, so the tests neither touch nor read the project's
real data/agent-key.json.

Run from the project root:  python3 -m pytest tests/ -q
"""
import copy
import inspect
import os
import socket
import sys
from datetime import timedelta

import pytest

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

import engine  # noqa: E402


@pytest.fixture(autouse=True)
def _offline(monkeypatch):
    """Hard-block every outbound socket connect for the whole suite."""
    def _blocked(*args, **kwargs):
        raise AssertionError("network access is disabled in this suite")
    monkeypatch.setattr(socket.socket, "connect", _blocked)
    monkeypatch.setattr(socket.socket, "connect_ex", _blocked)
    monkeypatch.setattr(socket, "create_connection", _blocked)


@pytest.fixture()
def mandate_env(monkeypatch):
    """Engine whose agent key is a fresh in-memory key record.

    load_or_create_agent_key is stubbed to return a freshly generated
    record instead of creating one on disk: the tests exercise signing
    and verification, not key-file storage, and this guarantees the suite
    can never touch the project's real data/agent-key.json. All signing
    still happens inside the engine with a real Ed25519 key (PyNaCl);
    without PyNaCl the engine's hmac-demo scheme uses the same record,
    so verification stays consistent either way.
    """
    try:
        import nacl.signing
        signing_key = nacl.signing.SigningKey.generate()
        seed_hex = bytes(signing_key).hex()
        pubkey_hex = bytes(signing_key.verify_key).hex()
    except Exception:
        seed_hex = os.urandom(32).hex()
        pubkey_hex = ""
    record = {
        "agent_id": engine.AGENT_ID,
        "secret_seed_hex": seed_hex,
        "public_key_hex": pubkey_hex,
        "created_at": engine.now_iso(),
        "note": "test key, generated in memory by the test fixture",
    }
    monkeypatch.setattr(engine, "load_or_create_agent_key", lambda: record)
    return engine


def _issue(engine_module, **overrides):
    issued = engine_module.now_iso()
    args = {
        "item": "Secondhand iPhone 12 128GB",
        "list_idr": 450,
        "target_idr": 360,
        "ceiling_idr": 390,
        "currency": "USD",
        "lang": "en",
        "issued_at": issued,
        "expires_at": issued,  # replaced below with issued + TTL
    }
    args.update(overrides)
    from datetime import datetime
    issued_dt = datetime.fromisoformat(args["issued_at"])
    args["expires_at"] = (
        issued_dt + timedelta(hours=engine_module.MANDATE_TTL_HOURS)
    ).isoformat(timespec="seconds")
    return engine_module.build_signed_mandate(**args)


# ---------------------------------------------------------------------------
# Signed mandates
# ---------------------------------------------------------------------------

def test_mandate_verifies_as_issued(mandate_env):
    mandate = _issue(mandate_env)
    assert mandate_env.verify_mandate(mandate) is True
    # The recorded hash really is the sha256 of the canonical JSON of
    # exactly MANDATE_HASH_FIELDS, nothing more, nothing less.
    hashed = {f: mandate[f] for f in mandate_env.MANDATE_HASH_FIELDS}
    assert mandate["hash"] == mandate_env.sha256_hex(
        mandate_env.canonical_json(hashed))


def test_mandate_tampering_is_rejected(mandate_env):
    mandate = _issue(mandate_env)

    dearer_ceiling = copy.deepcopy(mandate)
    dearer_ceiling["ceiling_idr"] = 999
    assert mandate_env.verify_mandate(dearer_ceiling) is False

    moved_target = copy.deepcopy(mandate)
    moved_target["target_idr"] = 300
    assert mandate_env.verify_mandate(moved_target) is False

    other_item = copy.deepcopy(mandate)
    other_item["item"] = "Secondhand iPhone 13 128GB"
    assert mandate_env.verify_mandate(other_item) is False

    forged_hash = copy.deepcopy(mandate)
    forged_hash["hash"] = "0" * 64
    assert mandate_env.verify_mandate(forged_hash) is False

    flipped_sig = copy.deepcopy(mandate)
    sig = flipped_sig["signature"]
    flipped_sig["signature"] = ("0" if sig[0] != "0" else "1") + sig[1:]
    assert mandate_env.verify_mandate(flipped_sig) is False


# ---------------------------------------------------------------------------
# The ceiling gate on closing prices
# ---------------------------------------------------------------------------

def test_attempt_close_over_ceiling_is_blocked():
    outcome, event = engine.attempt_close(391, 390)
    assert outcome == "blocked_by_cap"
    assert event is not None
    assert event["type"] == "enforcement"
    assert event["kind"] == "deal_refused"
    assert event["attempted_price_idr"] == 391
    assert event["ceiling_idr"] == 390


def test_attempt_close_at_and_below_ceiling_closes():
    assert engine.attempt_close(390, 390) == ("deal", None)
    assert engine.attempt_close(389, 390) == ("deal", None)
    assert engine.attempt_close(1, 390) == ("deal", None)


def test_attempt_close_idr_over_ceiling_is_blocked():
    # The case from the submission write-up: a Rp4.100.000 close against
    # a Rp3.900.000 ceiling must be refused.
    outcome, event = engine.attempt_close(4_100_000, 3_900_000)
    assert outcome == "blocked_by_cap"
    assert event is not None
    assert event["kind"] == "deal_refused"
    assert event["attempted_price_idr"] == 4_100_000
    assert event["ceiling_idr"] == 3_900_000
    assert engine.attempt_close(3_900_000, 3_900_000) == ("deal", None)


# ---------------------------------------------------------------------------
# The ceiling clamp on buyer offers
# ---------------------------------------------------------------------------

def test_enforce_offer_clamps_above_ceiling():
    effective, event = engine.enforce_offer(400, 390)
    assert effective == 390
    assert event is not None
    assert event["type"] == "enforcement"
    assert event["kind"] == "offer_clamped"
    assert event["requested_offer_idr"] == 400
    assert event["clamped_to_idr"] == 390


def test_enforce_offer_passes_at_and_below_ceiling():
    assert engine.enforce_offer(390, 390) == (390, None)
    assert engine.enforce_offer(360, 390) == (360, None)


# ---------------------------------------------------------------------------
# Seller concession caps
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("persona,cap,expected_drop", [
    ("keras", 0.05, 30),
    ("luluh", 0.35, 210),
    ("kepepet", 0.60, 360),
])
def test_concession_cap_math(persona, cap, expected_drop):
    # The persona table really carries the fractions this test assumes.
    assert engine.PERSONAS[persona]["concession_cap"] == cap
    prev_price, floor = 1000, 400  # remaining gap of 600
    # The model tries to teleport straight to its floor in one reply.
    price, event = engine.cap_seller_concession(floor, prev_price, floor, cap)
    assert price == prev_price - expected_drop
    assert event is not None
    assert event["kind"] == "seller_concession_capped"
    assert event["cap_fraction"] == cap
    assert event["requested_price_idr"] == floor
    assert event["clamped_to_idr"] == price


def test_concession_within_cap_passes_untouched():
    # A drop of 100 against a 35% cap on a 600 gap (max 210) is legal.
    assert engine.cap_seller_concession(900, 1000, 400, 0.35) == (900, None)


def test_concession_never_breaches_the_floor():
    for cap in (0.05, 0.35, 0.60):
        for model_price in (300, 399, 400, 410):
            price, _ = engine.cap_seller_concession(model_price, 1000, 400,
                                                    cap)
            assert price >= 400


def test_concession_minimum_step_reaches_floor():
    # With a gap of 2 and a 5% cap, pure truncation would allow a drop of
    # 0 and freeze the seller above its floor forever. The engine's
    # minimum step of 1 lets the price walk 402 -> 401 -> 400.
    price, event = engine.cap_seller_concession(395, 402, 400, 0.05)
    assert price == 401
    assert event is not None and event["kind"] == "seller_concession_capped"
    price, event = engine.cap_seller_concession(395, 401, 400, 0.05)
    assert price == 400
    assert event is None


# ---------------------------------------------------------------------------
# The ceiling never reaches the seller side
# ---------------------------------------------------------------------------

def _persona_with_floor(key, currency):
    persona = dict(engine.PERSONAS[key])
    persona["floor"] = (persona["floor_usd"] if currency == "USD"
                        else persona["floor_idr"])
    return persona


def _rendered_forms(value, currency):
    return (str(value), engine.fmt(value), f"{value:,}",
            engine.fmt_price(value, currency))


def test_seller_prompt_builder_has_no_ceiling_parameter():
    # Structural guarantee: build_seller_prompt cannot leak what it is
    # never handed. Neither the ceiling nor the target is a parameter.
    params = set(inspect.signature(engine.build_seller_prompt).parameters)
    assert "ceiling_idr" not in params
    assert "ceiling" not in params
    assert "target_idr" not in params


def test_no_mandate_leak_in_seller_prompts():
    for persona_key in ("keras", "luluh", "kepepet"):
        for currency, demo in engine.DEMO_MANDATES.items():
            for lang in ("en", "id"):
                persona = _persona_with_floor(persona_key, currency)
                item = engine.LANGUAGES[lang]["default_item"]
                static = engine.build_seller_static(
                    persona, item, demo["list"], lang=lang,
                    currency=currency)
                # The engine's own hard assertion must not fire: neither
                # the ceiling nor the target appears in the static part.
                engine.assert_no_ceiling_leak(
                    static, demo["ceiling"], demo["target"], currency)
                # And the ceiling in every rendered form is absent from
                # the full seller prompt too (empty transcript, so nothing
                # the buyer itself said in chat can excuse a hit).
                full = engine.build_seller_prompt(
                    persona, item, demo["list"], 1, 8, [],
                    lang=lang, currency=currency)
                for rendered in _rendered_forms(demo["ceiling"], currency):
                    assert rendered not in full, (
                        f"ceiling form {rendered!r} leaked into the "
                        f"{persona_key}/{currency}/{lang} seller prompt")
