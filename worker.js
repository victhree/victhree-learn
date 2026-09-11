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
    { day: 5, title: "Winds and Jet Streams",            video: "48d597dc-2d0b-42fc-8e17-5bbdd67101fb", notes: "trial/day5.pdf" }
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
      if (path === "/api/me"           && request.method === "GET")  return await withAuth(request, env, cors, me);
      if (path === "/api/lessons"      && request.method === "GET")  return await withAuth(request, env, cors, lessons);
      if (path === "/api/video"        && request.method === "GET")  return await withAuth(request, env, cors, video, url);
      if (path === "/api/notes"        && request.method === "GET")  return await withAuth(request, env, cors, notes, url);
      if (path === "/api/ca"           && request.method === "GET")  return await withAuth(request, env, cors, caList, url);
      if (path === "/api/ca-file"      && request.method === "GET")  return await withAuth(request, env, cors, caFile, url);
      if (path === "/api/admin/add-student" && request.method === "POST") return await adminAddStudent(request, env, cors);
      if (path === "/api/admin/students"    && request.method === "GET")  return await adminListStudents(request, env, cors);
      return json({ error: "not_found" }, 404, cors);
    } catch (e) {
      return json({ error: "server_error", detail: String((e && e.message) || e) }, 500, cors);
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

// Wrap a handler so it only runs for a valid logged-in student.
async function withAuth(request, env, cors, handler, url) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return json({ error: "no_token" }, 401, cors);
  const sid = await verifyToken(env, m[1]);
  if (!sid) return json({ error: "bad_token" }, 401, cors);

  const student = await env.DB.prepare(
    "SELECT id, email, name, product, start_date, status FROM students WHERE id = ?"
  ).bind(sid).first();
  if (!student || student.status !== "active") return json({ error: "inactive" }, 403, cors);

  return await handler(env, cors, student, url);
}

/* ============================== STUDENT API ============================== */

async function me(env, cors, student) {
  return json({ email: student.email, name: student.name, product: student.product }, 200, cors);
}

async function lessons(env, cors, student) {
  const list = LESSONS[student.product] || [];
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
  const lesson = (LESSONS[student.product] || []).find(l => l.day === day);
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
  const lesson = (LESSONS[student.product] || []).find(l => l.day === day);
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
  const product = (b.product === "course") ? "course" : "trial";
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
    const total = (LESSONS[s.product] || []).length;
    let currentDay = 0;
    for (let d = 1; d <= total; d++) if (now >= unlockTime(s.start_date, d)) currentDay = d;
    return { ...s, currentDay, totalDays: total };
  });
  return json({ students: rows }, 200, cors);
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

async function makeToken(env, sid) {
  const payload = b64urlEncode(JSON.stringify({ sid, exp: Date.now() + SESSION_TTL_MS }));
  const sig = await hmac(env.SESSION_SECRET, payload);
  return payload + "." + sig;
}

async function verifyToken(env, token) {
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;
  const expected = await hmac(env.SESSION_SECRET, parts[0]);
  if (!timingSafeEqual(expected, parts[1])) return null;
  try {
    const data = JSON.parse(b64urlDecode(parts[0]));
    if (!data.sid || !data.exp || data.exp < Date.now()) return null;
    return data.sid;
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
