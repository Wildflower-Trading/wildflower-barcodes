import { renderBarcode } from "./barcode.js";

const STORE_KEY = "wf.catalogue.v1";
const PASS_KEY = "wf.pass.v1";
const MAC_SALT = "wildflower-barcodes-mac";

let PRODUCTS = [];
let BUILT = null;

const $ = (id) => document.getElementById(id);
const screens = { unlock: $("unlock"), search: $("search"), show: $("show") };

function showScreen(name) {
  for (const [k, el] of Object.entries(screens)) el.classList.toggle("active", k === name);
}

/* ------------------------------------------------------------------ crypto */

const enc = new TextEncoder();

async function pbkdf2(pass, salt, iter, bits) {
  const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, bits);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* Reverses `openssl enc -aes-256-cbc -pbkdf2 -md sha256` plus our HMAC tag. */
async function decryptCatalogue(envelope, pass) {
  const blob = b64ToBytes(envelope.blob);
  const iter = envelope.iter || 250000;

  const magic = String.fromCharCode(...blob.slice(0, 8));
  if (magic !== "Salted__") throw new Error("catalogue file is not in the expected format");

  // Integrity first: a wrong passcode should fail here, not as CBC garbage.
  const macKeyBits = await pbkdf2(pass, enc.encode(MAC_SALT), iter, 256);
  const macKey = await crypto.subtle.importKey(
    "raw", macKeyBits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const tag = new Uint8Array(await crypto.subtle.sign("HMAC", macKey, blob));
  if (!bytesEqual(tag, b64ToBytes(envelope.mac))) throw new Error("BAD_PASSCODE");

  const salt = blob.slice(8, 16);
  const keyIv = new Uint8Array(await pbkdf2(pass, salt, iter, 384));
  const key = await crypto.subtle.importKey(
    "raw", keyIv.slice(0, 32), { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: keyIv.slice(32, 48) }, key, blob.slice(16));

  return JSON.parse(new TextDecoder().decode(plain));
}

/* ------------------------------------------------------------------ sync */

async function fetchEnvelope() {
  const res = await fetch("catalogue.json?t=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    PRODUCTS = data.products || [];
    BUILT = data.built || null;
    return PRODUCTS.length > 0;
  } catch (e) {
    return false;
  }
}

function saveLocal(data) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(
      { built: data.built, count: data.count, products: data.products }));
  } catch (e) {
    console.warn("could not persist catalogue", e);
  }
}

function setStatus(text) { $("status").textContent = text; }

function builtLabel() {
  if (!BUILT) return "";
  const d = new Date(BUILT);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const when = days === 0 ? "today" : days === 1 ? "yesterday" : days + " days ago";
  return `${PRODUCTS.length} products · synced ${when}`;
}

/* Refresh in the background whenever there is a network. Silent on failure -
   the whole point is that it keeps working in a warehouse or a car park. */
async function backgroundSync(pass) {
  try {
    const envelope = await fetchEnvelope();
    const data = await decryptCatalogue(envelope, pass);
    if (data.built !== BUILT) {
      PRODUCTS = data.products;
      BUILT = data.built;
      saveLocal(data);
      render($("q").value);
    }
    setStatus(builtLabel());
    $("resync").textContent = "Sync now";
  } catch (e) {
    if (e.message === "BAD_PASSCODE") {
      // The passcode was changed on the Mac. Keep the cached catalogue working,
      // but say so - a sync that fails quietly is worse than no sync at all.
      setStatus(builtLabel() + " · passcode changed");
      $("resync").textContent = "Re-enter passcode";
      return;
    }
    setStatus(builtLabel() + " · offline");
  }
}

/* ------------------------------------------------------------------ search */

let searchTimer = null;

function search(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  const digits = q.replace(/\D/g, "");
  const out = [];

  for (const p of PRODUCTS) {
    // A numeric query is almost always someone reading a barcode off a label.
    if (digits.length >= 4 && p.b.includes(digits)) { out.push(p); continue; }
    const hay = (p.t + " " + p.s).toLowerCase();
    let all = true;
    for (const t of terms) { if (!hay.includes(t)) { all = false; break; } }
    if (all) out.push(p);
    if (out.length >= 300) break;
  }
  return out;
}

function render(query) {
  const results = $("results");
  const q = query.trim();
  if (!q) {
    results.innerHTML = `<div class="empty">Type a product name, SKU or barcode.</div>`;
    return;
  }
  const hits = search(q);
  if (!hits.length) {
    results.innerHTML = `<div class="empty">Nothing matches “${escapeHtml(q)}”.</div>`;
    return;
  }
  results.innerHTML = hits.map((p, i) =>
    `<div class="row" data-i="${PRODUCTS.indexOf(p)}">
       <div class="t">${escapeHtml(p.t)}</div>
       <div class="m">${p.b} · ${escapeHtml(p.s)}</div>
     </div>`).join("");
  results.scrollTop = 0;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ------------------------------------------------------------------ barcode */

let wakeLock = null;
let currentProduct = null;
let rotated = false;

function paintBarcode() {
  if (!currentProduct) return;
  $("code").classList.toggle("rot", rotated);
  $("svgWrap").innerHTML = renderBarcode(
    currentProduct.b, currentProduct.y, { barHeight: rotated ? 32 : 62 });
}

async function openBarcode(p) {
  currentProduct = p;
  $("showTitle").textContent = p.t;
  paintBarcode();
  const label = { EAN13: "EAN-13", UPCA: "UPC-A", EAN8: "EAN-8" }[p.y] || p.y;
  $("showMeta").textContent = `${label} · ${p.s}`;
  showScreen("show");
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (e) { /* not supported, or denied - harmless */ }
}

async function closeBarcode() {
  showScreen("search");
  if (wakeLock) { try { await wakeLock.release(); } catch (e) {} wakeLock = null; }
}

/* ------------------------------------------------------------------ boot */

async function start(pass) {
  localStorage.setItem(PASS_KEY, pass);
  showScreen("search");
  setStatus(builtLabel());
  render("");
  $("q").focus();
  backgroundSync(pass);
}

async function attemptUnlock(pass) {
  const msg = $("unlockMsg");
  const btn = $("unlockBtn");
  btn.disabled = true;
  msg.style.color = "#8d99a6";
  msg.textContent = "Unlocking…";
  try {
    const envelope = await fetchEnvelope();
    const data = await decryptCatalogue(envelope, pass);
    PRODUCTS = data.products;
    BUILT = data.built;
    saveLocal(data);
    await start(pass);
  } catch (e) {
    msg.style.color = "#ff8a8a";
    msg.textContent = e.message === "BAD_PASSCODE"
      ? "That passcode isn't right."
      : "Couldn't reach the catalogue. Connect to wi-fi for the first unlock.";
  } finally {
    btn.disabled = false;
  }
}

function init() {
  $("unlockBtn").addEventListener("click", () => {
    const pass = $("passcode").value;
    if (pass) attemptUnlock(pass);
  });
  $("passcode").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("unlockBtn").click();
  });

  $("q").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => render(v), 60);
  });

  $("results").addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (row) openBarcode(PRODUCTS[Number(row.dataset.i)]);
  });

  $("back").addEventListener("click", closeBarcode);

  $("rotate").addEventListener("click", () => {
    rotated = !rotated;
    paintBarcode();
  });

  $("resync").addEventListener("click", () => {
    if ($("resync").textContent === "Re-enter passcode") {
      localStorage.removeItem(PASS_KEY);
      $("passcode").value = "";
      $("unlockMsg").textContent = "";
      showScreen("unlock");
      $("passcode").focus();
      return;
    }
    const pass = localStorage.getItem(PASS_KEY);
    if (pass) { setStatus("Syncing…"); backgroundSync(pass); }
  });

  const savedPass = localStorage.getItem(PASS_KEY);
  if (savedPass && loadLocal()) {
    start(savedPass);
  } else {
    showScreen("unlock");
    $("passcode").focus();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
