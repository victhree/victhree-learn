/* =============================================================================
   VicThree Learn — course portal API  (single-file Cloudflare Worker)
   -----------------------------------------------------------------------------
   Paste this whole file into the Cloudflare dashboard Worker editor and Deploy.
   It is the SECURITY BOUNCER: every access check happens here, server-side.
   The frontend (GitHub Pages) never holds a video URL or any secret.

   ---- WHAT YOU MUST SET IN CLOUDFLARE (Settings -> Variables) -----------------
   D1 binding:
     DB                     -> your D1 database (binding name must be "DB")

   Plain variables (Settings -> Variables and Secrets -> add Variable):
     ALLOWED_ORIGIN         -> https://learn.victhreedefence.com   (your portal URL)
     BUNNY_LIBRARY_ID       -> your Bunny Stream library id (a number)
     BUNNY_STORAGE_ZONE     -> your Bunny Storage zone name (for the PDF notes)
     BUNNY_STORAGE_HOST     -> e.g. storage.bunnycdn.com  (or ny./la. regional host)
     FROM_EMAIL             -> e.g. "VicThree Defence <login@victhreedefence.com>"
                               (until your domain is verified in Resend, use
                                "VicThree <onboarding@resend.dev>")

   Secrets (Settings -> Variables and Secrets -> add Secret, i.e. encrypted):
     SESSION_SECRET         -> a long random string (sign login tokens)
     BUNNY_EMBED_KEY        -> Bunny library "Embed View Token Authentication" key
     BUNNY_STORAGE_KEY      -> Bunny Storage zone password/access key (for notes)
     RESEND_KEY             -> your Resend API key (re_...)
     ADMIN_KEY              -> a long random string; you type it into admin.html

   ---- THE COURSE CONTENT ------------------------------------------------------
   Edit the LESSONS manifest just below. Fill in each day's Bunny video id and
   the notes filename (the path inside your Bunny Storage zone). Add/remove days
   here whenever the course changes. This is the ONLY place content is defined.
   ============================================================================= */

const LESSONS = {
  // ---- The 1-week Geography trial (product = "trial") ----
  // Notes are OFF for now (notes:""). When you upload a day's PDF to Bunny
  // Storage (e.g. trial/day1.pdf), set its notes back to that path and the
  // "Open today's notes" button reappears for that day. Add days 6-11 here too.
  trial: [
    { day: 1, title: "The Universe and Earth's Interior", video: "cdcea11d-9803-433a-acc6-79ecacd67119", notes: "trial/day1.pdf", open: true },
    { day: 2, title: "Volcanism and Earthquakes",        video: "22950dfc-221a-4d0c-966b-af81b0ac7e90", notes: "trial/day2.pdf" },
    { day: 3, title: "Rocks and Weathering",             video: "04e32b4a-7ad2-40c1-8981-db364c32d51d", notes: "trial/day3.pdf" },
    { day: 4, title: "Atmosphere and Rainfall",          video: "738bc535-c548-4d5d-b6e5-8e909bea67f4", notes: "trial/day4.pdf" },
    { day: 5, title: "Winds and Jet Streams",            video: "48d597dc-2d0b-42fc-8e17-5bbdd67101fb", notes: "trial/day5.pdf" },
    { day: 6, title: "Cyclones and Indian Monsoon",      video: "4fc6f4ab-a9f6-4c5b-9cb3-917e5d4ab9ba", notes: "trial/day6.pdf" }
  ],
  // ---- The full 90-day course (product = "course") — Phase 2, fill later ----
  course: [
    // { day: 1, title: "…", video: "…", notes: "course/day1.pdf" },
  ]
};

// 07:00 India Standard Time, expressed as minutes past UTC midnight (IST = UTC+5:30)
// 07:00 IST = 01:30 UTC = 90 minutes.
const UNLOCK_MINUTES_UTC = 90;
const DAY_MS = 86400000;
const CODE_TTL_MS = 10 * 60 * 1000;      // login code valid 10 minutes
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // login lasts 30 days
const VIDEO_TOKEN_TTL_S = 300;           // signed video URL valid 5 minutes
const NOTES_LEAD_MS = 13 * 3600 * 1000;  // notes open 6 PM the evening before the 7 AM video (13 h earlier)

/* ---- Razorpay / auto-enrolment config -------------------------------------
   PRICES: the amount charged per product, in PAISE, set here on the server so
   the browser can never tamper with the price (₹999 = 99900). Update when your
   prices change.
   COURSE_BATCH_START: the fixed Day-1 date (IST, YYYY-MM-DD) that every FULL-
   COURSE buyer joins. Change this each time you open a new batch. Trial buyers
   always start on their payment date.
   Secrets to set in Cloudflare (Settings -> Variables and Secrets):
     RAZORPAY_KEY_ID        (Variable is fine; it is a publishable id)
     RAZORPAY_KEY_SECRET    (Secret)
     RAZORPAY_WEBHOOK_SECRET(Secret; the webhook signing secret you set in Razorpay)
--------------------------------------------------------------------------- */
const PRICES = {
  trial:   99900,  // ₹999    — Geography trial (6 days), drips from the payment date
  hero:   299900,  // ₹2,999  — self-paced full course, drips from the payment date
  elite:  849900,  // ₹8,499  — full course, live batch (starts COURSE_BATCH_START)
  legend:1199900   // ₹11,999 — full course, live batch; same portal content as elite
};
// Upgrade protection: a later, lower-tier payment never downgrades a higher tier.
const PRODUCT_RANK = { trial: 1, hero: 2, elite: 3, legend: 4 };
// Reverse lookup, so the webhook can still map a payment to a product by its amount
// if the product note is missing (prices are distinct, so this is unambiguous).
const AMOUNT_TO_PRODUCT = {}; Object.keys(PRICES).forEach(function (k) { AMOUNT_TO_PRODUCT[PRICES[k]] = k; });
// Which lesson set a product sees: the trial has its own; all paid tiers share "course".
function contentKey(product) { return product === "trial" ? "trial" : "course"; }
// Live full-course batches (standard/premium) start here; trial & self-paced start on
// the payment date. CHANGE this each time you open a new batch.
const COURSE_BATCH_START = "2026-11-01"; // TODO: set the next full-course batch Day 1 (IST)

// The 15 canonical Officer-Like Qualities. The SSB analysis reports strengths and
// weak points using ONLY these keys, so they can be tallied per student over time.
const OLQ_KEYS = [
  "effective_intelligence", "reasoning_ability", "organising_ability", "power_of_expression",
  "social_adaptability", "cooperation", "sense_of_responsibility",
  "initiative", "self_confidence", "speed_of_decision", "ability_to_influence_the_group",
  "liveliness", "determination", "courage", "stamina"
];
const OLQ_SET = new Set(OLQ_KEYS);

// Gatekeeper OLQs carry extra weight in SSB assessment. Of the six classic
// gatekeepers, five map to canonical OLQ keys; the sixth — "moral values" — is
// tracked via red_flags / the moral_red_flag metric, not as an OLQ key.
const GATEKEEPER_OLQS = new Set([
  "social_adaptability", "cooperation", "sense_of_responsibility", "liveliness", "courage"
]);

// --- SSB structured daily challenge (Elite / Legend) — scheduling skeleton ---
// This computes WHAT is due on a given challenge day, dripped from the course
// start date. The actual items come from the shared SSB content bank (pending),
// and submission/analysis sits on the engine contract (also pending).
const SSB_DAILY = { WAT: 5, SRT: 5 }; // every day
const SSB_TAT_EVERY = 7;              // TAT once a week
const SSB_SDT_EVERY = 14;             // SDT once a fortnight

// Shared SSB analysis engine (Gemini lives only inside it). Weekly analysis is a
// server-to-server call authed with env.ENGINE_SHARED_SECRET (a Worker secret —
// never hardcoded here). Content banks are static JSON on the SSB Pages site.
const ENGINE_BASE = "https://victhree-ssb-ai.anmolxsharma.workers.dev";
// The data path the github.io URL redirects to (skip the redirect hop).
const SSB_DATA_BASE = "https://ssb.victhreedefence.com/data";

// Only mentored tiers get the tracked SSB dashboard; Hero/trial use the open site.
function isMentored(user) { return !!user && (user.product === "elite" || user.product === "legend"); }

// day 1 = course start date; one challenge day per calendar day (07:00 IST unlock).
function ssbChallengePlan(startDate, nowMs) {
  const now = nowMs || Date.now();
  const dayIndex = Math.floor((now - unlockTime(startDate, 1)) / DAY_MS) + 1;
  if (dayIndex < 1) return { dayIndex: 0, available: false, unlockAt: unlockTime(startDate, 1), due: [] };
  const due = [{ mode: "WAT", count: SSB_DAILY.WAT }, { mode: "SRT", count: SSB_DAILY.SRT }];
  if (dayIndex % SSB_TAT_EVERY === 0) due.push({ mode: "TAT", count: 1 });
  if (dayIndex % SSB_SDT_EVERY === 0) due.push({ mode: "SDT", count: 1 });
  return { dayIndex, available: true, unlockAt: unlockTime(startDate, dayIndex), due };
}

/* ============================== ROUTER ==================================== */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsHeaders(env, request.headers.get("Origin") || "");

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (path === "/api/request-code" && request.method === "POST") return await requestCode(request, env, cors);
      if (path === "/api/verify"       && request.method === "POST") return await verifyCode(request, env, cors);
      if (path === "/api/me"           && request.method === "GET")  return await withAuth(request, env, cors, me, url, true);
      if (path === "/api/lessons"      && request.method === "GET")  return await withAuth(request, env, cors, lessons);
      if (path === "/api/video"        && request.method === "GET")  return await withAuth(request, env, cors, video, url);
      if (path === "/api/notes"        && request.method === "GET")  return await withAuth(request, env, cors, notes, url);
      if (path === "/api/ca"           && request.method === "GET")  return await withAuth(request, env, cors, caList, url);
      if (path === "/api/ca-file"      && request.method === "GET")  return await withAuth(request, env, cors, caFile, url);
      if (path === "/api/admin/add-student" && request.method === "POST") return await adminAddStudent(request, env, cors);
      if (path === "/api/admin/students"    && request.method === "GET")  return await adminListStudents(request, env, cors);
      // ---- SSB performance tracking ----
      if (path === "/api/ssb/free-register" && request.method === "POST") return await ssbFreeRegister(request, env, cors);
      if (path === "/api/ssb/allow"         && request.method === "GET")  return await withAuth(request, env, cors, ssbAllow, url, true);
      if (path === "/api/ssb/attempt"       && request.method === "POST") return await withAuth(request, env, cors, ssbAttempt, url, true);
      if (path === "/api/ssb/me"            && request.method === "GET")  return await withAuth(request, env, cors, ssbMe, url);
      if (path === "/api/ssb/challenge/today" && request.method === "GET") return await withAuth(request, env, cors, ssbChallengeToday, url);
      if (path === "/api/ssb/dashboard"     && request.method === "GET")  return await withAuth(request, env, cors, ssbDashboard, url);
      if (path === "/api/admin/ssb/roster"  && request.method === "GET")  return await adminSsbRoster(request, env, cors);
      if (path === "/api/admin/ssb/student" && request.method === "GET")  return await adminSsbStudent(request, env, cors, url);
      if (path === "/api/admin/ssb/run-weekly" && request.method === "POST") return await adminRunWeekly(request, env, cors, url);
      // ---- student doubts ----
      if (path === "/api/doubt"             && request.method === "POST") return await withAuth(request, env, cors, askDoubt, url);
      if (path === "/api/admin/doubts"      && request.method === "GET")  return await adminListDoubts(request, env, cors, url);
      if (path === "/api/admin/doubt-resolve" && request.method === "POST") return await adminResolveDoubt(request, env, cors);
      // ---- mock test results ----
      if (path === "/api/mock/attempt"      && request.method === "POST") return await withAuth(request, env, cors, mockAttempt, url);
      if (path === "/api/admin/mock/roster" && request.method === "GET")  return await adminMockRoster(request, env, cors);
      if (path === "/api/admin/mock/student"&& request.method === "GET")  return await adminMockStudent(request, env, cors, url);
      // ---- Razorpay payments / auto-enrolment ----
      if (path === "/api/pay/order"         && request.method === "POST") return await payOrder(request, env, cors);
      if (path === "/api/pay/webhook"       && request.method === "POST") return await payWebhook(request, env, cors);
      if (path === "/api/admin/payments"    && request.method === "GET")  return await adminPayments(request, env, cors);
      return json({ error: "not_found" }, 404, cors);
    } catch (e) {
      return json({ error: "server_error", detail: String((e && e.message) || e) }, 500, cors);
    }
  },

  // Cron Trigger (set a weekly schedule in the dashboard, e.g. Mon 03:00 IST =
  // "30 21 * * 0"): generate last week's report for every active Elite/Legend student.
  async scheduled(event, env, ctx) {
    const { fromMs, toMs } = lastCompletedWeekIST(Date.now());
    const studs = await env.DB.prepare(
      "SELECT id, name FROM students WHERE status = 'active' AND product IN ('elite','legend')"
    ).all();
    for (const s of (studs.results || [])) {
      try { await generateWeekly(env, s, fromMs, toMs); } catch (e) { /* skip this student, continue */ }
    }
  }
};

/* ============================== AUTH: LOGIN =============================== */

async function requestCode(request, env, cors) {
  const body = await readJson(request);
  const email = normEmail(body.email);
  if (!email) return json({ error: "bad_email" }, 400, cors);

  // Only enrolled, active students get a code. We ALWAYS return ok:true so an
  // outsider cannot use this endpoint to discover who is enrolled.
  const student = await env.DB.prepare(
    "SELECT id, name FROM students WHERE email = ? AND status = 'active'"
  ).bind(email).first();

  if (student) {
    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
    const codeHash = await sha256Hex(code + "|" + email + "|" + env.SESSION_SECRET);
    const expires = Date.now() + CODE_TTL_MS;
    await env.DB.prepare("DELETE FROM login_codes WHERE email = ?").bind(email).run();
    await env.DB.prepare(
      "INSERT INTO login_codes (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)"
    ).bind(email, codeHash, expires).run();
    await sendCodeEmail(env, email, code, student.name);
  }
  return json({ ok: true }, 200, cors);
}

async function verifyCode(request, env, cors) {
  const body = await readJson(request);
  const email = normEmail(body.email);
  const code = String(body.code || "").trim();
  if (!email || !/^\d{6}$/.test(code)) return json({ error: "bad_input" }, 400, cors);

  const row = await env.DB.prepare(
    "SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?"
  ).bind(email).first();

  if (!row || row.expires_at < Date.now() || row.attempts >= 5) {
    return json({ error: "invalid_or_expired" }, 401, cors);
  }
  const codeHash = await sha256Hex(code + "|" + email + "|" + env.SESSION_SECRET);
  if (codeHash !== row.code_hash) {
    await env.DB.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?").bind(email).run();
    return json({ error: "invalid_code" }, 401, cors);
  }
  await env.DB.prepare("DELETE FROM login_codes WHERE email = ?").bind(email).run();

  const student = await env.DB.prepare(
    "SELECT id, name, product, start_date FROM students WHERE email = ? AND status = 'active'"
  ).bind(email).first();
  if (!student) return json({ error: "not_enrolled" }, 403, cors);

  const token = await makeToken(env, student.id);
  return json({ token, name: student.name, product: student.product }, 200, cors);
}

// Wrap a handler so it only runs for a valid principal. Course students always
// pass; free (non-course) users pass only when allowFree is true. The handler
// receives a user object carrying a `tier` of "course" or "free".
async function withAuth(request, env, cors, handler, url, allowFree) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return json({ error: "no_token" }, 401, cors);
  const data = await verifyTokenData(env, m[1]);
  if (!data) return json({ error: "bad_token" }, 401, cors);

  // Free (non-course) user
  if (data.tier === "free" && data.fid) {
    if (!allowFree) return json({ error: "forbidden" }, 403, cors);
    const fu = await env.DB.prepare("SELECT id, email, name, phone FROM free_users WHERE id = ?").bind(data.fid).first();
    if (!fu) return json({ error: "bad_token" }, 401, cors);
    return await handler(env, cors, { tier: "free", id: fu.id, email: fu.email, name: fu.name, phone: fu.phone }, url, request);
  }

  // Course student (verified account)
  if (!data.sid) return json({ error: "bad_token" }, 401, cors);
  const student = await env.DB.prepare(
    "SELECT id, email, name, product, start_date, status FROM students WHERE id = ?"
  ).bind(data.sid).first();
  if (!student || student.status !== "active") return json({ error: "inactive" }, 403, cors);
  student.tier = "course";
  return await handler(env, cors, student, url, request);
}

/* ============================== STUDENT API ============================== */

async function me(env, cors, user) {
  if (user.tier === "free") return json({ email: user.email, name: user.name, tier: "free" }, 200, cors);
  return json({ email: user.email, name: user.name, product: user.product, tier: "course" }, 200, cors);
}

async function lessons(env, cors, student) {
  const list = LESSONS[contentKey(student.product)] || [];
  const now = Date.now();
  const out = list.map(l => {
    const videoUnlockAt = l.open ? 0 : unlockTime(student.start_date, l.day);
    const hasNotes = !!l.notes;
    const notesUnlockAt = hasNotes ? (videoUnlockAt - NOTES_LEAD_MS) : null;
    const availableAt = hasNotes ? notesUnlockAt : videoUnlockAt; // when the topic first opens
    return {
      day: l.day, title: l.title, hasNotes,
      videoUnlockAt, videoUnlocked: now >= videoUnlockAt,
      notesUnlockAt, notesUnlocked: hasNotes && now >= notesUnlockAt,
      availableAt, available: now >= availableAt
    };
  });
  return json({ product: student.product, startDate: student.start_date, lessons: out }, 200, cors);
}

async function video(env, cors, student, url) {
  const day = parseInt(url.searchParams.get("day"), 10);
  const lesson = (LESSONS[contentKey(student.product)] || []).find(l => l.day === day);
  if (!lesson) return json({ error: "no_such_day" }, 404, cors);

  const videoUnlockAt = lesson.open ? 0 : unlockTime(student.start_date, lesson.day);
  const hasNotes = !!lesson.notes;
  const notesUnlockAt = hasNotes ? (videoUnlockAt - NOTES_LEAD_MS) : null;
  const availableAt = hasNotes ? notesUnlockAt : videoUnlockAt;
  // Fully locked until the topic first opens (its notes time, or its video time if no notes).
  if (Date.now() < availableAt) return json({ error: "locked", unlockAt: availableAt }, 403, cors);

  const videoUnlocked = Date.now() >= videoUnlockAt;
  const notesUnlocked = hasNotes && Date.now() >= notesUnlockAt;

  // The signed Bunny embed is only issued once the 7 AM video unlock has passed.
  let embedUrl = null;
  if (videoUnlocked) {
    const expires = Math.floor(Date.now() / 1000) + VIDEO_TOKEN_TTL_S;
    const token = await sha256Hex(env.BUNNY_EMBED_KEY + lesson.video + expires);
    embedUrl = `https://iframe.mediadelivery.net/embed/${env.BUNNY_LIBRARY_ID}/${lesson.video}` +
               `?token=${token}&expires=${expires}&autoplay=false&preload=false`;
  }
  return json({ title: lesson.title, embedUrl, hasNotes, videoUnlocked, videoUnlockAt, notesUnlocked, notesUnlockAt }, 200, cors);
}

async function notes(env, cors, student, url) {
  const day = parseInt(url.searchParams.get("day"), 10);
  const lesson = (LESSONS[contentKey(student.product)] || []).find(l => l.day === day);
  if (!lesson || !lesson.notes) return json({ error: "no_notes" }, 404, cors);

  // Notes open 6 PM the evening before the video (13 h earlier); "open" topics are always available.
  const notesUnlockAt = lesson.open ? 0 : (unlockTime(student.start_date, lesson.day) - NOTES_LEAD_MS);
  if (Date.now() < notesUnlockAt) return json({ error: "locked", unlockAt: notesUnlockAt }, 403, cors);

  // Pull the PDF from Bunny Storage server-side; the student never sees the source.
  const srcUrl = `https://${env.BUNNY_STORAGE_HOST}/${env.BUNNY_STORAGE_ZONE}/${lesson.notes}`;
  const res = await fetch(srcUrl, { headers: { AccessKey: env.BUNNY_STORAGE_KEY } });
  if (!res.ok) return json({ error: "notes_unavailable", upstream: res.status }, 502, cors);

  const headers = new Headers(cors);
  headers.set("Content-Type", "application/pdf");
  headers.set("Content-Disposition", `inline; filename="day${day}.pdf"`);
  return new Response(res.body, { status: 200, headers });
}

/* ========================== CURRENT AFFAIRS ============================== */

// Lists the PDFs in the Bunny Storage "current-affairs/" folder. Open to every
// enrolled student (no drip). Upload a PDF there and it appears automatically.
async function caList(env, cors, student) {
  const listUrl = `https://${env.BUNNY_STORAGE_HOST}/${env.BUNNY_STORAGE_ZONE}/current-affairs/`;
  const res = await fetch(listUrl, { headers: { AccessKey: env.BUNNY_STORAGE_KEY } });
  if (!res.ok) return json({ issues: [], listStatus: res.status }, 200, cors);
  let items = [];
  try { items = await res.json(); } catch { items = []; }
  const issues = (items || [])
    .filter(o => o && !o.IsDirectory && /\.pdf$/i.test(o.ObjectName || ""))
    .map(o => ({ file: o.ObjectName, title: caTitle(o.ObjectName) }))
    .sort((a, b) => (a.file < b.file ? 1 : -1)); // newest filename first
  return json({ issues }, 200, cors);
}

// Streams one current-affairs PDF (open to all enrolled students).
async function caFile(env, cors, student, url) {
  const file = url.searchParams.get("file") || "";
  // Allow spaces/parentheses in the name, but block path separators and traversal.
  if (file.indexOf("/") !== -1 || file.indexOf("\\") !== -1 || file.indexOf("..") !== -1 || !/\.pdf$/i.test(file)) {
    return json({ error: "bad_file" }, 400, cors);
  }
  const srcUrl = `https://${env.BUNNY_STORAGE_HOST}/${env.BUNNY_STORAGE_ZONE}/current-affairs/${encodeURIComponent(file)}`;
  const res = await fetch(srcUrl, { headers: { AccessKey: env.BUNNY_STORAGE_KEY } });
  if (!res.ok) return json({ error: "unavailable" }, 502, cors);
  const headers = new Headers(cors);
  headers.set("Content-Type", "application/pdf");
  headers.set("Content-Disposition", `inline; filename="${file}"`);
  return new Response(res.body, { status: 200, headers });
}

// "2026-09.pdf" -> "September 2026"; otherwise a tidied filename.
function caTitle(name) {
  const base = String(name).replace(/\.pdf$/i, "");
  const m = base.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const mo = parseInt(m[2], 10);
    if (mo >= 1 && mo <= 12) return months[mo - 1] + " " + m[1];
  }
  return base; // otherwise use the filename as the title (e.g. "Defence Digest- April 2026")
}

/* ============================== ADMIN API ================================ */

function adminOk(request, env) {
  return env.ADMIN_KEY && request.headers.get("X-Admin-Key") === env.ADMIN_KEY;
}

async function adminAddStudent(request, env, cors) {
  if (!adminOk(request, env)) return json({ error: "forbidden" }, 403, cors);
  const b = await readJson(request);
  const email = normEmail(b.email);
  const name = String(b.name || "").trim();
  const product = PRICES.hasOwnProperty(b.product) ? b.product : "trial";
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(b.startDate || "") ? b.startDate : todayIST();
  if (!email || !name) return json({ error: "bad_input" }, 400, cors);

  // Upsert: add a new student, or re-activate / update an existing one (used for
  // the trial -> course upgrade too, by passing product = "course").
  await env.DB.prepare(
    `INSERT INTO students (email, name, product, status, start_date, created_at)
     VALUES (?, ?, ?, 'active', ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       name = excluded.name, product = excluded.product,
       status = 'active', start_date = excluded.start_date`
  ).bind(email, name, product, startDate, Date.now()).run();

  return json({ ok: true, email, product, startDate }, 200, cors);
}

async function adminListStudents(request, env, cors) {
  if (!adminOk(request, env)) return json({ error: "forbidden" }, 403, cors);
  const { results } = await env.DB.prepare(
    "SELECT email, name, product, status, start_date, created_at FROM students ORDER BY created_at DESC"
  ).all();
  const now = Date.now();
  const rows = (results || []).map(s => {
    const total = (LESSONS[contentKey(s.product)] || []).length;
    let currentDay = 0;
    for (let d = 1; d <= total; d++) if (now >= unlockTime(s.start_date, d)) currentDay = d;
    return { ...s, currentDay, totalDays: total };
  });
  return json({ students: rows }, 200, cors);
}

/* ========================= SSB TRACKING API ============================= */

// Keep only valid, unique canonical OLQ keys (defends against bad/forged input).
function cleanOlqs(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [], seen = new Set();
  for (const x of arr) {
    const k = String(x || "").trim().toLowerCase();
    if (OLQ_SET.has(k) && !seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out.slice(0, 15);
}
function clampInt(v, min, max) { v = parseInt(v, 10); if (isNaN(v)) return 0; return Math.max(min, Math.min(max, v)); }
function safeArr(s) { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } }
function safeObj(s) { try { const o = JSON.parse(s); return (o && typeof o === "object" && !Array.isArray(o)) ? o : null; } catch { return null; } }

// Red flags: serious integrity / disqualifying concerns from an SSB attempt.
// Kept as short, non-empty strings and capped so a bad payload can't bloat the row.
function cleanRedFlags(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    const s = String(x == null ? "" : x).trim().slice(0, 300);
    if (s) out.push(s);
    if (out.length >= 20) break;
  }
  return out;
}

// Free SSB modes (the only ones a free user may run).
const FREE_SSB_MODES = ["PPDT", "WAT", "SRT"];
const DAY24_MS = 24 * 3600 * 1000;

// Register / look up a free (non-course) SSB user by email; issue a signed free token.
async function ssbFreeRegister(request, env, cors) {
  const b = await readJson(request);
  const email = normEmail(b.email);
  const name = String(b.name || "").trim().slice(0, 120);
  const phone = String(b.phone || "").trim().slice(0, 24);
  if (!email) return json({ error: "bad_email" }, 400, cors);
  await env.DB.prepare(
    `INSERT INTO free_users (email, name, phone, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, phone = excluded.phone`
  ).bind(email, name, phone, Date.now()).run();
  const fu = await env.DB.prepare("SELECT id, name FROM free_users WHERE email = ?").bind(email).first();
  if (!fu) return json({ error: "server_error" }, 500, cors);
  const token = await makeFreeToken(env, fu.id);
  return json({ token, tier: "free", name: fu.name }, 200, cors);
}

// Is this user allowed to START a test of this mode right now?
async function ssbAllow(env, cors, user, url) {
  const mode = String(url.searchParams.get("mode") || "").toUpperCase();
  if (["WAT", "SRT", "SDT", "TAT", "PPDT", "GPE"].indexOf(mode) === -1) return json({ error: "bad_mode" }, 400, cors);
  if (user.tier === "course") return json({ allowed: true, tier: "course" }, 200, cors);
  // free tier
  if (FREE_SSB_MODES.indexOf(mode) === -1) return json({ allowed: false, reason: "locked", tier: "free" }, 200, cors);
  const since = Date.now() - DAY24_MS;
  const row = await env.DB.prepare(
    "SELECT MAX(created_at) AS last FROM ssb_free_attempts WHERE free_user_id = ? AND mode = ? AND created_at >= ?"
  ).bind(user.id, mode, since).first();
  if (row && row.last) {
    return json({ allowed: false, reason: "daily_limit", retry_after_ms: Math.max(0, (row.last + DAY24_MS) - Date.now()), tier: "free" }, 200, cors);
  }
  return json({ allowed: true, tier: "free" }, 200, cors);
}

// Record one completed SSB test attempt. Course users also update their rolling
// OLQ profile; free users are recorded minimally (for the per-mode/24h count).
async function ssbAttempt(env, cors, user, url, request) {
  const b = await readJson(request);
  const mode = String(b.mode || "").toUpperCase();
  if (["WAT", "SRT", "SDT", "TAT", "PPDT", "GPE"].indexOf(mode) === -1) return json({ error: "bad_mode" }, 400, cors);

  if (user.tier === "free") {
    if (FREE_SSB_MODES.indexOf(mode) === -1) return json({ error: "locked" }, 403, cors);
    await env.DB.prepare(
      "INSERT INTO ssb_free_attempts (free_user_id, mode, created_at) VALUES (?, ?, ?)"
    ).bind(user.id, mode, Date.now()).run();
    return json({ ok: true, tier: "free" }, 200, cors);
  }

  const reflected = cleanOlqs(b.reflected_keys);
  const work = cleanOlqs(b.work_keys);
  const redFlags = cleanRedFlags(b.red_flags);
  const summary = String(b.summary || "").slice(0, 2000);
  const itemsCount = clampInt(b.items_count, 0, 200);
  const attemptedCount = clampInt(b.attempted_count, 0, 200);
  const secondsUsed = clampInt(b.seconds_used, 0, 1000000);
  // Dashboard tracking data (present for course students from the SSB engine).
  const metrics = (b.metrics && typeof b.metrics === "object" && !Array.isArray(b.metrics)) ? b.metrics : null;
  const perItem = Array.isArray(b.per_item) ? b.per_item.slice(0, 60) : [];
  const now = Date.now();

  // Insert the session row first so we have its id to attach per-item rows.
  const ins = await env.DB.prepare(
    `INSERT INTO ssb_attempts
       (student_id, mode, created_at, items_count, attempted_count, seconds_used, summary, reflected_keys, work_keys, red_flags, metrics)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(user.id, mode, now, itemsCount, attemptedCount, secondsUsed, summary,
         JSON.stringify(reflected), JSON.stringify(work), JSON.stringify(redFlags),
         metrics ? JSON.stringify(metrics) : null).run();
  const sessionId = (ins && ins.meta) ? ins.meta.last_row_id : null;

  const stmts = [];

  // Store every response + its structured per-item analysis.
  perItem.forEach((pi, i) => {
    const n = clampInt((pi && pi.n != null) ? pi.n : (i + 1), 0, 1000);
    const resp = String((pi && pi.response) || "").slice(0, 2000);
    stmts.push(env.DB.prepare(
      "INSERT INTO ssb_items (session_id, student_id, mode, n, response, analysis, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(sessionId, user.id, mode, n, resp, JSON.stringify(pi || {}), now));
  });

  reflected.forEach(k => stmts.push(env.DB.prepare(
    `INSERT INTO ssb_olq_profile (student_id, olq, reflected_count, work_count, last_seen_at)
     VALUES (?, ?, 1, 0, ?)
     ON CONFLICT(student_id, olq) DO UPDATE SET reflected_count = reflected_count + 1, last_seen_at = excluded.last_seen_at`
  ).bind(user.id, k, now)));

  work.forEach(k => stmts.push(env.DB.prepare(
    `INSERT INTO ssb_olq_profile (student_id, olq, reflected_count, work_count, last_seen_at)
     VALUES (?, ?, 0, 1, ?)
     ON CONFLICT(student_id, olq) DO UPDATE SET work_count = work_count + 1, last_seen_at = excluded.last_seen_at`
  ).bind(user.id, k, now)));

  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, reflected, work, red_flags: redFlags, stored: true }, 200, cors);
}

// Build a student's SSB picture: rolling OLQ profile, recent attempts, and the
// 2-3 weakest OLQs to focus on. Shared by the student view and the admin view.
async function ssbProfileFor(env, id, forAdmin) {
  const prof = await env.DB.prepare(
    "SELECT olq, reflected_count, work_count, last_seen_at FROM ssb_olq_profile WHERE student_id = ?"
  ).bind(id).all();
  const profile = prof.results || [];

  const att = await env.DB.prepare(
    `SELECT id, mode, created_at, items_count, attempted_count, seconds_used, summary, reflected_keys, work_keys, red_flags
     FROM ssb_attempts WHERE student_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(id).all();
  const attempts = (att.results || []).map(a => {
    const o = {
      id: a.id, mode: a.mode, createdAt: a.created_at,
      itemsCount: a.items_count, attemptedCount: a.attempted_count, secondsUsed: a.seconds_used,
      summary: a.summary, reflected: safeArr(a.reflected_keys), work: safeArr(a.work_keys)
    };
    // Red flags are integrity concerns — only ever exposed in the admin (Anmol) view.
    if (forAdmin) o.redFlags = safeArr(a.red_flags);
    return o;
  });

  const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM ssb_attempts WHERE student_id = ?").bind(id).first();

  // Focus = OLQs most often flagged to work on (tiebreak: fewer times seen as a strength).
  const focus = profile.slice()
    .filter(p => p.work_count > 0)
    .sort((x, y) => (y.work_count - x.work_count) || (x.reflected_count - y.reflected_count))
    .slice(0, 3).map(p => p.olq);

  const countsByMode = {};
  attempts.forEach(a => { countsByMode[a.mode] = (countsByMode[a.mode] || 0) + 1; });

  const redFlagCount = forAdmin
    ? (att.results || []).reduce((n, a) => n + (safeArr(a.red_flags).length ? 1 : 0), 0)
    : 0;

  // Gatekeeper OLQ status (admin only): strong / developing / weak / untested,
  // from the rolling profile. A v1 heuristic; richer signal comes with metrics.
  const gatekeepers = forAdmin ? [...GATEKEEPER_OLQS].map(k => {
    const p = profile.find(x => x.olq === k) || {};
    const r = p.reflected_count || 0, w = p.work_count || 0;
    const status = (r + w === 0) ? "untested" : (w > r ? "weak" : (r > w ? "strong" : "developing"));
    return { olq: k, reflected: r, work: w, status };
  }) : undefined;

  return { profile, attempts, focus_olqs: focus, countsByMode, total: (c && c.n) || 0, redFlagCount, gatekeepers };
}

async function ssbMe(env, cors, student) {
  return json(await ssbProfileFor(env, student.id), 200, cors);
}

async function adminSsbRoster(request, env, cors) {
  if (!adminOk(request, env)) return json({ error: "forbidden" }, 403, cors);
  const res = await env.DB.prepare(
    `SELECT s.id, s.name, s.email, s.product,
            COUNT(a.id) AS attempts, MAX(a.created_at) AS last_at
     FROM students s LEFT JOIN ssb_attempts a ON a.student_id = s.id
     GROUP BY s.id ORDER BY last_at DESC`
  ).all();
  // Weakest OLQ per student (most-flagged to work on).
  const weak = await env.DB.prepare(
    "SELECT student_id, olq, work_count FROM ssb_olq_profile WHERE work_count > 0 ORDER BY student_id, work_count DESC"
  ).all();
  const topWeak = {};
  (weak.results || []).forEach(w => { if (!topWeak[w.student_id]) topWeak[w.student_id] = w.olq; });

  // Students with one or more attempts carrying a non-empty red_flags array.
  const rf = await env.DB.prepare(
    "SELECT DISTINCT student_id FROM ssb_attempts WHERE red_flags IS NOT NULL AND red_flags != '' AND red_flags != '[]'"
  ).all();
  const flagged = new Set((rf.results || []).map(r => r.student_id));

  // Students with a gatekeeper OLQ that shows up more as "to work on" than as a strength.
  const gk = await env.DB.prepare(
    `SELECT DISTINCT student_id FROM ssb_olq_profile
     WHERE olq IN ('social_adaptability','cooperation','sense_of_responsibility','liveliness','courage')
       AND work_count > reflected_count`
  ).all();
  const gkConcern = new Set((gk.results || []).map(r => r.student_id));

  const students = (res.results || []).map(s => ({
    id: s.id, name: s.name, email: s.email, product: s.product,
    attempts: s.attempts || 0, lastAt: s.last_at || null, topWeak: topWeak[s.id] || null,
    redFlag: flagged.has(s.id), gatekeeperConcern: gkConcern.has(s.id)
  }));
  return json({ students }, 200, cors);
}

async function adminSsbStudent(request, env, cors, url) {
  if (!adminOk(request, env)) return json({ error: "forbidden" }, 403, cors);
  const id = parseInt(url.searchParams.get("id"), 10);
  if (!id) return json({ error: "bad_id" }, 400, cors);
  const s = await env.DB.prepare("SELECT id, name, email, product FROM students WHERE id = ?").bind(id).first();
  if (!s) return json({ error: "no_such_student" }, 404, cors);
  const data = await ssbProfileFor(env, id, true);
  // Latest weekly admin report (full technical breakdown), if any.
  const wk = await env.DB.prepare(
    "SELECT week_start, admin_report, created_at FROM ssb_weekly_reports WHERE student_id = ? ORDER BY week_start DESC LIMIT 1"
  ).bind(id).first();
  const weekly = wk ? { weekStart: wk.week_start, report: safeObj(wk.admin_report), createdAt: wk.created_at } : null;
  return json({ student: s, ...data, weekly }, 200, cors);
}

// Pull a static content bank (cached at the edge). Returns [] on any failure.
async function fetchBank(name) {
  try {
    const res = await fetch(SSB_DATA_BASE + "/" + name + ".json", { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!res.ok) return [];
    const a = await res.json();
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
// Deterministic pick of `count` items starting at a seed offset (stable per day).
function pickN(arr, count, seed) {
  const out = [], len = arr.length;
  if (!len) return out;
  const start = ((seed % len) + len) % len;
  for (let i = 0; i < count && i < len; i++) out.push(arr[(start + i) % len]);
  return out;
}

// SSB dashboard — today's structured set for a mentored student: WHAT is due
// (dripped from course start) PLUS the actual items from the shared content bank,
// selected deterministically per day. `focus_olqs` is exposed for feedback-
// emphasis targeting (v1); item-level OLQ selection is Phase 2.
async function ssbChallengeToday(env, cors, user) {
  if (!isMentored(user)) return json({ error: "mentored_only" }, 403, cors);
  const plan = ssbChallengePlan(user.start_date);
  if (!plan.available) return json({ tier: user.product, startDate: user.start_date, plan, items: null, itemsReady: false }, 200, cors);

  const di = plan.dayIndex;
  const [wat, srt] = await Promise.all([fetchBank("wat"), fetchBank("srt")]);
  const items = {
    WAT: pickN(wat, SSB_DAILY.WAT, (di - 1) * SSB_DAILY.WAT).map(x => ({ id: x.id, word: x.word, type: x.type })),
    SRT: pickN(srt, SSB_DAILY.SRT, (di - 1) * SSB_DAILY.SRT).map(x => ({ id: x.id, tag: x.tag, situation: x.situation }))
  };
  if (di % SSB_TAT_EVERY === 0) {
    const tat = await fetchBank("tat");
    items.TAT = pickN(tat, 1, di).map(x => ({ id: x.id, image_url: x.image_url }));
  }
  if (di % SSB_SDT_EVERY === 0) {
    const sdt = await fetchBank("sdt");
    items.SDT = pickN(sdt, 1, di).map(x => ({ id: x.id, prompt: x.prompt }));
  }

  const prof = await env.DB.prepare(
    "SELECT olq, reflected_count, work_count FROM ssb_olq_profile WHERE student_id = ?"
  ).bind(user.id).all();
  const focus = (prof.results || [])
    .filter(p => (p.work_count || 0) > 0)
    .sort((a, b) => (b.work_count - a.work_count) || (a.reflected_count - b.reflected_count))
    .slice(0, 3).map(p => p.olq);

  return json({ tier: user.product, startDate: user.start_date, plan, items, focus_olqs: focus, itemsReady: true }, 200, cors);
}

/* ----- Weekly report (shared engine, server-to-server) ----- */

// Call the shared SSB engine's weekly analysis with the shared secret.
async function engineWeekly(env, payload) {
  const res = await fetch(ENGINE_BASE + "/analyze/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Engine-Key": env.ENGINE_SHARED_SECRET || "" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error("engine_weekly_" + res.status);
  return await res.json();
}

// Build + store a student's weekly report for [fromMs, toMs). Sends the week's
// already-analysed sessions (metrics + per_item) so the engine reasons over the
// week, not raw responses. Returns the engine output, or null if no sessions.
async function generateWeekly(env, student, fromMs, toMs) {
  const att = await env.DB.prepare(
    `SELECT id, mode, created_at, items_count, attempted_count, seconds_used,
            summary, reflected_keys, work_keys, red_flags, metrics
     FROM ssb_attempts WHERE student_id = ? AND created_at >= ? AND created_at < ?
     ORDER BY created_at ASC`
  ).bind(student.id, fromMs, toMs).all();
  const rows = att.results || [];
  if (!rows.length) return null;

  const it = await env.DB.prepare(
    `SELECT session_id, n, response, analysis FROM ssb_items
     WHERE student_id = ? AND created_at >= ? AND created_at < ? ORDER BY session_id, n`
  ).bind(student.id, fromMs, toMs).all();
  const itemsBySession = {};
  (it.results || []).forEach(r => {
    (itemsBySession[r.session_id] = itemsBySession[r.session_id] || [])
      .push(safeObj(r.analysis) || { n: r.n, response: r.response });
  });

  const sessions = rows.map(a => ({
    mode: a.mode, createdAt: a.created_at,
    items_count: a.items_count, attempted_count: a.attempted_count, seconds_used: a.seconds_used,
    summary: a.summary, reflected_keys: safeArr(a.reflected_keys), work_keys: safeArr(a.work_keys),
    red_flags: safeArr(a.red_flags), metrics: safeObj(a.metrics), per_item: itemsBySession[a.id] || []
  }));

  const prof = await env.DB.prepare(
    "SELECT olq, reflected_count, work_count, last_seen_at FROM ssb_olq_profile WHERE student_id = ?"
  ).bind(student.id).all();

  const out = await engineWeekly(env, {
    student: { id: String(student.id), name: student.name || "" },
    window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    olq_profile: prof.results || [],
    sessions
  });

  await env.DB.prepare(
    `INSERT INTO ssb_weekly_reports (student_id, week_start, student_report, admin_report, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(student_id, week_start) DO UPDATE SET
       student_report = excluded.student_report, admin_report = excluded.admin_report, created_at = excluded.created_at`
  ).bind(student.id, istDateStr(fromMs), JSON.stringify(out.studentReport || null), JSON.stringify(out.adminReport || null), Date.now()).run();
  return out;
}

// Student SSB dashboard (mentored): a simple trajectory + friendly trend
// indicators + the latest plain-language weekly report. No red flags, no OLQ
// jargon — those live in the admin view only.
async function ssbDashboard(env, cors, user) {
  if (!isMentored(user)) return json({ error: "mentored_only" }, 403, cors);
  const now = Date.now();
  const att = await env.DB.prepare(
    `SELECT mode, created_at, items_count, attempted_count, metrics
     FROM ssb_attempts WHERE student_id = ? ORDER BY created_at DESC LIMIT 60`
  ).bind(user.id).all();
  const rows = att.results || [];
  const sessions = rows.map(a => ({ mode: a.mode, at: a.created_at, items: a.items_count, attempted: a.attempted_count }));

  // Friendly this-week vs last-week trends (only when both weeks have data).
  const weekMs = 7 * DAY_MS;
  const thisWeek = rows.filter(a => a.created_at >= now - weekMs);
  const prevWeek = rows.filter(a => a.created_at >= now - 2 * weekMs && a.created_at < now - weekMs);
  const agg = (list, pick) => list.reduce((acc, a) => {
    const m = safeObj(a.metrics); const v = m ? pick(m) : null;
    return (v == null || isNaN(v)) ? acc : { s: acc.s + Number(v), n: acc.n + 1 };
  }, { s: 0, n: 0 });
  const trends = [];
  const tTry = agg(thisWeek, m => m.try_count), pTry = agg(prevWeek, m => m.try_count);
  if (tTry.n && pTry.n) trends.push({ label: "'try' usage", from: pTry.s, to: tTry.s, lowerIsBetter: true });
  const tSrt = agg(thisWeek, m => m.srt_completion_rate), pSrt = agg(prevWeek, m => m.srt_completion_rate);
  if (tSrt.n && pSrt.n) trends.push({ label: "SRT completion", unit: "%", higherIsBetter: true, from: Math.round(pSrt.s / pSrt.n * 100), to: Math.round(tSrt.s / tSrt.n * 100) });

  const wk = await env.DB.prepare(
    "SELECT week_start, student_report, created_at FROM ssb_weekly_reports WHERE student_id = ? ORDER BY week_start DESC LIMIT 1"
  ).bind(user.id).first();
  const weekly = wk ? { weekStart: wk.week_start, report: safeObj(wk.student_report), createdAt: wk.created_at } : null;

  return json({ tier: user.product, totalSessions: rows.length, sessions, trends, weekly }, 200, cors);
}

// Admin: manually (re)generate last week's report — for one student (?id=) or all
// active Elite/Legend students. Lets Anmol trigger a report without waiting for Cron.
async function adminRunWeekly(request, env, cors, url) {
  if (!adminOk(request, env)) return json({ error: "forbidden" }, 403, cors);
  const { fromMs, toMs } = lastCompletedWeekIST(Date.now());
  const id = parseInt(url.searchParams.get("id"), 10);
  if (id) {
    const s = await env.DB.prepare("SELECT id, name FROM students WHERE id = ?").bind(id).first();
    if (!s) return json({ error: "no_such_student" }, 404, cors);
    const out = await generateWeekly(env, s, fromMs, toMs);
    return json({ ok: true, generated: out ? 1 : 0, week: istDateStr(fromMs) }, 200, cors);
  }
  const studs = await env.DB.prepare(
    "SELECT id, name FROM students WHERE status = 'active' AND product IN ('elite','legend')"
  ).all();
  let n = 0;
  for (const s of (studs.results || [])) { try { if (await generateWeekly(env, s, fromMs, toMs)) n++; } catch (e) { /* skip */ } }
  return json({ ok: true, generated: n, week: istDateStr(fromMs) }, 200, cors);
}

/* ============================== DOUBTS API =============================== */

// A logged-in student submits a doubt from a lesson. We tag it with the topic
// (from the day number) so the owner can read doubts topic-wise.
async function askDoubt(env, cors, student, url, request) {
  const b = await readJson(request);
  const text = String(b.text || "").trim().slice(0, 2000);
  if (!text) return json({ error: "empty" }, 400, cors);
  let day = parseInt(b.day, 10); if (isNaN(day)) day = null;
  let topic = null;
  if (day != null) {
    const l = (LESSONS[contentKey(student.product)] || []).find(x => x.day === day);
    topic = l ? l.title : null;
  }
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO doubts (student_id, product, day, topic, text, status, created_at) VALUES (?, ?, ?, ?, ?, 'new', ?)"
  ).bind(student.id, student.product, day, topic, text, now).run();

  // Optional: email the owner a copy (only if ADMIN_EMAIL is set). Never fail the request.
  if (env.ADMIN_EMAIL) {
    const subj = "New doubt" + (day != null ? (" — Topic " + day + (topic ? (": " + topic) : "")) : "");
    const html =
      `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1c2331">` +
      `<p><b>${escapeHtml(student.name || "A student")}</b> (${escapeHtml(student.email)}) asked a doubt` +
      (day != null ? ` on <b>Topic ${day}${topic ? (": " + escapeHtml(topic)) : ""}</b>` : "") + `:</p>` +
      `<blockquote style="margin:0;padding:10px 14px;border-left:3px solid #C9A24B;background:#f5f7fb">${escapeHtml(text)}</blockquote>` +
      `<p style="color:#6b7a90;font-size:13px">Open your doubts page to reply.</p></div>`;
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": "Bearer " + env.RESEND_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.FROM_EMAIL, to: [env.ADMIN_EMAIL], subject: subj, html })
      });
    } catch (_) {}
  }
  return json({ ok: true }, 200, cors);
}

async function adminListDoubts(request, env, cors, url) {
  if (!adminOk(request, env)) return json({ error: "forbidden" }, 403, cors);
  const newOnly = url.searchParams.get("status") === "new";
  let sql =
    "SELECT d.id, d.day, d.topic, d.text, d.status, d.created_at, d.product, s.name, s.email " +
    "FROM doubts d LEFT JOIN students s ON s.id = d.student_id";
  if (newOnly) sql += " WHERE d.status = 'new'";
  sql += " ORDER BY d.created_at DESC LIMIT 500";
  const { results } = await env.DB.prepare(sql).all();
  return json({ doubts: results || [] }, 200, cors);
}

async function adminResolveDoubt(request, env, cors) {
  if (!adminOk(request, env)) return json({ error: "forbidden" }, 403, cors);
  const b = await readJson(request);
  const id = parseInt(b.id, 10);
  if (!id) return json({ error: "bad_id" }, 400, cors);
  const status = (b.status === "new") ? "new" : "resolved";
  await env.DB.prepare("UPDATE doubts SET status = ? WHERE id = ?").bind(status, id).run();
  return json({ ok: true }, 200, cors);
}

/* ============================== MOCK TESTS =============================== */

// A signed-in student's completed mock is recorded by the mock-test site here.
// student_id always comes from the token.
async function mockAttempt(env, cors, student, url, request) {
  const b = await readJson(request);
  const testId = String(b.test_id || "").slice(0, 80);
  const testTitle = String(b.test_title || "").slice(0, 200);
  let score = Number(b.score); if (!isFinite(score)) score = null;
  let total = Number(b.total); if (!isFinite(total) || total <= 0) total = null;
  let percent = Number(b.percent);
  if (!isFinite(percent)) percent = (score != null && total) ? Math.round((score / total) * 1000) / 10 : null;
  if (percent != null) percent = Math.max(0, Math.min(100, percent));
  const seconds = clampInt(b.seconds, 0, 1000000);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO mock_attempts (student_id, test_id, test_title, score, total, percent, seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(student.id, testId, testTitle, score, total, percent, seconds, now).run();
  return json({ ok: true }, 200, cors);
}

async function adminMockRoster(request, env, cors) {
  if (!adminOk(request, env)) return json({ error: "forbidden" }, 403, cors);
  const res = await env.DB.prepare(
    `SELECT s.id, s.name, s.email, s.product,
            COUNT(m.id) AS attempts, MAX(m.created_at) AS last_at,
            MAX(m.percent) AS best, AVG(m.percent) AS avg
     FROM students s LEFT JOIN mock_attempts m ON m.student_id = s.id
     GROUP BY s.id ORDER BY last_at DESC`
  ).all();
  const students = (res.results || []).map(s => ({
    id: s.id, name: s.name, email: s.email, product: s.product,
    attempts: s.attempts || 0, lastAt: s.last_at || null,
    best: (s.best != null) ? Math.round(s.best * 10) / 10 : null,
    avg: (s.avg != null) ? Math.round(s.avg * 10) / 10 : null
  }));
  return json({ students }, 200, cors);
}

async function adminMockStudent(request, env, cors, url) {
  if (!adminOk(request, env)) return json({ error: "forbidden" }, 403, cors);
  const id = parseInt(url.searchParams.get("id"), 10);
  if (!id) return json({ error: "bad_id" }, 400, cors);
  const s = await env.DB.prepare("SELECT id, name, email, product FROM students WHERE id = ?").bind(id).first();
  if (!s) return json({ error: "no_such_student" }, 404, cors);
  const att = await env.DB.prepare(
    "SELECT id, test_id, test_title, score, total, percent, seconds, created_at FROM mock_attempts WHERE student_id = ? ORDER BY created_at DESC LIMIT 100"
  ).bind(id).all();
  return json({ student: s, attempts: att.results || [] }, 200, cors);
}

/* ============================ RAZORPAY PAYMENTS ========================== */

// Called from the landing page BEFORE opening Razorpay Checkout. The browser
// sends only {product, name, email, contact}; the PRICE is decided here on the
// server from PRICES, so it cannot be tampered with. We create a Razorpay order
// carrying the product + buyer details in its notes, and return the order id so
// the page can open Checkout. The actual enrolment happens later in the webhook.
async function payOrder(request, env, cors) {
  const b = await readJson(request);
  const product = PRICES.hasOwnProperty(b.product) ? b.product : null;
  if (!product) return json({ error: "bad_product" }, 400, cors);
  const amount = PRICES[product];
  if (!amount || amount < 100) return json({ error: "price_not_set" }, 500, cors);
  const email = normEmail(b.email);
  const name = String(b.name || "").trim().slice(0, 120);
  const contact = String(b.contact || "").trim().slice(0, 20);
  if (!email || !name) return json({ error: "missing_details" }, 400, cors);

  const auth = "Basic " + btoa(env.RAZORPAY_KEY_ID + ":" + env.RAZORPAY_KEY_SECRET);
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { "Authorization": auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      amount, currency: "INR", receipt: "vt_" + Date.now(),
      notes: { product, name, email, contact }
    })
  });
  const order = await res.json().catch(() => null);
  if (!res.ok || !order || !order.id) {
    return json({ error: "order_failed", detail: (order && order.error && order.error.description) || res.status }, 502, cors);
  }
  return json({ orderId: order.id, amount, currency: "INR", keyId: env.RAZORPAY_KEY_ID, product, name, email, contact }, 200, cors);
}

// Razorpay calls this (server-to-server) on every event. We verify the HMAC
// signature against RAZORPAY_WEBHOOK_SECRET, then act only on a captured payment:
// log it (idempotently) and enrol/upgrade the student. Everything else is acked.
async function payWebhook(request, env, cors) {
  const raw = await request.text();
  const sig = request.headers.get("X-Razorpay-Signature") || "";
  const expected = await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, raw);
  if (!sig || !timingSafeEqual(expected, sig)) return json({ error: "bad_signature" }, 401, cors);

  let evt = null; try { evt = JSON.parse(raw); } catch { return json({ error: "bad_json" }, 400, cors); }
  const type = evt && evt.event;
  const P = (evt && evt.payload) || {};

  // Pull the payment entity, plus the "notes" and customer details from the right
  // place for each event. Order-based Checkout carries notes on the payment itself;
  // a Payment Link carries them on the payment_link entity (payment.notes is empty).
  let pay = null, notes = {}, custEmail = "", custName = "", custContact = "";
  if (type === "payment.captured" || type === "order.paid") {
    pay = P.payment && P.payment.entity;
    notes = (pay && pay.notes) || {};
  } else if (type === "payment_link.paid") {
    pay = P.payment && P.payment.entity;
    const link = (P.payment_link && P.payment_link.entity) || {};
    notes = link.notes || {};
    const cust = link.customer || {};
    custEmail = cust.email || ""; custName = cust.name || ""; custContact = cust.contact || "";
  }
  if (!pay || pay.status !== "captured") return json({ ok: true, ignored: type || "unknown" }, 200, cors);

  // Prefer the product note; fall back to mapping by amount (prices are distinct).
  let product = (notes.product && PRICES.hasOwnProperty(notes.product)) ? notes.product : null;
  if (!product) product = AMOUNT_TO_PRODUCT[pay.amount] || null;
  const email = normEmail(pay.email || notes.email || custEmail);
  const name = (String(notes.name || "").trim()) || custName || (email ? email.split("@")[0] : "Student");
  const contact = String(pay.contact || notes.contact || custContact || "");
  const now = Date.now();

  // Idempotency: if this payment id is already logged, do nothing further.
  const seen = await env.DB.prepare("SELECT id FROM payments WHERE payment_id = ?").bind(pay.id).first();
  if (seen) return json({ ok: true, duplicate: true }, 200, cors);

  // Always log the payment (even if we can't resolve a product) so it shows on the dashboard.
  await env.DB.prepare(
    "INSERT INTO payments (payment_id, order_id, email, name, contact, amount, currency, product, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).bind(pay.id, pay.order_id || null, email, name, contact, pay.amount || 0, pay.currency || "INR", product || "unknown", "captured", now).run();

  // Only auto-enrol when we know the product AND the email. Otherwise leave it for
  // manual handling (the payment is still visible on the dashboard).
  if (!email || !product) return json({ ok: true, logged: true, enrolled: false, reason: !email ? "no_email" : "unknown_product" }, 200, cors);

  // Full-course live tiers start on the batch date; trial & self-paced start today.
  const startDate = (product === "elite" || product === "legend") ? COURSE_BATCH_START : todayIST();

  // Enrol or upgrade, but never downgrade a higher tier the buyer already holds.
  const existing = await env.DB.prepare("SELECT product FROM students WHERE email = ?").bind(email).first();
  if (existing && (PRODUCT_RANK[existing.product] || 0) > (PRODUCT_RANK[product] || 0)) {
    await env.DB.prepare("UPDATE students SET status = 'active' WHERE email = ?").bind(email).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO students (email, name, product, status, start_date, created_at)
       VALUES (?, ?, ?, 'active', ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         name = excluded.name, product = excluded.product, status = 'active', start_date = excluded.start_date`
    ).bind(email, name, product, startDate, now).run();
  }
  return json({ ok: true, enrolled: email, product }, 200, cors);
}

// Admin: recent payments, for the revenue view on the control dashboard.
async function adminPayments(request, env, cors) {
  if (!adminOk(request, env)) return json({ error: "forbidden" }, 403, cors);
  const { results } = await env.DB.prepare(
    "SELECT payment_id, email, name, amount, currency, product, created_at FROM payments ORDER BY created_at DESC LIMIT 1000"
  ).all();
  return json({ payments: results || [] }, 200, cors);
}

/* ============================== HELPERS ================================== */

function unlockTime(startDate, dayNum) {
  // startDate is an IST calendar date "YYYY-MM-DD". Day 1 unlocks 07:00 IST that
  // day; day N unlocks 07:00 IST on startDate + (N-1) days.
  const [y, mo, d] = startDate.split("-").map(Number);
  const midnightUTC = Date.UTC(y, mo - 1, d);
  return midnightUTC + (dayNum - 1) * DAY_MS + UNLOCK_MINUTES_UTC * 60000;
}

function todayIST() {
  const nowIST = new Date(Date.now() + 330 * 60000); // shift into IST
  return nowIST.toISOString().slice(0, 10);
}
// The IST calendar date ('YYYY-MM-DD') for a given ms timestamp.
function istDateStr(ms) { return new Date((Number(ms) || 0) + 330 * 60000).toISOString().slice(0, 10); }
// The most-recently completed Monday→Monday week in IST, as [fromMs, toMs).
function lastCompletedWeekIST(nowMs) {
  const ist = new Date((nowMs || Date.now()) + 330 * 60000);
  const dow = (ist.getUTCDay() + 6) % 7; // Monday = 0
  const istMidnightShifted = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  const toMs = (istMidnightShifted - dow * DAY_MS) - 330 * 60000; // this week's Monday 00:00 IST, real UTC
  return { fromMs: toMs - 7 * DAY_MS, toMs };
}

async function makeToken(env, sid) {
  const payload = b64urlEncode(JSON.stringify({ sid, exp: Date.now() + SESSION_TTL_MS }));
  const sig = await hmac(env.SESSION_SECRET, payload);
  return payload + "." + sig;
}

// Free (non-course) SSB token. Carries a free_users id (fid) and tier:"free".
async function makeFreeToken(env, fid) {
  const payload = b64urlEncode(JSON.stringify({ fid, tier: "free", exp: Date.now() + SESSION_TTL_MS }));
  const sig = await hmac(env.SESSION_SECRET, payload);
  return payload + "." + sig;
}

// Verify HMAC + expiry and return the full decoded payload object (or null).
// A valid token must carry either a course sid or a free fid.
async function verifyTokenData(env, token) {
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;
  const expected = await hmac(env.SESSION_SECRET, parts[0]);
  if (!timingSafeEqual(expected, parts[1])) return null;
  try {
    const data = JSON.parse(b64urlDecode(parts[0]));
    if (!data.exp || data.exp < Date.now()) return null;
    if (!data.sid && !data.fid) return null;
    return data;
  } catch { return null; }
}

async function sendCodeEmail(env, email, code, name) {
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:16px;color:#1c2331">` +
    `<p>Hi ${escapeHtml(name || "there")},</p>` +
    `<p>Your VicThree Defence login code is:</p>` +
    `<p style="font-size:30px;font-weight:800;letter-spacing:5px;color:#0f2340">${code}</p>` +
    `<p>It is valid for 10 minutes. If you did not request this, you can ignore this email.</p>` +
    `<p>— VicThree Defence</p></div>`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.RESEND_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.FROM_EMAIL, to: [email], subject: "Your VicThree login code", html })
    });
  } catch (_) { /* never leak email-send failures to the caller */ }
}

/* ----- tiny crypto + http utilities ----- */

function corsHeaders(env, origin) {
  // ALLOWED_ORIGIN may be a comma-separated list; echo the request's origin if it's allowed.
  const list = String(env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  const allowed = list.length ? (list.indexOf(origin) !== -1 ? origin : list[0]) : (origin || "*");
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Admin-Key",
    "Vary": "Origin"
  };
}

function json(obj, status, cors) {
  const headers = new Headers(cors || {});
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(obj), { status: status || 200, headers });
}

async function readJson(request) { try { return await request.json(); } catch { return {}; } }
function normEmail(e) { return String(e || "").trim().toLowerCase(); }

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return b64urlFromBytes(new Uint8Array(sig));
}

// Same HMAC-SHA256 but hex-encoded (Razorpay signs webhooks as a hex digest).
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function b64urlFromBytes(bytes) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlEncode(str) { return b64urlFromBytes(new TextEncoder().encode(str)); }
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(str)));
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
