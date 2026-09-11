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
  if (!res.ok) { alert("Notes are not available yet."); return; }
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
