# SSB site ↔ Course portal integration — hand-off for the SSB repo chat

Paste this whole file into the **victhree-ssb** repo's Claude chat. It describes
what the course portal now provides, and the exact changes the SSB site needs.
The portal side (database + endpoints) is already built and deployed.

Constraints that still apply on the SSB side:
- Never show the words "AI" or "Gemini" to students. Keep calling it
  "performance analysis" / "performance report".
- No em-dashes in any student-facing copy.
- Keep SSB **hybrid**: anonymous visitors keep practising exactly as today. The
  tracking/personalisation layer only switches on when a course student is
  signed in. Nothing below should break the logged-out experience.

---

## What the portal provides

- **One backend Worker** (identity + storage), base URL:
  `https://victhree-portal.anmolxsharma.workers.dev`
- Login is email one-time-code. A successful login returns a **bearer token**
  (a signed string). The token is sent as `Authorization: Bearer <token>`.
- The SAME token works for both sites because one Worker signs and checks it.
- The portal will add `https://ssb.victhreedefence.com` to its allowed-origins
  list (owner action in Cloudflare), so the SSB site may call these endpoints.

### Portal endpoints the SSB site will call

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/request-code` | none | body `{email}` → emails a 6-digit code. Always returns `{ok:true}`. |
| POST | `/api/verify` | none | body `{email, code}` → `{token, name, product}` on success. |
| GET | `/api/me` | Bearer | `{email, name, product}` — use to validate a handed-off token. |
| GET | `/api/ssb/me` | Bearer | the student's SSB picture (see shape below). |
| POST | `/api/ssb/attempt` | Bearer | record one completed test (see shape below). |

### `GET /api/ssb/me` returns
```json
{
  "profile": [ { "olq": "initiative", "reflected_count": 4, "work_count": 1, "last_seen_at": 1690000000000 } ],
  "attempts": [ { "id": 12, "mode": "SRT", "createdAt": 1690000000000,
                  "itemsCount": 20, "attemptedCount": 20, "secondsUsed": 300,
                  "summary": "…", "reflected": ["courage"], "work": ["power_of_expression"] } ],
  "focus_olqs": ["power_of_expression", "social_adaptability"],
  "countsByMode": { "SRT": 3, "WAT": 2 },
  "total": 5
}
```
`focus_olqs` is the 2-3 weakest qualities. Use it to (a) steer the analysis
suggestions and (b) bias SRT question selection.

### `POST /api/ssb/attempt` expects
```json
{
  "mode": "SRT",
  "items_count": 20,
  "attempted_count": 20,
  "seconds_used": 300,
  "summary": "the personality snapshot text",
  "reflected_keys": ["courage", "initiative"],
  "work_keys": ["power_of_expression"]
}
```
The Worker ignores any student id you send; identity comes from the token.
We store the **summary and the qualities only** — not the word-for-word answers
(students keep their own downloaded PDF).

---

## The 15 canonical OLQ keys (use these EXACT strings)

```
effective_intelligence
reasoning_ability
organising_ability
power_of_expression
social_adaptability
cooperation
sense_of_responsibility
initiative
self_confidence
speed_of_decision
ability_to_influence_the_group
liveliness
determination
courage
stamina
```

---

## SSB-side task 1 — analysis Worker returns canonical keys + targets weak OLQs

File: `worker/worker.js` (the Gemini analysis Worker).

1. **Add two machine-readable fields to every mode's JSON output**, alongside the
   existing human-readable `olqs_reflected` / `olqs_to_work_on` (do NOT remove or
   change those; the on-screen report still uses them):
   ```
   "reflected_keys": ["<one or more of the 15 canonical keys>"],
   "work_keys":      ["<one or more of the 15 canonical keys>"]
   ```
   Update each prompt to instruct: "Also return `reflected_keys` and `work_keys`
   as arrays using ONLY these exact snake_case keys: <the 15 keys>. These must
   correspond to the strengths and weak points you described above."

2. **Accept an optional `focus_olqs` array in the request body.** When present,
   add to every prompt: "This candidate is currently weak on: <focus_olqs>. Where
   genuinely applicable, make your per-item `suggestion` show how the same
   response could have demonstrated these qualities. Do not force it where it does
   not fit, and never invent facts about the candidate." Pass it through to the
   picture modes too. This is what makes the report target the weak qualities for
   ALL test types.

Redeploy that Worker after the change. No new secrets needed.

## SSB-side task 2 — sign-in on the SSB site (new `assets/auth.js`)

Create `assets/auth.js`, loaded on the trainer pages before `trainer.js`. It must:

1. **Token handoff:** on load, check `location.hash` for `#vt=<token>`. If found,
   store it in `localStorage` under `vt_portal_token`, then strip the hash from
   the URL (so it is not shared or bookmarked with the token in it).
2. **Validate:** if a stored token exists, call `GET /api/me` on the portal
   Worker with `Authorization: Bearer <token>`. On 200, remember the student
   (`{name, email, product}`) in a global, e.g. `window.V3_STUDENT`. On 401,
   clear the stored token and treat the visitor as anonymous.
3. **Fallback login (optional but recommended):** if there is no valid token,
   expose a small "Sign in as a course student" affordance that runs the same
   email-code flow against the portal Worker (`/api/request-code` then
   `/api/verify`), stores the returned token under `vt_portal_token`, and sets
   `window.V3_STUDENT`. Anonymous practice must remain available without signing in.
4. Expose helpers: `V3.getToken()`, `V3.getStudent()`, `V3.isSignedIn()`.

Use the same token key name `vt_portal_token` the portal uses. (Different origin,
so it is a separate copy; that is fine.)

## SSB-side task 3 — trainer records attempts + requests targeted suggestions

File: `assets/trainer.js`.

1. **Before calling the analysis Worker (`requestAI`)**, if signed in, fetch
   `GET /api/ssb/me` once and keep `focus_olqs`. Include `focus_olqs` in the body
   POSTed to the analysis Worker (the analysis Worker now reads it — task 1.2).
2. **After the analysis renders successfully (`renderAI`)**, if signed in, POST to
   the portal `/api/ssb/attempt` with:
   - `mode` = `CFG.mode`
   - `items_count` = number of responses
   - `attempted_count` = responses with non-empty text
   - `seconds_used` = `S.formUsed` (form/image modes) or the summed per-item seconds
   - `summary` = the analysis `summary`
   - `reflected_keys` = the analysis `reflected_keys`
   - `work_keys` = the analysis `work_keys`
   Send `Authorization: Bearer <token>`. Do this quietly; never surface it to the
   student, and never block the report on it (fire-and-forget, ignore failures).
   The anonymous path stays exactly as it is today.

## SSB-side task 4 — make SRT adaptive (SRT only, for now)

File: `data/srt-practice.js` and the SRT practice page.

Fastest path (no need to hand-tag 500 items): map the existing dilemma `tag`
to the OLQs it stresses, using this starter map:

```
EMERGENCY     -> courage, speed_of_decision, initiative, stamina
ETHICAL       -> sense_of_responsibility, courage, determination
INTERPERSONAL -> social_adaptability, cooperation, power_of_expression
TEAM          -> cooperation, ability_to_influence_the_group, organising_ability
PERSONAL      -> determination, self_confidence, initiative
BIND          -> reasoning_ability, speed_of_decision, sense_of_responsibility
```

On the SRT practice page, if signed in and `focus_olqs` is known, bias selection
so roughly 60% of the chosen situations are ones whose mapped OLQs intersect the
student's `focus_olqs`, and fill the rest at random. If not signed in, selection
stays fully random (today's behaviour). Later you can hand-tag individual SRT
items with an `olqs: [...]` array for finer control; the map is the quick start.

Do NOT make the other tests pick different questions. They improve through the
smarter report (task 1.2), not through question selection.

## SSB-side task 5 — a light "signed in" strip

When `V3.isSignedIn()`, show a small non-intrusive strip on the SSB pages, for
example: "Signed in as <name>. Your performance is being tracked." with a link
to the portal progress page (`https://learn.victhreedefence.com/#ssb`). No AI
wording. Anonymous visitors see nothing extra.

---

## Owner action (not code) — done on the portal/Cloudflare side
- Add `https://ssb.victhreedefence.com` to the portal Worker's `ALLOWED_ORIGIN`
  variable (comma-separated). Until this is done, the SSB site's calls to the
  portal Worker will be blocked by the browser.
