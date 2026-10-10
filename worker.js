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

// Who gets the tracked SSB dashboard + in-portal trainer + weekly report. Trial is
// included so prospects experience the whole thing; Hero (self-paced) is excluded.
const SSB_DASH_PRODUCTS = ["trial", "elite", "legend"];
function canSeeSsb(user) { return !!user && SSB_DASH_PRODUCTS.indexOf(user.product) !== -1; }

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

/* ========== Daily challenge rotation (shared by SSB + English) ============ */
// Hero is excluded from the daily challenges; trial/elite/legend get them, i.e. the
// exact gate the SSB dashboard already uses.
const canSeeChallenges = canSeeSsb;

// English daily-challenge banks: one normalised JSON file per theme, served from the
// English Pages site. Each file: { theme, questions:[{id,theme,level,question,
// options[],answer(0-based),explanation,passageId?}], passages?:{ id:{level,text} } }.
const ENGLISH_DATA_BASE = "https://victhree.github.io/victhree-english/data/english-daily";

// The 13-week rotation, read by BOTH systems. One focus per week; a student's week is
// their calendar week since the Monday of their start week (1..13, then held at 13).
// english.level: 1 = standard, 2 = advanced, 0 = mixed (both). passage:true pulls one
// reading/cloze passage plus its questions instead of loose questions.
const CHALLENGE_SCHEDULE = [
  { ssb: { mode: "PPDT", perDay: 1 }, english: { label: "Synonyms and Antonyms", themes: ["synonyms", "antonyms"], level: 1, perDay: 10 } },
  { ssb: { mode: "WAT", perDay: 5 }, english: { label: "One-Word Substitution and Idioms", themes: ["one-word-substitution", "idioms"], level: 1, perDay: 10 } },
  { ssb: { mode: "SRT", perDay: 5 }, english: { label: "Confused Words, Spelling and Vocabulary in Context", themes: ["confused-words", "spelling", "vocab-in-context"], level: 1, perDay: 10 } },
  { ssb: { mode: "SDT", perDay: 1 }, english: { label: "Parts of Speech, Nouns and Pronouns", themes: ["nouns", "pronouns"], level: 1, perDay: 10 } },
  { ssb: { mode: "TAT", perDay: 1 }, english: { label: "Articles, Determiners, Adjectives and Degrees", themes: ["articles", "adjectives"], level: 1, perDay: 10 } },
  { ssb: { mode: "GPE", perWeek: 3 }, english: { label: "Verbs, Tenses and Subject-Verb Agreement", themes: ["verbs-tenses", "subject-verb-agreement"], level: 1, perDay: 10 } },
  { ssb: { mode: "PPDT", perDay: 1 }, english: { label: "Adverbs, Prepositions and Conjunctions", themes: ["adverbs", "prepositions", "conjunctions"], level: 2, perDay: 10 } },
  { ssb: { mode: "WAT", perDay: 5 }, english: { label: "Voice, Narration and Transformation", themes: ["voice", "narration"], level: 2, perDay: 10 } },
  { ssb: { mode: "SRT", perDay: 5 }, english: { label: "Spotting Errors and Sentence Improvement", themes: ["spotting-errors", "sentence-completion"], level: 2, perDay: 12 } },
  { ssb: { mode: "TAT", perDay: 1 }, english: { label: "Reading Comprehension and Cloze", themes: ["reading-comprehension", "cloze"], level: 2, perDay: 10, passage: true } },
  { ssb: { mode: "GPE", perWeek: 3 }, english: { label: "Sentence Completion, Ordering and Co-relationship", themes: ["sentence-completion", "ordering-of-words", "ordering-of-sentences"], level: 2, perDay: 10 } },
  { ssb: { mode: "MIX", perDay: 5, modes: ["WAT", "SRT", "TAT"] }, english: { label: "Mixed revision (all topics)", themes: ["synonyms", "antonyms", "idioms", "confused-words", "spotting-errors", "sentence-completion", "prepositions", "verbs-tenses"], level: 0, perDay: 15 } },
  { ssb: { mode: "MIX", perDay: 5, modes: ["WAT", "SRT", "TAT"] }, english: { label: "High-yield revision, exam style", themes: ["synonyms", "antonyms", "one-word-substitution", "idioms", "spotting-errors", "sentence-completion", "articles", "subject-verb-agreement"], level: 0, perDay: 15 } }
];
function scheduleForWeek(wk) { return CHALLENGE_SCHEDULE[Math.max(0, Math.min(12, (wk | 0) - 1))]; }

// Calendar-week helpers. A date string is an IST 'YYYY-MM-DD'; we align weeks to the
// Monday of the student's start week, so challenges, the rotation and the Monday cron
// all line up on Mon..Sun.
function dateMsUTC(dateStr) { const [y, m, d] = String(dateStr).split("-").map(Number); return Date.UTC(y, (m || 1) - 1, d || 1); }
function weekMondayMs(dateStr) { const ms = dateMsUTC(dateStr); const dow = (new Date(ms).getUTCDay() + 6) % 7; return ms - dow * DAY_MS; }
function challengeWeek(startDate, nowMs) {
  const a = weekMondayMs(startDate), b = weekMondayMs(istDateStr(nowMs || Date.now()));
  return Math.max(1, Math.min(13, Math.floor((b - a) / (7 * DAY_MS)) + 1));
}
function istWeekdayIndex(nowMs) { const ms = dateMsUTC(istDateStr(nowMs || Date.now())); return (new Date(ms).getUTCDay() + 6) % 7; } // 0=Mon..6=Sun

const ENG_THEME_LABELS = {
  "synonyms": "Synonyms", "antonyms": "Antonyms", "one-word-substitution": "One-Word Substitution",
  "idioms": "Idioms and Phrases", "confused-words": "Confused Words", "spelling": "Spelling",
  "vocab-in-context": "Vocabulary in Context", "nouns": "Nouns", "pronouns": "Pronouns",
  "articles": "Articles", "adjectives": "Adjectives and Degrees", "verbs-tenses": "Verbs and Tenses",
  "subject-verb-agreement": "Subject-Verb Agreement", "adverbs": "Adverbs", "prepositions": "Prepositions",
  "conjunctions": "Conjunctions", "voice": "Voice", "narration": "Narration",
  "spotting-errors": "Spotting Errors", "reading-comprehension": "Reading Comprehension",
  "ordering-of-words": "Ordering of Words", "ordering-of-sentences": "Ordering of Sentences",
  "cloze": "Cloze", "sentence-completion": "Sentence Completion"
};
function engThemeLabel(k) { return ENG_THEME_LABELS[k] || String(k || "").replace(/-/g, " "); }

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
      if (path === "/api/ssb/analyze"       && request.method === "POST") return await withAuth(request, env, cors, ssbAnalyze, url);
      if (path === "/api/ssb/dashboard"     && request.method === "GET")  return await withAuth(request, env, cors, ssbDashboard, url);
      // ---- Daily English challenge (trial/elite/legend; hero excluded) ----
      if (path === "/api/eng/challenge/today" && request.method === "GET")  return await withAuth(request, env, cors, engChallengeToday, url);
      if (path === "/api/eng/attempt"         && request.method === "POST") return await withAuth(request, env, cors, engAttempt, url);
      if (path === "/api/eng/dashboard"       && request.method === "GET")  return await withAuth(request, env, cors, engDashboard, url);
      if (path === "/api/admin/eng/roster"    && request.method === "GET")  return await adminEngRoster(request, env, cors);
      if (path === "/api/admin/eng/student"   && request.method === "GET")  return await adminEngStudent(request, env, cors, url);
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
      "SELECT id, name FROM students WHERE status = 'active' AND product IN ('trial','elite','legend')"
    ).all();
    for (const s of (studs.results || [])) {
      try { await generateWeekly(env, s, fromMs, toMs); } catch (e) { /* skip this student, continue */ }
      try { await generateEnglishWeekly(env, s, fromMs, toMs); } catch (e) { /* english report is independent */ }
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
    const prm = (pi && pi.prompt) ? String(pi.prompt).slice(0, 500) : null;
    stmts.push(env.DB.prepare(
      "INSERT INTO ssb_items (session_id, student_id, mode, n, prompt, response, analysis, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(sessionId, user.id, mode, n, prm, resp, JSON.stringify(pi || {}), now));
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

/* ----- Phase 2: real per-item OLQ-tagged selection (each item has `olqs`) ----- */

const TARGET_FRACTION = 0.65; // ~65% of the daily set targets the student's weak OLQs

// A student's weak OLQs, gatekeepers first, then by how often flagged "to work on".
function weakOlqsPrioritized(profileRows) {
  return (profileRows || [])
    .map(p => ({ olq: p.olq, work: p.work_count || 0, refl: p.reflected_count || 0 }))
    .filter(p => p.work > 0)
    .sort((a, b) => {
      const ag = GATEKEEPER_OLQS.has(a.olq) ? 1 : 0, bg = GATEKEEPER_OLQS.has(b.olq) ? 1 : 0;
      if (ag !== bg) return bg - ag;
      if (b.work !== a.work) return b.work - a.work;
      return a.refl - b.refl;
    })
    .map(p => p.olq);
}

// WAT variety fill: a deliberate valence mix (loaded N / positive P / neutral X).
function watVariety(wat, count, seed) {
  const buckets = { P: [], N: [], X: [] };
  wat.forEach(w => { if (buckets[w.type]) buckets[w.type].push(w); });
  const plan = [["N", 2], ["P", 2], ["X", 1]];
  const out = [], seen = new Set();
  plan.forEach(pc => pickN(buckets[pc[0]] || [], pc[1], seed * 3).forEach(w => { if (!seen.has(w.id)) { seen.add(w.id); out.push(w); } }));
  if (out.length < count) pickN(wat, count, seed * 7).forEach(w => { if (out.length < count && !seen.has(w.id)) { seen.add(w.id); out.push(w); } });
  return out.slice(0, count);
}

// SRT variety fill: spread across the situation themes for breadth.
function srtVariety(srt, count, seed) {
  const byTag = {};
  srt.forEach(x => { (byTag[x.tag || "_"] = byTag[x.tag || "_"] || []).push(x); });
  const tags = Object.keys(byTag);
  if (!tags.length) return pickN(srt, count, seed);
  const out = [], used = new Set();
  let ti = 0, guard = 0;
  while (out.length < count && guard < count * tags.length + 20) {
    const bucket = byTag[tags[ti % tags.length]];
    const start = ((seed % bucket.length) + bucket.length) % bucket.length;
    for (let k = 0; k < bucket.length; k++) {
      const cand = bucket[(start + k) % bucket.length];
      if (!used.has(cand.id)) { used.add(cand.id); out.push(cand); break; }
    }
    ti++; guard++;
  }
  return out.slice(0, count);
}

// Real per-item OLQ-tagged selection: ~TARGET_FRACTION of `count` items are drawn
// to cover the student's weakest OLQs (round-robin across them in priority order so
// it never narrows to one), the rest filled by `varietyPick`. Fallbacks keep the
// daily set always complete: no weak OLQs / too few matches -> pure variety; a final
// top-up guarantees `count` items. Deterministic per day; shifts with the profile.
function selectByOlq(bank, count, seed, weak, varietyPick) {
  const picked = [], used = new Set();
  const targetCount = weak.length ? Math.round(count * TARGET_FRACTION) : 0;

  let pass = 0;
  while (picked.length < targetCount && pass < count + 3) {
    let progressed = false;
    for (let i = 0; i < weak.length && picked.length < targetCount; i++) {
      const olq = weak[i];
      const cands = bank.filter(it => !used.has(it.id) && Array.isArray(it.olqs) && it.olqs.indexOf(olq) !== -1);
      if (!cands.length) continue;
      const idx = (((seed + pass) % cands.length) + cands.length) % cands.length;
      const ch = cands[idx];
      used.add(ch.id); picked.push(ch); progressed = true;
    }
    pass++;
    if (!progressed) break;
  }

  if (picked.length < count) {
    varietyPick(bank.filter(it => !used.has(it.id)), count - picked.length, seed)
      .forEach(it => { if (picked.length < count && !used.has(it.id)) { used.add(it.id); picked.push(it); } });
  }
  if (picked.length < count) {
    pickN(bank.filter(it => !used.has(it.id)), count - picked.length, seed + 13)
      .forEach(it => { if (picked.length < count) { used.add(it.id); picked.push(it); } });
  }
  return picked.slice(0, count);
}

// SSB dashboard — today's structured set for a mentored student, driven by the shared
// 13-week rotation: the student's calendar week picks the SSB mode (PPDT, WAT, SRT,
// SDT, TAT, GPE, or a mixed revision set). WAT/SRT stay OLQ-adaptive (~65% of items
// cover the weakest OLQs). SDT runs one of the five fixed questions per weekday; GPE is
// a weekly task (same scenarios all week). Stable per day; shifts as the profile moves.
async function ssbChallengeToday(env, cors, user) {
  if (!canSeeSsb(user)) return json({ error: "no_ssb_access" }, 403, cors);
  const plan = ssbChallengePlan(user.start_date);
  if (!plan.available) return json({ tier: user.product, startDate: user.start_date, plan, items: null, itemsReady: false }, 200, cors);

  const di = plan.dayIndex;
  const week = challengeWeek(user.start_date);
  const sched = scheduleForWeek(week).ssb;
  const wd = istWeekdayIndex(); // 0=Mon..6=Sun (for SDT's one-question-per-weekday)

  // Weakest OLQs (gatekeepers first) drive WAT/SRT selection and the emphasis.
  const prof = await env.DB.prepare(
    "SELECT olq, reflected_count, work_count FROM ssb_olq_profile WHERE student_id = ?"
  ).bind(user.id).all();
  const weak = weakOlqsPrioritized(prof.results || []);
  const focus = weak.slice(0, 3);

  const items = {};
  const due = [];
  const coverage = []; // WAT/SRT items whose olqs feed `targeting`

  async function addWAT(count, seed) { const wat = await fetchBank("wat"); const sel = selectByOlq(wat, count, seed, weak, watVariety); items.WAT = sel.map(x => ({ id: x.id, word: x.word, type: x.type, olqs: x.olqs || [] })); if (items.WAT.length) due.push({ mode: "WAT", count: items.WAT.length }); return sel; }
  async function addSRT(count, seed) { const srt = await fetchBank("srt"); const sel = selectByOlq(srt, count, seed, weak, srtVariety); items.SRT = sel.map(x => ({ id: x.id, tag: x.tag, situation: x.situation, olqs: x.olqs || [] })); if (items.SRT.length) due.push({ mode: "SRT", count: items.SRT.length }); return sel; }
  async function addTAT(count, seed) { const tat = await fetchBank("tat"); items.TAT = pickN(tat, count, seed).map(x => ({ id: x.id, image_url: x.image_url })); if (items.TAT.length) due.push({ mode: "TAT", count: items.TAT.length }); }
  async function addPPDT(count, seed) { const p = await fetchBank("ppdt"); items.PPDT = pickN(p, count, seed).map(x => ({ id: x.id, image_url: x.image_url })); if (items.PPDT.length) due.push({ mode: "PPDT", count: items.PPDT.length }); }
  async function addSDT() { const sdt = await fetchBank("sdt"); const idx = Math.min(4, Math.max(0, wd)); const one = sdt[idx] || pickN(sdt, 1, di)[0]; items.SDT = one ? [{ id: one.id, prompt: one.prompt }] : []; if (items.SDT.length) due.push({ mode: "SDT", count: 1 }); }
  async function addGPE(count, seed) { const g = await fetchBank("gpe"); items.GPE = pickN(g, count, seed).map(x => ({ id: x.id, title: x.title, tag: x.tag, deadline: x.deadline, scenario: x.scenario })); if (items.GPE.length) due.push({ mode: "GPE", count: items.GPE.length }); }

  if (sched.mode === "MIX") {
    // Revision weeks: an exam-style mixed set (two words, two situations, one picture story).
    const w = await addWAT(2, di);
    const s = await addSRT(2, di + 5);
    await addTAT(1, di + 11);
    w.forEach(x => coverage.push(x)); s.forEach(x => coverage.push(x));
  } else if (sched.mode === "WAT") {
    (await addWAT(sched.perDay, di)).forEach(x => coverage.push(x));
  } else if (sched.mode === "SRT") {
    (await addSRT(sched.perDay, di)).forEach(x => coverage.push(x));
  } else if (sched.mode === "TAT") {
    await addTAT(sched.perDay || 1, di);
  } else if (sched.mode === "PPDT") {
    await addPPDT(sched.perDay || 1, di);
  } else if (sched.mode === "SDT") {
    await addSDT();
  } else if (sched.mode === "GPE") {
    await addGPE(sched.perWeek || 2, 1000 + week); // same scenarios across the week
  }

  plan.due = due; // reflect this week's focus in the dashboard challenge card

  const covered = new Set();
  coverage.forEach(it => (it.olqs || []).forEach(o => { if (focus.indexOf(o) !== -1) covered.add(o); }));
  const targeting = Array.from(covered);

  return json({ tier: user.product, startDate: user.start_date, week, focusMode: sched.mode, plan, items, focus_olqs: focus, targeting, itemsReady: true }, 200, cors);
}

// Store one completed course SSB session (engine analysis `data` + the raw `items`).
// Shared by the in-portal trainer. Mirrors the course branch of ssbAttempt.
async function storeCourseSession(env, user, mode, data, items) {
  const reflected = cleanOlqs(data.reflected_keys);
  const work = cleanOlqs(data.work_keys);
  const redFlags = cleanRedFlags(data.red_flags);
  const summary = String(data.summary || "").slice(0, 2000);
  const metrics = (data.metrics && typeof data.metrics === "object" && !Array.isArray(data.metrics)) ? data.metrics : null;
  const perItem = Array.isArray(data.per_item) ? data.per_item.slice(0, 60) : [];
  const itemsCount = (metrics && metrics.items_count != null) ? clampInt(metrics.items_count, 0, 200) : items.length;
  const attemptedCount = (metrics && metrics.attempted_count != null) ? clampInt(metrics.attempted_count, 0, 200) : items.filter(it => it.response && it.response.trim()).length;
  const secondsUsed = items.reduce((a, it) => a + (it.seconds || 0), 0);
  const now = Date.now();

  const ins = await env.DB.prepare(
    `INSERT INTO ssb_attempts
       (student_id, mode, created_at, items_count, attempted_count, seconds_used, summary, reflected_keys, work_keys, red_flags, metrics)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(user.id, mode, now, itemsCount, attemptedCount, secondsUsed, summary,
         JSON.stringify(reflected), JSON.stringify(work), JSON.stringify(redFlags),
         metrics ? JSON.stringify(metrics) : null).run();
  const sessionId = (ins && ins.meta) ? ins.meta.last_row_id : null;

  const stmts = [];
  perItem.forEach((pi, i) => {
    const n = clampInt((pi && pi.n != null) ? pi.n : (i + 1), 0, 1000);
    const resp = String((pi && pi.response) || "").slice(0, 2000);
    const src = items[i] || {};
    const prm = (src.prompt || (pi && pi.prompt)) ? String(src.prompt || pi.prompt).slice(0, 500) : null;
    stmts.push(env.DB.prepare(
      "INSERT INTO ssb_items (session_id, student_id, mode, n, prompt, response, analysis, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(sessionId, user.id, mode, n, prm, resp, JSON.stringify(pi || {}), now));
  });
  reflected.forEach(k => stmts.push(env.DB.prepare(
    `INSERT INTO ssb_olq_profile (student_id, olq, reflected_count, work_count, last_seen_at)
     VALUES (?, ?, 1, 0, ?) ON CONFLICT(student_id, olq) DO UPDATE SET reflected_count = reflected_count + 1, last_seen_at = excluded.last_seen_at`
  ).bind(user.id, k, now)));
  work.forEach(k => stmts.push(env.DB.prepare(
    `INSERT INTO ssb_olq_profile (student_id, olq, reflected_count, work_count, last_seen_at)
     VALUES (?, ?, 0, 1, ?) ON CONFLICT(student_id, olq) DO UPDATE SET work_count = work_count + 1, last_seen_at = excluded.last_seen_at`
  ).bind(user.id, k, now)));
  if (stmts.length) await env.DB.batch(stmts);
  return sessionId;
}

// In-portal SSB trainer: the student's responses come in, the portal calls the
// shared engine server-to-server (Gemini key never touches the browser), stores
// the scored session, and returns the analysis so the trainer can show feedback.
async function ssbAnalyze(env, cors, user, url, request) {
  if (!canSeeSsb(user)) return json({ error: "no_ssb_access" }, 403, cors);
  const b = await readJson(request);
  const mode = String(b.mode || "").toUpperCase();
  if (["WAT", "SRT", "SDT", "TAT", "PPDT", "GPE"].indexOf(mode) === -1) return json({ error: "bad_mode" }, 400, cors);
  const items = Array.isArray(b.items) ? b.items.slice(0, 30).map((it, i) => ({
    n: (it && it.n != null) ? it.n : i + 1,
    prompt: String((it && it.prompt) || "").slice(0, 500),
    title: (it && it.title) ? String(it.title).slice(0, 200) : undefined,
    tag: (it && it.tag) ? String(it.tag).slice(0, 40) : undefined,
    response: String((it && it.response) || "").slice(0, 2000),
    seconds: clampInt(it && it.seconds, 0, 100000)
  })) : [];
  if (!items.length) return json({ error: "no_items" }, 400, cors);
  const focus = cleanOlqs(b.focus_olqs);

  let data;
  try {
    const res = await fetch(ENGINE_BASE + "/analyze/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Engine-Key": env.ENGINE_SHARED_SECRET || "" },
      body: JSON.stringify({ mode, items, focus_olqs: focus })
    });
    if (!res.ok) return json({ error: "engine_error", status: res.status }, 502, cors);
    data = await res.json();
  } catch (e) {
    return json({ error: "engine_unreachable" }, 502, cors);
  }

  try { await storeCourseSession(env, user, mode, data || {}, items); } catch (e) { /* still return feedback */ }
  return json({ ok: true, analysis: data }, 200, cors);
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
// Student SSB dashboard: text-first. One chart (the OLQ radar, the student's own
// shape), the rest plain language. No invented scores, no sparkline graphics.
const SSB_RADAR = [
  ["cooperation", "Cooperation"], ["courage", "Courage"], ["social_adaptability", "Social adaptability"],
  ["sense_of_responsibility", "Responsibility"], ["power_of_expression", "Expression"], ["reasoning_ability", "Reasoning"]
];
async function ssbDashboard(env, cors, user) {
  if (!canSeeSsb(user)) return json({ error: "no_ssb_access" }, 403, cors);
  const now = Date.now();
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

  const att = await env.DB.prepare(
    `SELECT mode, created_at, items_count, attempted_count, reflected_keys, work_keys, metrics
     FROM ssb_attempts WHERE student_id = ? ORDER BY created_at DESC LIMIT 200`
  ).bind(user.id).all();
  const rows = att.results || [];
  const total = rows.length;
  const sessions = rows.map(a => ({ mode: a.mode, at: a.created_at, items: a.items_count, attempted: a.attempted_count }));

  // OLQ profile -> radar (own shape, 1..10; no target line).
  const prof = await env.DB.prepare(
    "SELECT olq, reflected_count, work_count FROM ssb_olq_profile WHERE student_id = ?"
  ).bind(user.id).all();
  const prrows = prof.results || [];
  const pmap = {}; prrows.forEach(p => { pmap[p.olq] = p; });
  const olqScore = k => { const p = pmap[k] || {}; const r = p.reflected_count || 0, w = p.work_count || 0; return (r + w === 0) ? 5 : Math.max(1, Math.min(10, Math.round(10 * (r + 0.5) / (r + w + 1)))); };
  const radar = SSB_RADAR.map(x => ({ olq: x[0], label: x[1], value: olqScore(x[0]) }));
  const labelOf = k => { const f = SSB_RADAR.find(x => x[0] === k); return f ? f[1].toLowerCase() : k.replace(/_/g, " "); };

  // This week vs last week metric aggregates (used for status + movement ticker).
  const weekMs = 7 * DAY_MS;
  const thisWeek = rows.filter(a => a.created_at >= now - weekMs);
  const prevWeek = rows.filter(a => a.created_at >= now - 2 * weekMs && a.created_at < now - weekMs);
  const agg = (list, pick) => list.reduce((acc, a) => { const m = safeObj(a.metrics); const v = m ? pick(m) : null; return (v == null || isNaN(v)) ? acc : { s: acc.s + Number(v), n: acc.n + 1 }; }, { s: 0, n: 0 });
  const tTry = agg(thisWeek, m => m.try_count), pTry = agg(prevWeek, m => m.try_count);
  const tSrt = agg(thisWeek, m => m.srt_completion_rate), pSrt = agg(prevWeek, m => m.srt_completion_rate);
  const improvingCount = (tTry.n && pTry.n && tTry.s < pTry.s ? 1 : 0) + (tSrt.n && pSrt.n && (tSrt.s / tSrt.n) > (pSrt.s / pSrt.n) ? 1 : 0);

  // The qualities that matter most, as one plain line.
  const strengths = prrows.filter(p => (p.reflected_count || 0) > (p.work_count || 0))
    .sort((a, b) => ((b.reflected_count - b.work_count) - (a.reflected_count - a.work_count)));
  const weak = weakOlqsPrioritized(prrows);
  let qualitiesNote = "";
  const sParts = strengths.slice(0, 2).map(p => labelOf(p.olq));
  if (sParts.length === 2) qualitiesNote = cap(sParts[0]) + " and " + sParts[1] + " are real strengths.";
  else if (sParts.length === 1) qualitiesNote = cap(sParts[0]) + " is a real strength.";
  if (weak.length) qualitiesNote += (qualitiesNote ? " " : "") + cap(labelOf(weak[0])) + " needs the most attention.";

  // Rotating movement highlights: OLQ point changes (recent 14 days vs the prior 14)
  // plus a metric move or two, with evergreen strengths so the ticker is never empty.
  const wcounts = pred => { const c = {}; rows.forEach(a => { if (!pred(a)) return; safeArr(a.reflected_keys).forEach(k => { (c[k] = c[k] || { r: 0, w: 0 }).r++; }); safeArr(a.work_keys).forEach(k => { (c[k] = c[k] || { r: 0, w: 0 }).w++; }); }); return c; };
  const twoW = 14 * DAY_MS;
  const recentC = wcounts(a => a.created_at >= now - twoW);
  const priorC = wcounts(a => a.created_at >= now - 2 * twoW && a.created_at < now - twoW);
  const scoreC = c => { if (!c) return null; const r = c.r || 0, w = c.w || 0; return (r + w === 0) ? null : Math.max(1, Math.min(10, Math.round(10 * (r + 0.5) / (r + w + 1)))); };
  const movements = [];
  SSB_RADAR.forEach(x => { const sN = scoreC(recentC[x[0]]), sP = scoreC(priorC[x[0]]); if (sN != null && sP != null && sN !== sP) { const dd = sN - sP; movements.push(x[1] + (dd > 0 ? " up " : " down ") + Math.abs(dd) + " point" + (Math.abs(dd) > 1 ? "s" : "")); } });
  if (tSrt.n) movements.push("Situations completed now " + Math.round(tSrt.s / tSrt.n * 100) + "%");
  if (tTry.n && pTry.n && tTry.s < pTry.s) movements.push("Hesitant openings down from " + pTry.s + " to " + tTry.s);
  strengths.slice(0, 2).forEach(p => movements.push(cap(labelOf(p.olq)) + " is a current strength"));
  const seenM = {}, movementsOut = [];
  movements.forEach(m => { if (!seenM[m]) { seenM[m] = 1; movementsOut.push(m); } });

  // Situations-completed series over time (for the one graph).
  const situations = rows.filter(a => a.mode === "SRT").map(a => { const m = safeObj(a.metrics); return (m && m.srt_completion_rate != null) ? { at: a.created_at, v: Math.round(m.srt_completion_rate * 100) } : null; }).filter(Boolean).reverse().slice(-10);

  // "What your responses highlight": a few of the student's own answers + our note.
  const exq = await env.DB.prepare(
    "SELECT prompt, response, analysis FROM ssb_items WHERE student_id = ? AND response IS NOT NULL AND response != '' ORDER BY created_at DESC LIMIT 40"
  ).bind(user.id).all();
  const examples = [];
  (exq.results || []).forEach(r => { if (examples.length >= 3) return; const a = safeObj(r.analysis) || {}; const comment = a.comment || a.suggestion || ""; if (!comment) return; examples.push({ prompt: r.prompt || "", response: r.response, comment: comment }); });

  // Streak: consecutive IST days with at least one session, ending today or yesterday.
  const days = {}; rows.forEach(a => { days[istDateStr(a.created_at)] = true; });
  const key = dt => dt.toISOString().slice(0, 10);
  let streak = 0, d = new Date(now + 330 * 60000);
  if (!days[key(d)]) d = new Date(d.getTime() - DAY_MS);
  while (days[key(d)]) { streak++; d = new Date(d.getTime() - DAY_MS); }

  const statusLine = !total
    ? "Your SSB practice starts here. Do today’s challenge to begin building your picture."
    : (improvingCount ? "You’re building well. Sharper and more decisive this week."
      : "Steady progress. Keep the daily challenge going to see it move.");
  const forecast = total ? "Keep this pace and your weaker areas should strengthen over the next few weeks." : "";

  const wk = await env.DB.prepare(
    "SELECT week_start, student_report, created_at FROM ssb_weekly_reports WHERE student_id = ? ORDER BY week_start DESC LIMIT 1"
  ).bind(user.id).first();
  const weekly = wk ? { weekStart: wk.week_start, report: safeObj(wk.student_report), createdAt: wk.created_at } : null;

  return json({ tier: user.product, totalSessions: total, statusLine, radar, qualitiesNote, movements: movementsOut.slice(0, 6), situations, examples, forecast, streak, weekly, recent: sessions.slice(0, 8) }, 200, cors);
}

/* ===================== DAILY ENGLISH CHALLENGE ============================ */
// Mirrors the SSB tracking layer, but English is objective MCQ: scoring is exact and
// done here on the server, and the weekly report is computed from the stored rows (no
// AI engine, so it never touches the Gemini quota). Content is the normalised per-theme
// JSON on the English Pages site, keyed to the shared 13-week rotation.

// Fetch one normalised English theme file (cached at the edge).
async function fetchEngTheme(theme) {
  try {
    const res = await fetch(ENGLISH_DATA_BASE + "/" + theme + ".json", { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!res.ok) return { questions: [], passages: {} };
    const o = await res.json();
    return {
      questions: Array.isArray(o.questions) ? o.questions : [],
      passages: (o.passages && typeof o.passages === "object") ? o.passages : {}
    };
  } catch { return { questions: [], passages: {} }; }
}
function levelFilter(qs, level) { return level === 0 ? qs : qs.filter(q => (q.level || 1) === level); }

// Build today's English set for a student: deterministic per student per day, spread
// across the week's themes for breadth. For the reading week it returns one passage
// and its questions instead of loose items.
async function engDailySet(sched, dayIndex, seedBase) {
  const eng = sched.english;
  const seed = (seedBase | 0) + (dayIndex | 0);
  const pools = await Promise.all(eng.themes.map(fetchEngTheme));

  if (eng.passage) {
    const plist = [];
    pools.forEach(p => Object.keys(p.passages || {}).forEach(pid => {
      const pg = p.passages[pid];
      if (eng.level === 0 || (pg.level || 1) === eng.level) {
        plist.push({ pid, text: pg.text, qs: p.questions.filter(q => q.passageId === pid) });
      }
    }));
    if (!plist.length) return { items: [], passage: null };
    const chosen = plist[((seed % plist.length) + plist.length) % plist.length];
    return { items: chosen.qs.slice(0, eng.perDay), passage: { id: chosen.pid, text: chosen.text } };
  }

  const perTheme = pools.map(p => levelFilter(p.questions, eng.level));
  const out = [], used = new Set(); const need = eng.perDay;
  let ti = 0, guard = 0;
  while (out.length < need && guard < need * eng.themes.length + 40) {
    const pool = perTheme[ti % perTheme.length];
    if (pool && pool.length) {
      const start = (((seed + ti) % pool.length) + pool.length) % pool.length;
      for (let k = 0; k < pool.length; k++) {
        const cand = pool[(start + k) % pool.length];
        if (!used.has(cand.id)) { used.add(cand.id); out.push(cand); break; }
      }
    }
    ti++; guard++;
  }
  return { items: out.slice(0, need), passage: null };
}

// GET today's English set. Answers are never sent to the browser; scoring is on submit.
async function engChallengeToday(env, cors, user) {
  if (!canSeeChallenges(user)) return json({ error: "no_challenge_access" }, 403, cors);
  const plan = ssbChallengePlan(user.start_date);
  const week = challengeWeek(user.start_date);
  const sched = scheduleForWeek(week);
  const theme = sched.english.label;
  if (!plan.available) {
    return json({ product: user.product, week, theme, available: false, weekend: false, startDate: user.start_date, unlockAt: plan.unlockAt, items: [], passage: null }, 200, cors);
  }
  if (istWeekdayIndex() >= 5) { // Sat/Sun: no new set, the weekend report stands in
    return json({ product: user.product, week, theme, available: false, weekend: true, items: [], passage: null }, 200, cors);
  }
  const { items, passage } = await engDailySet(sched, plan.dayIndex, user.id * 1000);
  const safe = items.map((q, i) => ({ n: i + 1, id: q.id, theme: q.theme, question: q.question, options: q.options }));
  return json({ product: user.product, week, theme, perDay: sched.english.perDay, available: true, weekend: false, dayIndex: plan.dayIndex, passage, items: safe }, 200, cors);
}

// POST a completed English set. Server rebuilds the answer key from the week's banks,
// scores deterministically, stores the session + per-question rows + topic tallies, and
// returns a review (correct answer + explanation per item) for the student.
async function engAttempt(env, cors, user, url, request) {
  if (!canSeeChallenges(user)) return json({ error: "no_challenge_access" }, 403, cors);
  const b = await readJson(request);
  const week = clampInt(b.week, 1, 13) || challengeWeek(user.start_date);
  const sched = scheduleForWeek(week);
  const answers = Array.isArray(b.items) ? b.items.slice(0, 60) : [];
  if (!answers.length) return json({ error: "no_items" }, 400, cors);
  const seconds = clampInt(b.seconds, 0, 100000);

  const pools = await Promise.all(sched.english.themes.map(fetchEngTheme));
  const key = {}; pools.forEach(p => p.questions.forEach(q => { key[q.id] = q; }));

  const now = Date.now();
  let correct = 0, attempted = 0;
  const perTheme = {}, itemRows = [], review = [];
  answers.forEach((a, i) => {
    const q = key[a.id]; if (!q) return;
    const chosen = (a.chosen == null || a.chosen === "") ? null : clampInt(a.chosen, 0, 3);
    const isC = chosen != null && chosen === q.answer;
    if (chosen != null) attempted++;
    if (isC) correct++;
    const t = q.theme || sched.english.themes[0];
    (perTheme[t] = perTheme[t] || { seen: 0, correct: 0 }); perTheme[t].seen++; if (isC) perTheme[t].correct++;
    itemRows.push({ id: q.id, theme: t, n: i + 1, question: q.question, options: q.options, chosen, answer: q.answer, isC, explanation: q.explanation });
    review.push({ n: i + 1, question: q.question, options: q.options, chosen, correct: q.answer, isCorrect: isC, explanation: q.explanation });
  });
  if (!itemRows.length) return json({ error: "no_known_items" }, 400, cors);
  const itemsCount = itemRows.length;

  const metrics = { week, theme: sched.english.label, perTheme };
  const ins = await env.DB.prepare(
    `INSERT INTO english_attempts (student_id, week_index, theme, created_at, items_count, attempted_count, correct_count, seconds_used, metrics)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(user.id, week, sched.english.label, now, itemsCount, attempted, correct, seconds, JSON.stringify(metrics)).run();
  const sessionId = (ins && ins.meta) ? ins.meta.last_row_id : null;

  const stmts = [];
  itemRows.forEach(r => stmts.push(env.DB.prepare(
    `INSERT INTO english_items (session_id, student_id, theme, source, n, question, options, chosen_index, correct_index, is_correct, explanation, created_at)
     VALUES (?, ?, ?, 'challenge', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(sessionId, user.id, r.theme, r.n, String(r.question).slice(0, 600), JSON.stringify(r.options || []), r.chosen, r.answer, r.isC ? 1 : 0, String(r.explanation || "").slice(0, 1000), now)));
  Object.keys(perTheme).forEach(t => { const pt = perTheme[t]; stmts.push(env.DB.prepare(
    `INSERT INTO english_topic_profile (student_id, topic, seen_count, correct_count, last_seen_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(student_id, topic) DO UPDATE SET
       seen_count = seen_count + excluded.seen_count, correct_count = correct_count + excluded.correct_count, last_seen_at = excluded.last_seen_at`
  ).bind(user.id, t, pt.seen, pt.correct, now)); });
  if (stmts.length) await env.DB.batch(stmts);

  return json({ ok: true, score: correct, total: itemsCount, attempted, percent: itemsCount ? Math.round(correct / itemsCount * 100) : 0, review }, 200, cors);
}

// Student English dashboard (deterministic): overall accuracy, accuracy-over-time,
// per-topic bars, movement ticker, missed-question examples, streak, weekly report.
async function engDashboard(env, cors, user) {
  if (!canSeeChallenges(user)) return json({ error: "no_challenge_access" }, 403, cors);
  const now = Date.now();
  const att = await env.DB.prepare(
    `SELECT week_index, theme, created_at, items_count, attempted_count, correct_count, metrics
     FROM english_attempts WHERE student_id = ? ORDER BY created_at DESC LIMIT 200`
  ).bind(user.id).all();
  const rows = att.results || [];
  const total = rows.length;
  const totQ = rows.reduce((a, r) => a + (r.items_count || 0), 0);
  const totC = rows.reduce((a, r) => a + (r.correct_count || 0), 0);
  const overallPct = totQ ? Math.round(totC / totQ * 100) : 0;
  const accuracy = rows.slice(0, 10).reverse().map(r => ({ at: r.created_at, v: r.items_count ? Math.round(r.correct_count / r.items_count * 100) : 0 }));

  const prof = await env.DB.prepare(
    "SELECT topic, seen_count, correct_count FROM english_topic_profile WHERE student_id = ?"
  ).bind(user.id).all();
  const topics = (prof.results || []).map(p => ({ topic: p.topic, label: engThemeLabel(p.topic), pct: p.seen_count ? Math.round(p.correct_count / p.seen_count * 100) : 0, seen: p.seen_count })).sort((a, b) => b.seen - a.seen);
  const ranked = topics.filter(t => t.seen >= 5);
  const strong = ranked.slice().sort((a, b) => b.pct - a.pct).slice(0, 2);
  const weak = ranked.slice().sort((a, b) => a.pct - b.pct).slice(0, 2);

  const days = {}; rows.forEach(a => { days[istDateStr(a.created_at)] = true; });
  const keyf = dt => dt.toISOString().slice(0, 10);
  let streak = 0, d = new Date(now + 330 * 60000);
  if (!days[keyf(d)]) d = new Date(d.getTime() - DAY_MS);
  while (days[keyf(d)]) { streak++; d = new Date(d.getTime() - DAY_MS); }

  const movements = [];
  if (total) movements.push("Overall accuracy " + overallPct + "%");
  strong.forEach(t => movements.push(t.label + " is strong at " + t.pct + "%"));
  weak.forEach(t => movements.push(t.label + " needs work at " + t.pct + "%"));
  if (streak >= 2) movements.push(streak + "-day streak going");

  const miss = await env.DB.prepare(
    "SELECT question, options, chosen_index, correct_index, explanation FROM english_items WHERE student_id = ? AND is_correct = 0 ORDER BY created_at DESC LIMIT 40"
  ).bind(user.id).all();
  const examples = [];
  (miss.results || []).forEach(r => {
    if (examples.length >= 3) return;
    const opts = safeArr(r.options);
    examples.push({
      question: r.question,
      your: (r.chosen_index != null && opts[r.chosen_index] != null) ? opts[r.chosen_index] : "(skipped)",
      correct: opts[r.correct_index] != null ? opts[r.correct_index] : "",
      explanation: r.explanation || ""
    });
  });

  const wk = await env.DB.prepare(
    "SELECT week_start, student_report, created_at FROM english_weekly_reports WHERE student_id = ? ORDER BY week_start DESC LIMIT 1"
  ).bind(user.id).first();
  const weekly = wk ? { weekStart: wk.week_start, report: safeObj(wk.student_report), createdAt: wk.created_at } : null;

  const curWeek = challengeWeek(user.start_date);
  const statusLine = !total
    ? "Your English practice starts here. Do today's set to begin building your picture."
    : ("Overall accuracy " + overallPct + "% across " + total + " set" + (total > 1 ? "s" : "") + ". Keep the daily set going.");

  return json({
    product: user.product, totalSets: total, overallPct, statusLine, accuracy, topics, strong, weak,
    movements, examples, streak, weekly, currentWeek: curWeek, currentTheme: scheduleForWeek(curWeek).english.label,
    recent: rows.slice(0, 8).map(r => ({ at: r.created_at, theme: r.theme, score: r.correct_count, total: r.items_count }))
  }, 200, cors);
}

// Deterministic weekend English report for [fromMs, toMs): plain-language for the
// student, a full by-theme breakdown for the admin. Written to english_weekly_reports.
async function generateEnglishWeekly(env, student, fromMs, toMs) {
  const att = await env.DB.prepare(
    `SELECT theme, created_at, items_count, attempted_count, correct_count, metrics
     FROM english_attempts WHERE student_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at ASC`
  ).bind(student.id, fromMs, toMs).all();
  const rows = att.results || [];
  if (!rows.length) return null;

  const totQ = rows.reduce((a, r) => a + (r.items_count || 0), 0);
  const totC = rows.reduce((a, r) => a + (r.correct_count || 0), 0);
  const pct = totQ ? Math.round(totC / totQ * 100) : 0;

  const perTheme = {};
  rows.forEach(r => { const m = safeObj(r.metrics); const pt = (m && m.perTheme) || {}; Object.keys(pt).forEach(t => { (perTheme[t] = perTheme[t] || { seen: 0, correct: 0 }); perTheme[t].seen += pt[t].seen || 0; perTheme[t].correct += pt[t].correct || 0; }); });
  const themeArr = Object.keys(perTheme).map(t => ({ theme: t, label: engThemeLabel(t), seen: perTheme[t].seen, pct: perTheme[t].seen ? Math.round(perTheme[t].correct / perTheme[t].seen * 100) : 0 }));
  const strong = themeArr.filter(t => t.seen >= 3).sort((a, b) => b.pct - a.pct).slice(0, 2);
  const weak = themeArr.filter(t => t.seen >= 3).sort((a, b) => a.pct - b.pct).slice(0, 2);

  const prev = await env.DB.prepare(
    "SELECT items_count, correct_count FROM english_attempts WHERE student_id = ? AND created_at >= ? AND created_at < ?"
  ).bind(student.id, fromMs - 7 * DAY_MS, fromMs).all();
  const pQ = (prev.results || []).reduce((a, r) => a + (r.items_count || 0), 0);
  const pC = (prev.results || []).reduce((a, r) => a + (r.correct_count || 0), 0);
  const prevPct = pQ ? Math.round(pC / pQ * 100) : null;
  const trend = (prevPct == null) ? "" : (pct > prevPct ? ("up from " + prevPct + "% last week") : (pct < prevPct ? ("down from " + prevPct + "% last week") : "steady versus last week"));

  const headline = "You scored " + pct + "% this week" + (trend ? ", " + trend : "") + ". This is practice, keep it steady.";
  const focus = [];
  weak.forEach(t => focus.push({ pattern: t.label + " is your weakest area at " + t.pct + "%", why: "This question type recurs in the CDS paper.", action: "Redo the " + t.label.toLowerCase() + " set and read each explanation." }));
  if (strong[0]) focus.push({ pattern: strong[0].label + " is your strongest at " + strong[0].pct + "%", why: "You can bank these marks.", action: "Keep it warm with a quick revision." });
  if (!focus.length) focus.push({ pattern: "A steady week across topics", why: "Consistency is what builds the score.", action: "Keep doing the daily set." });

  const studentReport = { headline, focus };
  const adminReport = { overall: { pct, questions: totQ, correct: totC, sets: rows.length }, trend: { thisWeek: pct, lastWeek: prevPct }, byTheme: themeArr.sort((a, b) => a.pct - b.pct) };

  await env.DB.prepare(
    `INSERT INTO english_weekly_reports (student_id, week_start, student_report, admin_report, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(student_id, week_start) DO UPDATE SET
       student_report = excluded.student_report, admin_report = excluded.admin_report, created_at = excluded.created_at`
  ).bind(student.id, istDateStr(fromMs), JSON.stringify(studentReport), JSON.stringify(adminReport), Date.now()).run();
  return { studentReport, adminReport };
}

// Admin: English roster (active trial/elite/legend) with each student's set count +
// overall accuracy, most recent first.
async function adminEngRoster(request, env, cors) {
  if (!adminOk(request, env)) return json({ error: "forbidden" }, 403, cors);
  const r = await env.DB.prepare(
    `SELECT s.id, s.name, s.email, s.product,
            COUNT(e.id) AS sets,
            COALESCE(SUM(e.items_count), 0) AS q,
            COALESCE(SUM(e.correct_count), 0) AS c,
            MAX(e.created_at) AS last_at
     FROM students s LEFT JOIN english_attempts e ON e.student_id = s.id
     WHERE s.status = 'active' AND s.product IN ('trial','elite','legend')
     GROUP BY s.id ORDER BY last_at DESC`
  ).all();
  const list = (r.results || []).map(s => ({
    id: s.id, name: s.name, email: s.email, product: s.product,
    sets: s.sets, overallPct: s.q ? Math.round(s.c / s.q * 100) : 0, lastAt: s.last_at
  }));
  return json({ students: list }, 200, cors);
}

// Admin: one student's English detail (?id=): recent sets, per-theme accuracy, latest
// weekly admin report.
async function adminEngStudent(request, env, cors, url) {
  if (!adminOk(request, env)) return json({ error: "forbidden" }, 403, cors);
  const id = parseInt(url.searchParams.get("id"), 10);
  if (!id) return json({ error: "bad_id" }, 400, cors);
  const s = await env.DB.prepare("SELECT id, name, email, product FROM students WHERE id = ?").bind(id).first();
  if (!s) return json({ error: "not_found" }, 404, cors);
  const att = await env.DB.prepare(
    "SELECT week_index, theme, created_at, items_count, attempted_count, correct_count FROM english_attempts WHERE student_id = ? ORDER BY created_at DESC LIMIT 30"
  ).bind(id).all();
  const prof = await env.DB.prepare(
    "SELECT topic, seen_count, correct_count FROM english_topic_profile WHERE student_id = ?"
  ).bind(id).all();
  const topics = (prof.results || []).map(p => ({ topic: p.topic, label: engThemeLabel(p.topic), seen: p.seen_count, pct: p.seen_count ? Math.round(p.correct_count / p.seen_count * 100) : 0 })).sort((a, b) => a.pct - b.pct);
  const wk = await env.DB.prepare(
    "SELECT week_start, admin_report, created_at FROM english_weekly_reports WHERE student_id = ? ORDER BY week_start DESC LIMIT 1"
  ).bind(id).first();
  const weekly = wk ? { weekStart: wk.week_start, report: safeObj(wk.admin_report), createdAt: wk.created_at } : null;
  return json({ student: s, sessions: att.results || [], topics, weekly }, 200, cors);
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
    "SELECT id, name FROM students WHERE status = 'active' AND product IN ('trial','elite','legend')"
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
