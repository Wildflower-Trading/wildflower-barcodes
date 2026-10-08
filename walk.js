/* Costco walk mode.

   Walk the warehouse scanning the barcode on each shelf sign. That barcode is
   Code 39 and holds nothing but the Costco item number, which is the key
   Linnworks stores against every Supplier C line. The phone looks the number
   up in the catalogue it already holds, so it works with no signal, and keeps
   one record per sign scanned.

   Built for the Zebra TC26 / TC27. The handheld's own scanner types whatever
   it reads into the focused text box and presses Enter, exactly like a
   keyboard. The app keeps a text box focused the whole time, so the walk is
   just point and pull. For a sign that comes up red (not in Linnworks) the app
   asks for a second scan of the product's own barcode: that EAN either matches
   a product we already hold (so the Costco code just needs updating in
   Linnworks) or it does not (a genuinely new line). Everything is saved on the
   device; export when back on wi-fi. */

const DB_NAME = "wf-walk";
const DB_VER = 1;
const STORE = "scans";

const STATUS = {
  held:    { label: "STOCKED",            hint: "held in the warehouse",         cls: "ok" },
  cpick:   { label: "PICK FROM COSTCO",   hint: "listed, bought when it sells",  cls: "warn" },
  zero:    { label: "ZERO STOCK",         hint: "in Linnworks, nothing on hand", cls: "warn" },
  unknown: { label: "NOT IN LINNWORKS",   hint: "no SKU carries this number",    cls: "bad" },
};

let ctx = null;          // { lookup(code), lookupEan(ean), built(), showScreen(name) }
let pendingUnknown = null;   // code waiting for a product-barcode scan (gun mode)
let wakeLock = null;
let audio = null;
let gunTimer = null;

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

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result !== undefined ? req.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}

const dbAll = () => tx("readonly", (s) => s.getAll()).then((r) => r || []);
const dbGet = (code) => tx("readonly", (s) => s.get(code)).then((r) => r || null);
const dbPut = (rec) => tx("readwrite", (s) => s.put(rec));
const dbDelete = (code) => tx("readwrite", (s) => s.delete(code));
const dbClear = () => tx("readwrite", (s) => s.clear());

/* ---------------------------------------------------------------- codes */

/* A scanner returns the Code 39 payload verbatim, which on Costco signs is the
   item number padded with a leading zero. Linnworks holds it unpadded. */
export function normaliseCode(raw) {
  const digits = String(raw || "").replace(/\D/g, "").replace(/^0+/, "");
  return digits.length >= 4 && digits.length <= 8 ? digits : null;
}

function gs1Check(body) {
  let total = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) total += Number(body[i]) * w;
  return (10 - (total % 10)) % 10;
}

/* A product barcode (EAN-8 / UPC-A / EAN-13 / GTIN-14) with a valid check digit.
   Costco item numbers are 5 to 7 digits, so length alone separates the two. */
export function asEan(raw) {
  const s = String(raw || "").replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(s.length)) return null;
  if (gs1Check(s.slice(0, -1)) !== Number(s.slice(-1))) return null;
  return s;
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
    const freq = { held: 1200, cpick: 800, zero: 800, unknown: 400, ean: 1500 }[status] || 600;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + (status === "unknown" ? 0.25 : 0.1));
  } catch (e) { /* no audio - the colour band still tells the story */ }
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------------------------------------------------------- result */

function eanLine(rec) {
  if (!rec.ean) return "";
  return rec.ean_sku
    ? `<div class="sku"><span class="t">Product barcode ${esc(rec.ean)} is ${esc(rec.ean_title)}</span>
       <span class="m">${esc(rec.ean_sku)} · we hold this product: update its Costco code to ${esc(rec.code)}</span></div>`
    : `<div class="sku"><span class="t">Product barcode ${esc(rec.ean)} noted</span>
       <span class="m">not in our catalogue either: a new line to consider</span></div>`;
}

function showResult(rec, repeat) {
  const st = STATUS[rec.status];
  const card = $("walkResult");
  card.className = "walk-result " + st.cls;
  const lines = rec.skus.length
    ? rec.skus.map((e) =>
        `<div class="sku"><span class="t">${esc(e.t)}</span>
         <span class="m">${esc(e.s)} · held ${e.held}${e.qc ? " · Costco pick " + e.qc : ""} · cost £${Number(e.c || 0).toFixed(2)}</span></div>`).join("")
    : `<div class="sku"><span class="m">Nothing in Linnworks carries item ${esc(rec.code)}.</span></div>`;
  card.innerHTML =
    `<div class="band">${st.label}<span class="code">${esc(rec.code)}</span>${repeat ? '<span class="rep">already scanned</span>' : ""}</div>
     <div class="hint">${st.hint}</div>${lines}${eanLine(rec)}`;
}

function setGunPrompt() {
  const p = $("gunPrompt");
  if (!p) return;
  if (pendingUnknown) {
    p.className = "gun-prompt bad";
    p.textContent = `Item ${pendingUnknown} is not in Linnworks. Now scan the PRODUCT's own barcode, or scan the next sign to skip.`;
  } else {
    p.className = "gun-prompt";
    p.textContent = "Ready. Scan the barcode in the corner of a shelf sign.";
  }
}

async function handleCode(raw, source) {
  const code = normaliseCode(raw);
  if (!code) return;
  pendingUnknown = null;

  const existing = await dbGet(code);
  if (existing) {
    existing.seen = (existing.seen || 1) + 1;
    await dbPut(existing);
    showResult(existing, true);
    beep(existing.status);
    if (existing.status === "unknown" && !existing.ean) pendingUnknown = code;
    setGunPrompt();
    return;
  }
  const entries = ctx.lookup(code);
  const status = classify(entries);
  const rec = {
    code,
    ts: new Date().toISOString(),
    status,
    skus: summarise(entries),
    thumb: null,
    source,
    manual: source === "typed",
    seen: 1,
  };
  await dbPut(rec);
  showResult(rec, false);
  beep(status);
  if (status === "unknown") pendingUnknown = code;
  setGunPrompt();
  refreshCount();
}

/* Second scan on a red sign: the product's own barcode. */
async function handleEan(ean) {
  const code = pendingUnknown;
  pendingUnknown = null;
  const rec = await dbGet(code);
  if (!rec) return;
  const p = ctx.lookupEan(ean);
  rec.ean = ean;
  rec.ean_sku = p ? p.s : null;
  rec.ean_title = p ? p.t : null;
  await dbPut(rec);
  showResult(rec, false);
  beep("ean");
  setGunPrompt();
}

/* ---------------------------------------------------------------- gun */

function gunCommit() {
  clearTimeout(gunTimer);
  const inp = $("gunInput");
  const v = inp.value.trim();
  inp.value = "";
  if (!v) return;
  if (pendingUnknown) {
    const ean = asEan(v);
    if (ean) { handleEan(ean); return; }
  }
  handleCode(v, "gun");
}

function gunFocus() {
  const inp = $("gunInput");
  if (document.activeElement !== inp) { try { inp.focus({ preventScroll: true }); } catch (e) {} }
}

/* ---------------------------------------------------------------- wake */

async function keepAwake() {
  try {
    if ("wakeLock" in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request("screen");
  } catch (e) { /* not supported or denied: the device's own timeout applies */ }
}

function releaseAwake() {
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
    let desc = first
      ? `${esc(first.t)}${r.skus.length > 1 ? ` (+${r.skus.length - 1} more)` : ""}`
      : r.ean_sku ? `EAN = ${esc(r.ean_title)}: update code in Linnworks`
      : r.ean ? `EAN ${esc(r.ean)} noted: new line`
      : "not in Linnworks";
    const held = first
      ? "held " + r.skus.reduce((a, e) => a + e.held, 0) + " · Costco pick " + r.skus.reduce((a, e) => a + (e.qc || 0), 0)
      : "";
    return `<div class="row walk-row ${STATUS[r.status].cls}" data-code="${esc(r.code)}">
      <div class="noimg">${r.source === "typed" ? "typed" : "gun"}</div>
      <div class="body">
        <div class="t">${esc(r.code)} · ${STATUS[r.status].label}</div>
        <div class="m">${desc}</div>
        <div class="m">${held} ${r.seen > 1 ? "· seen ×" + r.seen : ""}</div>
      </div>
      <button class="del" data-del="${esc(r.code)}" aria-label="Remove">×</button>
    </div>`;
  }).join("");
}

/* ---------------------------------------------------------------- export */

function csvOf(all) {
  const q = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  const rows = [["costco_code", "status", "scanned_at", "seen", "source", "sku", "title",
                 "held", "costco_pick", "linnworks_cost", "ean", "ean_sku", "ean_title"]];
  for (const r of all) {
    const src = r.source || (r.manual ? "typed" : "camera");
    if (!r.skus.length) rows.push([r.code, r.status, r.ts, r.seen, src, "", "", "", "", "",
                                   r.ean || "", r.ean_sku || "", r.ean_title || ""]);
    for (const e of r.skus) rows.push([r.code, r.status, r.ts, r.seen, src, e.s, e.t, e.held, e.qc, e.c,
                                       r.ean || "", r.ean_sku || "", r.ean_title || ""]);
  }
  return rows.map((row) => row.map(q).join(",")).join("\r\n") + "\r\n";
}

async function exportWalk() {
  const all = (await dbAll()).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (!all.length) { $("walkListMsg").textContent = "Nothing to export."; return; }
  const day = new Date().toISOString().slice(0, 10);
  const payload = {
    kind: "wildflower-costco-walk",
    v: 2,
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
    $("walkResult").innerHTML = `<div class="hint">Pull the trigger on the barcode in the corner of a shelf sign.</div>`;
    pendingUnknown = null;
    setGunPrompt();
    await refreshCount();
    keepAwake();
    gunFocus();
  });

  $("walkBack").addEventListener("click", () => {
    pendingUnknown = null;
    releaseAwake();
    ctx.showScreen("search");
  });

  // Gun: the scanner types the code then Enter (or Tab). Some DataWedge profiles
  // send no suffix at all, so a short pause after the last keystroke also commits.
  const gun = $("gunInput");
  gun.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); gunCommit(); }
  });
  gun.addEventListener("input", () => {
    clearTimeout(gunTimer);
    if (gun.value.trim().length >= 5) gunTimer = setTimeout(gunCommit, 300);
  });
  gun.addEventListener("blur", () => {
    if (!$("walk").classList.contains("active")) return;
    setTimeout(() => {
      const a = document.activeElement;
      if (a && (a.tagName === "INPUT" || a.tagName === "BUTTON")) return;
      gunFocus();
    }, 150);
  });
  $("gunPanel").addEventListener("click", gunFocus);

  $("walkManualGo").addEventListener("click", () => {
    const v = $("walkManual").value;
    $("walkManual").value = "";
    $("walkManual").blur();
    handleCode(v, "typed");
  });
  $("walkManual").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("walkManualGo").click();
  });

  $("walkListBtn").addEventListener("click", async () => {
    $("walkListMsg").textContent = "";
    await renderList();
    ctx.showScreen("walkList");
  });

  $("walkListBack").addEventListener("click", () => {
    ctx.showScreen("walk");
    gunFocus();
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
    if (!confirm(`Delete all ${all.length} scans from this device? Export first if you have not.`)) return;
    await dbClear();
    await renderList();
    refreshCount();
  });

  // Coming back to the app mid-walk: the list is already saved, just pick up
  // the scanner focus and the wake lock again (Android drops it on hide).
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && $("walk").classList.contains("active")) { keepAwake(); gunFocus(); }
  });
}
