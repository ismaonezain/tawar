#!/usr/bin/env python3
"""In-process client for the OpenServ SERV Reasoning API (custom.openserv).

Adapted for Tawar from the Alpha Scanner client, which mirrors
~/workspace/custom-connectors/custom.openserv/bin/serv.py: requests carry an
hsurr: surrogate from dynamic_credentials, swapped for the real key only on
the approved request to inference-api.openserv.ai. No credential is ever
seen, stored or printed here.

Facts baked in from the verified connector doc:
- A system prompt is REQUIRED on every request (the API rejects without one).
- The token limit field is max_completion_tokens (max_tokens returns a 400).
- Redirects stay disabled on authenticated requests.
"""
import json
import sys
import urllib.error
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

BASE = "https://inference-api.openserv.ai"
HOSTS = ["inference-api.openserv.ai"]
CREDENTIAL = "custom.openserv"


class ServError(RuntimeError):
    """Raised on transport or HTTP errors from the SERV API."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise ServError("redirect refused, verify the endpoint")


def chat(model, system, user, max_completion_tokens=2000, temperature=0.2,
         timeout=240):
    """Run one chat completion. Returns (content, usage, raw_response)."""
    if not system:
        raise ServError("SERV requires a system prompt on every request")
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_completion_tokens": max_completion_tokens,
    }
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        BASE + "/v1/chat/completions",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    add_surrogate_to_request(request, CREDENTIAL, allowed_hosts=HOSTS)
    try:
        with urllib.request.build_opener(_NoRedirect()).open(
            request, timeout=timeout
        ) as response:
            raw = read_json_response(response)
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")
        raise ServError(f"HTTP {err.code} from /v1/chat/completions: {body}") from err
    except ServError:
        raise
    except Exception as err:  # timeouts, DNS, surrogate failures
        raise ServError(f"request to SERV API failed: {err}") from err
    try:
        content = raw["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as err:
        raise ServError(f"unexpected SERV response shape: {json.dumps(raw)[:400]}") from err
    return content, raw.get("usage") or {}, raw
