# VicThree Learn — portal setup (do this when you have your accounts ready)

This portal is **two halves**:

- **Frontend** (this folder): static pages on GitHub Pages → `learn.victhreedefence.com`.
- **Backend** (`worker.js` + `schema.sql`): a Cloudflare Worker + D1 database on a `…workers.dev` URL.

You never edit secrets in the frontend. Secrets live only inside Cloudflare.

---

## The values you'll collect, and where each one goes

| Value | Where you get it | Where it goes |
|---|---|---|
| Bunny **Library ID** | Bunny → Stream → your library → API | Cloudflare var `BUNNY_LIBRARY_ID` |
| Bunny **Embed Token key** | Bunny library → Security → Embed View Token Auth | Cloudflare secret `BUNNY_EMBED_KEY` |
| Bunny **Storage zone name** | Bunny → Storage → your zone | Cloudflare var `BUNNY_STORAGE_ZONE` |
| Bunny **Storage host** | Bunny Storage zone (e.g. `storage.bunnycdn.com`) | Cloudflare var `BUNNY_STORAGE_HOST` |
| Bunny **Storage password** | Bunny Storage zone → FTP & API Access | Cloudflare secret `BUNNY_STORAGE_KEY` |
| **Resend API key** | resend.com → API Keys | Cloudflare secret `RESEND_KEY` |
| **From email** | your verified sender (or `onboarding@resend.dev` to start) | Cloudflare var `FROM_EMAIL` |
| **Session secret** | invent a long random string | Cloudflare secret `SESSION_SECRET` |
| **Admin key** | invent a long random string | Cloudflare secret `ADMIN_KEY` |
| **Portal URL** | `https://learn.victhreedefence.com` | Cloudflare var `ALLOWED_ORIGIN` |
| **Worker URL** | Cloudflare gives it after deploy | `assets/portal.js` → the `API` line |

---

## Step 1 — Bunny Stream (video)
1. **dash.bunny.net** → **Stream** → **Add Video Library** (or open your library). Note the **Library ID**.
2. Library → **Security** → turn ON **Embed View Token Authentication**. Copy the **token authentication key** → this is `BUNNY_EMBED_KEY`.
3. Upload your trial videos. For each, copy its **Video ID** (a GUID).
4. Open `worker.js` → the `LESSONS.trial` list → paste each Video ID into `video:` for Day 1–7, and set nice titles.

## Step 2 — Bunny Storage (the PDF notes)
1. Bunny → **Storage** → **Add Storage Zone** (e.g. `victhree-notes`). Note the **zone name** and **host** shown (e.g. `storage.bunnycdn.com`).
2. Zone → **FTP & API Access** → copy the **Password** → this is `BUNNY_STORAGE_KEY`.
3. Upload your PDFs into folders, e.g. `trial/day1.pdf`. Match those paths to `notes:` in `worker.js`.

## Step 3 — Resend (sends login codes)
1. **resend.com** → sign up (free) → **API Keys** → **Create** → copy it → `RESEND_KEY`.
2. To start, set `FROM_EMAIL` to `VicThree <onboarding@resend.dev>`. Later, verify `victhreedefence.com` in Resend and switch to `login@victhreedefence.com` for better delivery.

## Step 4 — Cloudflare D1 (database)
1. **dash.cloudflare.com** → **Workers & Pages** → **D1** → **Create database** → name it `victhree-learn`.
2. Open it → **Console** tab → paste all of `schema.sql` → **Run**. You should see the tables created.

## Step 5 — Cloudflare Worker (the backend)
1. **Workers & Pages** → **Create application** → **Create Worker** → name it e.g. `victhree-portal` → **Deploy** (the placeholder), then **Edit code**.
2. Delete the sample, paste **all of `worker.js`**, **Deploy**.
3. **Settings → Variables and Secrets:**
   - Under **Bindings**, add a **D1 database** binding named exactly **`DB`** → pick `victhree-learn`.
   - Add **Variables** (plain): `ALLOWED_ORIGIN`, `BUNNY_LIBRARY_ID`, `BUNNY_STORAGE_ZONE`, `BUNNY_STORAGE_HOST`, `FROM_EMAIL`.
   - Add **Secrets** (encrypted): `SESSION_SECRET`, `BUNNY_EMBED_KEY`, `BUNNY_STORAGE_KEY`, `RESEND_KEY`, `ADMIN_KEY`.
   - **Deploy** again after adding these.
4. Copy the Worker's URL (looks like `https://victhree-portal.<you>.workers.dev`).

## Step 6 — Point the frontend at the Worker
1. Open `assets/portal.js` → set `const API = "https://victhree-portal.<you>.workers.dev";`
2. (Content) confirm `worker.js` `LESSONS` has your real video IDs + notes paths, and re-Deploy the Worker if you changed it.

## Step 7 — Put the frontend online
1. Create a GitHub repo `victhree/victhree-learn`, push this folder, enable **Pages** (branch `main`, root).
2. **Custom domain** `learn.victhreedefence.com` → GitHub writes a `CNAME` file.
3. At **GoDaddy DNS**, add a record: **CNAME**, name `learn`, value `victhree.github.io`.
4. Wait for HTTPS, then set Cloudflare `ALLOWED_ORIGIN` to `https://learn.victhreedefence.com` and re-Deploy the Worker.
   *(Until the subdomain is live you can test by opening the pages locally and setting `ALLOWED_ORIGIN` to `*` temporarily.)*

## Step 8 — Add students
1. Open `admin.html`, enter your **ADMIN_KEY**.
2. Add a student: name, email, product = **trial**, start date = their Day 1. They can log in immediately.
3. To **upgrade** a trial student later: add them again with product = **course**.

---

## TESTS — do these before giving the link to any real student

1. **Login works:** add yourself as a test student → open `index.html` → enter your email → you get a code by email → enter it → land on the dashboard.
2. **Drip works:** set a test student's start date to **tomorrow** → Day 1 shows **locked** with an unlock time; set it to **today** → Day 1 is **Open now**.
3. **THE CRITICAL ONE — a logged-out person cannot reach a video:**
   - Log out (or open a private window). Open `dashboard.html` directly → it must bounce you to the login page.
   - Open `watch.html?day=1` directly while logged out → it must NOT play; it bounces to login.
   - In the browser Network tab, confirm the page never contains a `b-cdn.net` or `mediadelivery.net` URL until the Worker returns a signed one *after* login. There is no raw video URL in the page source.
4. **Locked day is truly blocked server-side:** while logged in, manually open `watch.html?day=7` before it has unlocked → the Worker returns 403 and no video loads (the block is in the Worker, not just hidden in the page).

---

## Honest limits (so nothing surprises you)
- Token protection stops downloading, hotlinking, and URL-sharing. It **cannot** stop someone screen-recording their own screen — no platform can. The email watermark on the player is a deterrent, not a wall.
- The login token lives in the browser's localStorage for 30 days; logging out clears it.
- This is Phase 1 (manual add via admin). Phase 2 adds the Razorpay webhook so payment auto-creates the student.
