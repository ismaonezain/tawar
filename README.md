# TAWAR

**The agent that haggles for you, and cannot overspend your limit.**

Tawar is an autonomous price-negotiation agent for online marketplaces, built for SERV Hackathon 02 (Track 02, Kite). You name an item, a target price, and a hard spending ceiling. Tawar negotiates round by round on your behalf, shows its reasoning for every move, and stops at your ceiling, because the limit is enforced by code, not by the model's good intentions.

## What it does

1. You set a mandate: the item, the list price, your target, and your ceiling. Before round 1, the engine signs that mandate with the agent's persistent key and asks SERV Reasoning for a written strategy plan.
2. Tawar opens the negotiation and haggles in rounds, conceding in shrinking steps, holding when the seller gives nothing, re-planning when the seller deviates from the plan, and walking away when the gap cannot close inside the mandate.
3. Every move carries a short reasoning trace written for you, so you can audit why it offered what it offered.
4. If a deal lands, it closes at or under your ceiling. If no deal fits inside the mandate, Tawar reports that honestly instead of quietly paying more.
5. The result is appended to a savings ledger: list price, final price, amount saved. Wins and walk-aways both stay on the record.

Tawar negotiates in the language of the market. The headline demo runs in English and USD. A Local Market Mode runs in Bahasa Indonesia and rupiah, the way haggling actually sounds on Indonesian marketplaces.

## The leash: identity and limits you can verify

Track Kite is about agent identity plus controlled spending. Tawar turns that into a consumer product:

- **Signed mandate.** The agent holds a persistent Ed25519 keypair (`data/agent-key.json`, mode 0600, demo key). At session start the engine builds a mandate (item, list price, target, ceiling, currency, language, issue and expiry timestamps, agent id `tawar.agent`, public key), hashes it with sha256 over its canonical JSON, and signs the hash. The arena's identity card shows the agent's public-key fingerprint (`9133ba931b1ebbeb` for the demo key). Verification recomputes the hash and checks the signature, and a tampered mandate (change the ceiling after signing, for example) is rejected; this is unit-tested.
- **Hash-chained transcripts.** Every event in a session transcript carries `h`, the sha256 of the previous event's hash plus the event's own content, and the chain is anchored in the signed mandate hash. The session header holds the chain head. Edit any price in any past event and the chain breaks from that point on. The arena has a Verify button that recomputes the whole chain in the browser, so a judge does not have to trust our word for it.
- **Code-enforced ceiling.** The ceiling never appears in any prompt the seller sees; a unit test asserts this for every persona, currency, and language. Buyer offers above the ceiling are clamped by the engine and logged. Before any deal closes, a separate enforcement function re-validates the final price. A deal above the ceiling is refused by the system even if the model agreed to it, and the session ends as `blocked_by_cap` with the refusal shown as a first-class event.
- **Seller-side enforcement.** The simulated sellers are held to rules in code too. Each persona's concession in a single reply is capped at a fraction of the remaining gap to its hidden floor (Pak Keras 5%, Bu Luluh 35%, Mas Kepepet 60%), and a seller that tries to drop further is clamped, with the clamp logged as a `seller_concession_capped` enforcement event. One such event is on the record in a real session (see Live results).
- **Kill switch.** The owner can halt a session at any time; the engine checks a halt flag between rounds and stops.
- **Savings ledger.** Every finished session appends one row to `data/ledger.json`. The product's value is a number you can add up, not a claim.

In the live runs below, the buyer never attempted an over-ceiling close, so no recorded session needed the refusal. The refusal path is covered by unit tests that force an over-ceiling deal (Rp4.100.000 against a Rp3.900.000 ceiling) and confirm the enforcer blocks it while allowing an at-ceiling deal. The Limitations section states the remaining gap plainly.

## How it uses SERV Reasoning

All negotiation intelligence runs on the OpenServ inference API.

- **Buyer (serv-pro).** Each turn, the buyer receives the full transcript, its mandate (item, target, secret ceiling, rounds left), and the currently active strategy plan, and must return strict JSON: an offer, a message to the seller, a move type (`open`, `concede`, `hold`, `bundle`, `deadline`, `walk_away`, `accept`), and a reasoning trace in English tied to the numbers. Its instructions encode a real haggling discipline: open at target, concede in shrinking steps, shrink hardest in the final rounds, treat the ceiling as an emergency boundary and never as a closing tool.
- **Strategy layer (serv-pro).** Before round 1, one strategy call writes a `plan` event: how to open, how fast to concede, what to do in the endgame, given the mandate and the seller persona. Mid-session, a deviation triggers one `replan` call and a `replan` event that replaces the active plan: the triggers are a single seller concession covering at least half the remaining gap in one reply, or three consecutive seller replies with no concession at all. The active plan is injected into every buyer prompt, so the reasoning the judges read is plan-driven, not improvised turn by turn. Strategy calls are counted in each session's token usage like any other call.
- **Sellers (serv-mini).** Three simulated sellers with hidden floor prices and distinct personalities: Pak Keras (stubborn, concedes in tiny steps), Bu Luluh (flexible, concedes in real steps when treated fairly), and Mas Kepepet (deadline-pressed, folds late). The ceiling and target are never passed to a seller prompt, and their per-reply concessions are capped in code as described above.
- **Robustness layer.** SERV models occasionally rename or drop JSON keys on long prompts. The client validates every reply against the canonical schema, normalizes known aliases, and retries with an explicit key-correction prompt before failing loudly. No live session needed manual repair after this was added.

## Architecture

```
server.py              live-run server: serves the arena, POST /run, POST /halt
src/
  engine.py            negotiation state machine, enforcement, mandate signing,
                       hash chaining, strategy layer, session runner, ledger
  serv_client.py       OpenServ API client (system prompt required, strict JSON handling)
  prompts/
    buyer_system.txt   serv-pro buyer instructions (parameterized by language and currency)
    plan_system.txt    serv-pro strategy instructions (plan and replan calls)
    seller_system.txt  serv-mini seller instructions (persona supplied per session)
data/
  agent-key.json       the agent's persistent Ed25519 keypair (demo key, mode 0600)
  sessions/            one append-only, hash-chained JSON transcript per session,
                       plus index.json naming the arena's default sessions
  ledger.json          savings ledger, one row per finished session
web/                   the arena: static page, no framework, no build step, works offline
  index.html  style.css  app.js  sample-sessions.js
```

The arena replays a session round by round: the mandate as a price ladder (list, target, ceiling, and the red zone past the ceiling), buyer and seller bubbles with price chips and move labels, reasoning traces under each buyer move, enforcement events as full-width rows, and a result banner computed from the session. Its integrity bar shows the mandate signature and chain status, with the Verify button described above.

## How to run

Requirements: Python 3, and an OpenServ API key configured through the project's connector client (`src/serv_client.py`). No other dependencies.

Run a negotiation (USD demo mandate: list $450, target $360, ceiling $390):

```bash
python3 src/engine.py --seller luluh --currency USD --lang en
```

Run one in Local Market Mode (IDR mandate: list Rp4.500.000, target Rp3.600.000, ceiling Rp3.900.000):

```bash
python3 src/engine.py --seller kepepet --currency IDR --lang id \
  --list 4500000 --target 3600000 --ceiling 3900000
```

Sellers: `keras`, `luluh`, `kepepet`. Each run writes a transcript to `data/sessions/` and appends a row to `data/ledger.json`.

Run a negotiation live from the arena: start the live server from the project root and open the page:

```bash
python3 server.py
# then open http://localhost:8077/web/
```

With `server.py` running, the arena's mandate form is active: fill in item, prices, seller, language, and currency, and the server validates the mandate and starts a real negotiation (`POST /run`) that you can watch event by event as the transcript grows. The halt button (`POST /halt`) is the kill switch for the running session. Judges with the repo can run real negotiations this way.

For replay only, any static host works, for example `python3 -m http.server 8000` from the project root. On static hosting there is no engine behind the page, so the live form disables itself with an honest note saying so, and the arena replays the recorded sessions. The latest real session loads automatically. Use the seller picker to replay the other sessions, or point the arena at any transcript with `?session=<path>`. If no live data is present it falls back to bundled sample sessions and labels them as demo data.

## Live results

Every row below is a real session run against the live SERV API on 2026-11-13. Full transcripts are in `data/sessions/`. The final three sessions run on the current engine, with signed mandates, hash-chained transcripts, and the strategy layer; the earlier nine predate the credibility layer and are kept on the record exactly as they ran.

USD mandate: list $450, target $360, ceiling $390.

| Seller | Outcome | Final price | Saved | Rounds | Notes |
|---|---|---|---|---|---|
| Bu Luluh | deal | $375 | $75 | 2 | closed at the seller's floor in round 2 |
| Pak Keras | no_deal | none | none | 8 | his floor ($415) sits above the ceiling; the buyer held at target all 8 rounds |
| Bu Luluh | no_deal | none | none | 8 | |
| Bu Luluh | walked_away | none | none | 8 | |
| Bu Luluh | no_deal | none | none | 8 | |
| Bu Luluh | no_deal | none | none | 8 | |
| Bu Luluh | deal | $390 | $60 | 8 | **hero session**, the arena default: signed mandate, strategy plan, closes at the ceiling on the final round; 19,084 tokens across 16 SERV calls |
| Bu Luluh | no_deal | none | none | 8 | **enforcement demo**: one `plan`, two `replan` events (a 3-reply no-concession streak, then a sudden large concession), and a real `seller_concession_capped` event — the seller tried to drop to $390 in one reply and the 35% cap limited the drop to $398 |
| Bu Luluh | no_deal | none | none | 8 | signed session with one `replan` |

IDR mandate: list Rp4.500.000, target Rp3.600.000, ceiling Rp3.900.000.

| Seller | Outcome | Final price | Saved | Rounds | Notes |
|---|---|---|---|---|---|
| Bu Luluh | deal | Rp3.900.000 | Rp600.000 | 8 | |
| Pak Keras | walked_away | none | none | 7 | froze far above the ceiling |
| Mas Kepepet (Bahasa Indonesia) | deal | Rp3.650.000 | Rp850.000 | 7 | the Local Market Mode proof point |

Totals: 12 sessions, 4 closed deals, $135 saved in USD and Rp1.450.000 saved in IDR, counted per currency. The failures are part of the record on purpose. Against Pak Keras, the seller froze far above the ceiling and Tawar held at target rather than chase. In one Bu Luluh USD run, the seller parked exactly at the $390 ceiling and the buyer refused to bridge the last $20 in the final round, so a closable deal ended as no_deal. That strictness is the product working as specified, and it is also the honest trade-off: a harder leash closes fewer deals at the margin.

## Limitations, stated plainly

- **The sellers are simulated agents**, played by serv-mini with hidden floor prices. No real marketplace, no real seller, and no real money is involved in this demo. The negotiation, the reasoning, the enforcement, and the ledger are real; the counterparty is a simulation.
- **No live `blocked_by_cap` transcript yet.** There is still no live blocked_by_cap transcript: in every recorded run the buyer held inside its mandate, so the refusal path is proven by unit tests (an over-ceiling deal is refused, an at-ceiling deal is allowed). To reproduce a live capture, run `python3 src/engine.py --seller keras --currency USD --lang en`, against the persona whose hidden floor ($415) sits above the $390 ceiling, so any close the buyer attempts in that session must cross the ceiling and be refused.
- **Demo scope.** One item category (a secondhand phone), three seller personas, a maximum of 8 rounds, two currencies, two languages. Live runs need the local `server.py`, because they spend real SERV credits; the hosted static arena is replay-only and says so on its form.
- **Model variance is real.** The same mandate against the same persona produced a 2-round deal at $375 once, an 8-round deal at $390 another time, and several 8-round no-deals. Tawar's guarantees are about the ceiling, which code enforces, not about always closing.
- **Roadmap.** Real marketplace integration (reading live listings, sending real offers through platform messaging with the owner's approval step), registering the agent identity with Kite's passport infrastructure instead of a local demo key, and more personas calibrated on real seller behavior are the next steps. None of that is in this submission.

## Why this matters

Haggling is where ordinary buyers lose money quietly: they are busy, embarrassed to push, or tired by round three. An agent has none of those problems, but an agent you cannot bound is a liability, not a tool. Tawar's position is that the limit is the product. The reasoning is visible, the ceiling is code, and the savings are written to a ledger anyone can check.

The revenue model follows from the ledger: Tawar keeps 10% of verified savings on closed deals, or a flat subscription for power buyers who negotiate often (resellers, procurement for small businesses, anyone furnishing a home from secondhand listings). On this ledger, the 10% cut equals $13.50 on the USD deals and Rp145.000 on the IDR deals. Because savings are measured per session, the fee can be charged on money the user provably did not spend.

## License and credit

Built during SERV Hackathon 02 by Ismaone. Negotiation and reasoning by SERV Reasoning (OpenServ). Track: 02 Kite.
