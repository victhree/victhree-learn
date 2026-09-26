# Mock-test site ↔ Course portal — hand-off for the victhree-mocks repo chat

Paste this into the **victhree-mocks** repo's chat. It makes the mock-test site
record each signed-in course student's result into the course portal, so the owner
can see mock performance per student in the console. The portal side is already
built and deployed.

Same pattern as the SSB integration. Keep anonymous practice working exactly as
today; only add the reporting when a course student is signed in.

## What the portal provides

- Backend Worker base URL: `https://victhree-portal.anmolxsharma.workers.dev`
- Login is a signed bearer token (from the portal). The mock site receives it via a
  URL fragment handoff and validates it, exactly like SSB.
- The portal already allows the mock site's origin (`https://victhree.github.io`)
  in CORS. If the mock site moves to a custom domain later, that origin must be
  added to the Worker's `ALLOWED_ORIGIN` variable.

### Endpoint to call

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/mock/attempt` | Bearer | record one completed mock result |
| GET | `/api/me` | Bearer | validate a handed-off token (optional) |

### `POST /api/mock/attempt` body
```json
{
  "test_id": "geo-sec-01",
  "test_title": "Geography sectional 1",
  "score": 34,
  "total": 40,
  "seconds": 1500
}
```
- `score`/`total` are marks; the portal computes the percentage (you may send
  `percent` directly instead). The student is taken from the token, never the body.
- Fire-and-forget: never block showing the result on this call; ignore failures.
- Every enrolled student (trial and full course) is recorded — the portal accepts
  any valid login token.

## Mock-site tasks

1. **Receive + store the login token (same as SSB).** On load, read
   `location.hash` for `#vt=<token>`, save it to `localStorage` under
   `vt_portal_token`, and strip the hash. (The portal's "Take the test" links and
   the Mock Tests tile now append `#vt=<token>` automatically.) If a stored token
   exists, treat the visitor as a signed-in course student. No token = anonymous,
   behave exactly as today.
   - If the SSB site's `assets/auth.js` already exists in your stack, reuse the
     same approach/key so a student is recognised across both.

2. **Post the result when a signed-in student finishes a mock.** At the point you
   already compute and show the final score, if a token is present, POST to
   `/api/mock/attempt` with `Authorization: Bearer <token>` and the body above
   (`test_id`, `test_title`, `score`, `total`, and `seconds` if you have it).

3. **Nothing else changes.** No UI change is required for students; the owner reads
   results in the portal console (Mock Tests tab).

## Owner action (portal side, not code)
- Run the `mock_attempts` table SQL in D1 and deploy the updated portal Worker
  (both already prepared on the portal side).
