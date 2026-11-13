# TAWAR — Build Brief (SERV Hackathon 02, Track 02 Kite)

## The product in one sentence
Tawar is an autonomous price-negotiation agent. You give it an item, a target price, and a hard spending ceiling. It haggles round by round on your behalf, shows its reasoning for every move, and CANNOT pay above your ceiling, because the ceiling is enforced by code, not by the model's intentions.

## Why this fits Track Kite
Kite is about verifiable agent identity plus controlled spending limits (Agent Passport idea, the leash stays in the owner's hand). Tawar is that idea as a consumer product:
- The agent carries a persistent identity card (name, owner, mandate: negotiate only, ceiling value, expiry) shown in the UI.
- The spending limit is a hard system invariant. A separate enforcement module validates every proposed deal before it can close. A deal above the ceiling is refused by the system even if the model agreed to it.
- Kill switch: the owner can halt a negotiation at any point; the engine honors a halt flag between rounds.
- Every session appends to a savings ledger (list price vs deal price), the product's measurable value.

## The negotiation model
- Buyer agent: SERV Reasoning via serv-pro. Each turn it receives the full transcript, the mandate (item, target, ceiling as a HIDDEN-from-seller value, round budget) and must return strict JSON: { "offer_idr": int, "message": str, "reasoning": str, "move": "open|concede|hold|bundle|deadline|walk_away|accept" }.
- Seller agents: serv-mini, three personas with hidden floor prices and hidden traits:
  1. Pak Keras — stubborn, tiny concessions, respects firm buyers, floor close to list.
  2. Bu Luluh — flexible, emotional, bigger concessions when praised or given a story, mid floor.
  3. Mas Kepepet — deadline-pressed, starts stubborn then drops fast near the end, lowest floor.
  Seller JSON: { "price_idr": int, "message": str, "mood": str }.
- Engine rules (code, not model):
  - Rounds capped (default 8 exchanges). Prices must be integers in IDR.
  - The buyer may never offer above the ceiling. Offers from the model above the ceiling are clamped and the clamp is logged as an enforcement event.
  - A deal closes only when seller price <= buyer offer OR seller accepts; before closing, the ENFORCER re-checks the final price against the ceiling. Above ceiling = deal REFUSED, negotiation ends as "blocked_by_cap", and the refusal is a first-class visible event (this is the demo's money moment).
  - If rounds run out with no deal, outcome is "no_deal" with the gap reported honestly.
  - Walk-away: the buyer model may choose walk_away; engine ends the session.
  - Every event (offers, messages, reasoning, enforcements, outcome) is appended to a session transcript JSON, append-only, timestamped.
- Demo scenario (default): secondhand iPhone 12 128GB, list price Rp4.500.000, target Rp3.600.000, ceiling Rp3.900.000. Seller floors (hidden): Keras 4.150.000, Luluh 3.750.000, Kepepet 3.450.000. So Luluh and Kepepet can close under the ceiling, Keras cannot — the demo can show both a successful saving AND a cap-blocked deal.

## Language (updated 2026-11-13, user: the hackathon is international)
Everything judge-facing is English: UI chrome, README, submission write-up, demo narration. Negotiation messages follow a session language flag (--lang en default, id optional). en = natural English marketplace haggling. id = Bahasa Indonesia marketplace style, presented in the UI as "Local market mode", a feature (the agent haggles in the language of the market). Reasoning traces are always English — short, one or two sentences, tied to the numbers.

## Currency (added 2026-11-13, user: the hackathon is international)
The engine takes --currency USD|IDR, default USD. The headline demo runs in USD (iPhone scenario at list 450, target 360, ceiling 390; persona floors Keras 415, Luluh 375, Kepepet 345). IDR stays as the local-market mode with the original 4.500.000 mandate. Amounts remain plain integers in the session currency, session JSON and ledger entries record "currency", and all human-facing formatting goes through one helper (USD "$450", IDR "Rp4.500.000"). The buyer prompt also carries final-rounds discipline: concessions shrink hardest at the end, holding near the target beats climbing to the ceiling, and the ceiling is never a closing tool.

## Layout
- src/engine.py — negotiation state machine + enforcement + session runner (CLI: python3 src/engine.py --seller luluh --list 4500000 --target 3600000 --ceiling 3900000)
- src/serv_client.py — same pattern as the existing connector client (dynamic_credentials surrogate, no redirects, system prompt required, max_completion_tokens). Reuse by copying from ~/workspace/serv-hackathon/src/serv_client.py and adapting the module docstring.
- src/prompts/buyer_system.txt, src/prompts/seller_system.txt
- data/sessions/ — one JSON per finished session, data/ledger.json — savings ledger (append-only)
- web/ — the arena (see UI brief)

## Hard constraints
- No real money, no real marketplaces. Sellers are simulated agents; say so plainly in the UI footer and README.
- Never print or hardcode the API credential.
- Prices always IDR integers; format with thousand separators in UI.
- The ceiling value must never appear in any seller prompt. Test this.
- Enforcement is a separate function that does not trust model output.

## Success bar (user demands genuinely high quality)
- A full live negotiation runs end to end against SERV with no manual fixes.
- At least one session closes a deal under the ceiling and one session is visibly blocked by the cap.
- The arena makes a judge understand the product in 10 seconds: what it is, where the leash is, how much it saved.
