/* =============================================================================
   VicThree Learn — shared frontend helpers.
   >>> After you deploy the Worker, paste its URL into API below. That is the
   >>> ONLY value the frontend needs. No secrets ever live in the frontend.
   ============================================================================= */
const API = "https://victhree-portal.anmolxsharma.workers.dev";

const TOKEN_KEY = "vt_portal_token";

// Display names for each day's topic (Geography trial). Edit / extend here.
window.TOPIC_NAMES = {
  1: "The Universe and Earth's Interior",
  2: "Volcanism and Earthquakes",
  3: "Rocks and Weathering",
  4: "Atmosphere and Rainfall",
  5: "Winds and Jet Streams"
};

// Mock-test URL for each topic's "Take the test" tab (opens the mock-test site
// in a new tab). Paste the URL Anmol provides for each day; leave "" to keep
// the tab disabled ("test coming soon") until a link is added.
window.TOPIC_TESTS = {
  1: "https://victhree.github.io/victhree-mocks/test.html?test=geo-sec-01",
  2: "https://victhree.github.io/victhree-mocks/test.html?test=geo-sec-02",
  3: "https://victhree.github.io/victhree-mocks/test.html?test=geo-sec-03",
  4: "https://victhree.github.io/victhree-mocks/test.html?test=geo-sec-04",
  5: "https://victhree.github.io/victhree-mocks/test.html?test=geo-sec-05"
};

// Total topics the progress bar counts toward, per product. The full course is
// planned at 52 videos; the trial is out of its own topics.
window.COURSE_TOTALS = { trial: 5, course: 52 };

// ---- progress (kept in this browser; a video counts once watched past 50%) ----
function getProgress(){ try { return JSON.parse(localStorage.getItem("vt_progress") || "{}"); } catch { return {}; } }
function markWatched(product, day){
  try { var p = getProgress(); p[product + "#" + day] = true; localStorage.setItem("vt_progress", JSON.stringify(p)); } catch {}
}
function isWatched(product, day){ return !!getProgress()[product + "#" + day]; }
function countWatched(product, days){ var p = getProgress(); var n = 0; (days || []).forEach(function(d){ if (p[product + "#" + d]) n++; }); return n; }

/* ---- exam countdown ----
   Set the REAL exam dates below (YYYY-MM-DD). These are PLACEHOLDERS. Past
   dates are ignored; the soonest upcoming exam is shown on the dashboard. */
window.EXAMS = [
  { name: "CDS",   date: "2027-04-11" },   // <-- replace with the real CDS date
  { name: "AFCAT", date: "2027-02-14" }    // <-- replace with the real AFCAT date
];
function daysUntil(dateStr){ return Math.ceil((new Date(dateStr + "T00:00:00") - new Date()) / 86400000); }
function nextExam(){
  return (window.EXAMS || [])
    .filter(function(e){ return e.date && daysUntil(e.date) >= 0; })
    .sort(function(a, b){ return daysUntil(a.date) - daysUntil(b.date); })[0] || null;
}

/* ---- study streak (consecutive days the student opened the portal) ---- */
function todayStr(){ var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
function bumpStreak(){
  try {
    var today = todayStr();
    var s = JSON.parse(localStorage.getItem("vt_streak") || "null");
    if (!s) s = { last: today, count: 1 };
    else if (s.last !== today) {
      var diff = Math.round((new Date(today + "T00:00:00") - new Date(s.last + "T00:00:00")) / 86400000);
      s.count = (diff === 1) ? (s.count || 0) + 1 : 1;
      s.last = today;
    }
    localStorage.setItem("vt_streak", JSON.stringify(s));
    return s.count;
  } catch { return 1; }
}

function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } }
function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch {} }
function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch {} }
function logout() { clearToken(); location.href = "index.html"; }

// Call the Worker API. Adds the login token automatically. Returns parsed JSON.
async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  const token = getToken();
  if (token) headers["Authorization"] = "Bearer " + token;
  if (opts.body && typeof opts.body !== "string") {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(API + path, { method: opts.method || "GET", headers, body: opts.body });
  // Any protected page kicks you back to login if the token is missing/expired.
  if (res.status === 401 && opts.guard !== false) { clearToken(); location.href = "index.html"; return; }
  let data = null; try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

// Fetch the notes PDF as a blob (needs the auth header) and open it in a new tab.
async function openNotes(day) {
  const token = getToken();
  const res = await fetch(API + "/api/notes?day=" + day, { headers: { "Authorization": "Bearer " + token } });
  if (!res.ok) {
    let d = {}; try { d = await res.json(); } catch {}
    alert("Notes not available. (worker " + res.status + (d.upstream ? ", storage " + d.upstream : "") + ")");
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Open one current-affairs magazine PDF (fetched with the auth header, opened in a new tab).
async function openCaFile(file) {
  const token = getToken();
  const res = await fetch(API + "/api/ca-file?file=" + encodeURIComponent(file), { headers: { "Authorization": "Bearer " + token } });
  if (!res.ok) { alert("This issue isn't available."); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Redirect to login if not signed in. Call at the top of every protected page.
function requireLogin() { if (!getToken()) { location.href = "index.html"; return false; } return true; }

// Friendly IST date/time for unlock timestamps.
function fmtUnlock(ms) {
  const d = new Date(ms);
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true
  });
}
