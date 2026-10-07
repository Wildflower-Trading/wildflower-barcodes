/* Costco walk mode.

   Walk the warehouse scanning the barcode on each shelf sign. That barcode is
   Code 39 and holds nothing but the Costco item number, which is the key
   Linnworks stores against every Supplier C line. The phone looks the number
   up in the catalogue it already holds, so it works with no signal, and keeps
   one record per sign scanned - with a small photo of the sign so the review
   afterwards can read the description and price for anything we don't stock.

   Decoding is done by ZXing (public/zxing.js, loaded as a classic script so
   it is cached by the service worker like everything else). */

const DB_NAME = "wf-walk";
const DB_VER = 1;
const STORE = "scans";

const STATUS = {
  held:    { label: "STOCKED",            hint: "held in the warehouse",         cls: "ok" },
  cpick:   { label: "PICK FROM COSTCO",   hint: "listed, bought when it sells",  cls: "warn" },
  zero:    { label: "ZERO STOCK",         hint: "in Linnworks, nothing on hand", cls: "warn" },
  unknown: { label: "NOT IN LINNWORKS",   hint: "no SKU carries this number",    cls: "bad" },
};

let ctx = null;          // { lookup(code) -> entries|null, showScreen(name), back() }
let reader = null;
let scanning = false;
let lastCode = null;
let lastAt = 0;
let wakeLock = null;
let audio = null;

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- storage */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "code" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(code) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(code);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(rec) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(code) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(code);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbClear() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------------------------------------------------------- lookup */

/* A scanner returns the Code 39 payload verbatim, which on Costco signs is the
   item number padded with a leading zero. Linnworks holds it unpadded. */
export function normaliseCode(raw) {
  const digits = String(raw || "").replace(/\D/g, "").replace(/^0+/, "");
  return digits.length >= 4 && digits.length <= 8 ? digits : null;
}

export function classify(entries) {
  if (!entries || !entries.length) return "unknown";
  let held = 0, cpick = 0;
  for (const e of entries) { held += Math.max(0, (e.q || 0) - (e.qc || 0)); cpick += e.qc || 0; }
  if (held > 0) return "held";
  if (cpick > 0) return "cpick";
  return "zero";
}

function summarise(entries) {
  return (entries || []).map((e) => ({
    s: e.s, t: e.t, c: e.c, q: e.q, qc: e.qc, held: Math.max(0, (e.q || 0) - (e.qc || 0)),
  }));
}

/* ---------------------------------------------------------------- feedback */

function beep(status) {
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    const freq = { held: 1200, cpick: 800, zero: 800, unknown: 400 }[status] || 600;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + (status === "unknown" ? 0.25 : 0.1));
  } catch (e) { /* no audio - the colour band still tells the story */ }
}

function snapshot() {
  const v = $("walkVideo");
  if (!v.videoWidth) return null;
  const w = 480;
  const h = Math.round(v.videoHeight * w / v.videoWidth);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(v, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.5);
}

/* ---------------------------------------------------------------- result */

function showResult(rec, repeat) {
  const st = STATUS[rec.status];
  const card = $("walkResult");
  card.className = "walk-result " + st.cls;
  const lines = rec.skus.length
    ? rec.skus.map((e) =>
        `<div class="sku"><span class="t">${esc(e.t)}</span>
         <span class="m">${esc(e.s)} · held ${e.held}${e.qc ? " · Costco pick " + e.qc : ""} · cost £${Number(e.c || 0).toFixed(2)}</span></div>`).join("")
    : `<div class="sku"><span class="m">Nothing in Linnworks carries item ${esc(rec.code)}. Photo kept for the review.</span></div>`;
  card.innerHTML =
    `<div class="band">${st.label}<span class="code">${esc(rec.code)}</span>${repeat ? '<span class="rep">already scanned</span>' : ""}</div>
     <div class="hint">${st.hint}</div>${lines}`;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function handleCode(raw, viaCamera) {
  const code = normaliseCode(raw);
  if (!code) return;
  const now = Date.now();
  if (viaCamera && code === lastCode && now - lastAt < 2500) { lastAt = now; return; }
  lastCode = code; lastAt = now;

  const existing = await dbGet(code);
  if (existing) {
    existing.seen = (existing.seen || 1) + 1;
    await dbPut(existing);
    showResult(existing, true);
    beep(existing.status);
    return;
  }
  const entries = ctx.lookup(code);
  const status = classify(entries);
  const rec = {
    code,
    ts: new Date().toISOString(),
    status,
    skus: summarise(entries),
    thumb: viaCamera ? snapshot() : null,
    manual: !viaCamera,
    seen: 1,
  };
  await dbPut(rec);
  showResult(rec, false);
  beep(status);
  refreshCount();
}

/* ---------------------------------------------------------------- camera */

async function startCamera() {
  if (scanning) return;
  const msg = $("walkMsg");
  if (!window.ZXing) { msg.textContent = "Scanner library missing. Sync on wi-fi once, then try again."; return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    msg.textContent = "This browser gives no camera access. Open the app from the home-screen icon in Safari.";
    return;
  }
  msg.textContent = "Starting camera…";
  try {
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,
      [ZXing.BarcodeFormat.CODE_39, ZXing.BarcodeFormat.CODE_128]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    reader = new ZXing.BrowserMultiFormatReader(hints, 250);
    const constraints = { video: { facingMode: "environment",
                                   width: { ideal: 1920 }, height: { ideal: 1080 } } };
    await reader.decodeFromConstraints(constraints, $("walkVideo"), (result, err) => {
      if (result) handleCode(result.getText(), true);
      // err is NotFoundException on every frame without a code - expected.
    });
    scanning = true;
    msg.textContent = "";
    $("walkStart").style.display = "none";
    try {
      if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    } catch (e) { /* harmless */ }
  } catch (e) {
    msg.textContent = e && e.name === "NotAllowedError"
      ? "Camera access was refused. Allow it in Settings › Safari › Camera, then try again."
      : "Could not start the camera: " + (e && e.message ? e.message : e);
  }
}

function stopCamera() {
  if (reader) { try { reader.reset(); } catch (e) {} reader = null; }
  scanning = false;
  $("walkStart").style.display = "";
  if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
}

/* ---------------------------------------------------------------- list */

async function refreshCount() {
  const all = await dbAll();
  $("walkListBtn").textContent = `List (${all.length})`;
  return all;
}

async function renderList() {
  const all = (await dbAll()).sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const counts = { held: 0, cpick: 0, zero: 0, unknown: 0 };
  for (const r of all) counts[r.status] = (counts[r.status] || 0) + 1;
  $("walkSummary").innerHTML = Object.keys(STATUS).map((k) =>
    `<span class="chip ${STATUS[k].cls}">${STATUS[k].label} ${counts[k] || 0}</span>`).join("");
  const list = $("walkRows");
  if (!all.length) {
    list.innerHTML = `<div class="empty">Nothing scanned yet.</div>`;
    return;
  }
  list.innerHTML = all.map((r) => {
    const first = r.skus[0];
    const desc = first ? `${esc(first.t)}${r.skus.length > 1 ? ` (+${r.skus.length - 1} more)` : ""}` : "not in Linnworks";
    return `<div class="row walk-row ${STATUS[r.status].cls}" data-code="${esc(r.code)}">
      ${r.thumb ? `<img src="${r.thumb}" alt="">` : `<div class="noimg">typed</div>`}
      <div class="body">
        <div class="t">${esc(r.code)} · ${STATUS[r.status].label}</div>
        <div class="m">${desc}</div>
        <div class="m">${first ? "held " + r.skus.reduce((a, e) => a + e.held, 0) + " · Costco pick " + r.skus.reduce((a, e) => a + (e.qc || 0), 0) : ""} ${r.seen > 1 ? "· seen ×" + r.seen : ""}</div>
      </div>
      <button class="del" data-del="${esc(r.code)}" aria-label="Remove">×</button>
    </div>`;
  }).join("");
}

/* ---------------------------------------------------------------- export */

function csvOf(all) {
  const q = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  const rows = [["costco_code", "status", "scanned_at", "seen", "manual", "sku", "title", "held", "costco_pick", "linnworks_cost"]];
  for (const r of all) {
    if (!r.skus.length) rows.push([r.code, r.status, r.ts, r.seen, r.manual ? 1 : 0, "", "", "", "", ""]);
    for (const e of r.skus) rows.push([r.code, r.status, r.ts, r.seen, r.manual ? 1 : 0, e.s, e.t, e.held, e.qc, e.c]);
  }
  return rows.map((row) => row.map(q).join(",")).join("\r\n") + "\r\n";
}

async function exportWalk() {
  const all = (await dbAll()).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (!all.length) { $("walkListMsg").textContent = "Nothing to export."; return; }
  const day = new Date().toISOString().slice(0, 10);
  const payload = {
    kind: "wildflower-costco-walk",
    v: 1,
    exported: new Date().toISOString(),
    catalogue_built: ctx.built(),
    count: all.length,
    scans: all,
  };
  const json = new File([JSON.stringify(payload)], `costco-walk-${day}.json`, { type: "application/json" });
  const csv = new File([csvOf(all)], `costco-walk-${day}.csv`, { type: "text/csv" });
  const files = [json, csv];
  try {
    if (navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files, title: `Costco walk ${day}` });
      $("walkListMsg").textContent = `Shared ${all.length} scans.`;
      return;
    }
  } catch (e) {
    if (e && e.name === "AbortError") return;   // user closed the share sheet
  }
  // Fallback: plain downloads.
  for (const f of files) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  $("walkListMsg").textContent = `Downloaded ${all.length} scans.`;
}

/* ---------------------------------------------------------------- wiring */

export function initWalk(context) {
  ctx = context;

  $("walkOpen").addEventListener("click", async () => {
    ctx.showScreen("walk");
    $("walkResult").className = "walk-result";
    $("walkResult").innerHTML = `<div class="hint">Point the camera at the barcode in the corner of a shelf sign.</div>`;
    await refreshCount();
    startCamera();
  });

  $("walkStart").addEventListener("click", startCamera);

  $("walkBack").addEventListener("click", () => {
    stopCamera();
    ctx.showScreen("search");
  });

  $("walkManualGo").addEventListener("click", () => {
    const v = $("walkManual").value;
    $("walkManual").value = "";
    $("walkManual").blur();
    handleCode(v, false);
  });
  $("walkManual").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("walkManualGo").click();
  });

  $("walkListBtn").addEventListener("click", async () => {
    stopCamera();
    $("walkListMsg").textContent = "";
    await renderList();
    ctx.showScreen("walkList");
  });

  $("walkListBack").addEventListener("click", () => {
    ctx.showScreen("walk");
    startCamera();
  });

  $("walkRows").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-del]");
    if (!btn) return;
    await dbDelete(btn.dataset.del);
    await renderList();
    refreshCount();
  });

  $("walkExport").addEventListener("click", exportWalk);

  $("walkClear").addEventListener("click", async () => {
    const all = await dbAll();
    if (!all.length) return;
    if (!confirm(`Delete all ${all.length} scans from this phone? Export first if you have not.`)) return;
    await dbClear();
    await renderList();
    refreshCount();
  });

  // Leaving the app mid-walk: release the camera, the list is already saved.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && scanning) stopCamera();
  });
}
