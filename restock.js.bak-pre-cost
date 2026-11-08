/* Restock from the barcode app (Jason only, 8 Nov 2026).

   Walking Costco or Booker, Jason scans a line that shows no stock and books 12 units
   back into its Costco / Booker pick bin "to get the product back into the mix".

   Only a device enrolled with a one-time code from the gateway sees the button. That
   device holds its own random key and signs every request with it; the catalogue
   passcode is never used for a restock. Two steps, both on the gateway: "check" asks
   the stock tool what it would book (bin, 12 units, value 0, or why not); "book"
   books exactly that after Jason confirms the store. With no signal the request is
   queued and checked later: a sighting is valid for 2 working days. */

const OFFICE = "https://wildflower-gateway.tail9d1c28.ts.net/walk/restock/";
const DEVICE_KEY = "wf.restock.device";
const QUEUE_KEY = "wf.restock.queue";

let ctx = null;            // { product(), showScreen(name) }
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ------------------------------------------------------------- storage */

function device() {
  try { return JSON.parse(localStorage.getItem(DEVICE_KEY) || "null"); } catch (e) { return null; }
}

function queue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch (e) { return []; }
}

function saveQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) {}
  paintSetupButton();
}

/* UK calendar date, YYYY-MM-DD: the day Jason saw the stock. */
export function ukToday(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(d);
}

/* ------------------------------------------------------------- network */

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function signedPost(action, payload) {
  const dev = device();
  if (!dev) throw new Error("NOT_ENROLLED");
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
  const body = new TextEncoder().encode(JSON.stringify(Object.assign({}, payload, { ts: Date.now(), nonce })));
  const key = await crypto.subtle.importKey("raw", hexToBytes(dev.key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, body)),
    (b) => b.toString(16).padStart(2, "0")).join("");
  const res = await fetch(OFFICE + action, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Restock-Device": dev.device_id, "X-Restock-Mac": mac },
    body,
  });
  const out = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("REFUSED:" + (out.error || "refused"));
  if (!res.ok || !out.ok) throw new Error("ERROR:" + (out.error || ("HTTP " + res.status)));
  return out;
}

/* ------------------------------------------------------------- product screen */

function box(html) { $("restockBox").innerHTML = html; }

export function paintProduct(p) {
  const dev = device();
  if (!dev || !p) { box(""); return; }
  box(`<button class="restock-btn" data-restock="check">Restock 12</button>`);
}

async function check(item, fromQueue) {
  box(`<div class="restock-msg">Checking ${esc(item.sku)} with the office…</div>`);
  let pv;
  try {
    pv = await signedPost("preview", { sku: item.sku, seen_on: item.seen_on });
  } catch (e) {
    const m = String(e.message || "");
    if (m.startsWith("REFUSED:")) {
      box(`<div class="restock-msg bad">The office refused this device: ${esc(m.slice(8))}. Set it up again.</div>`);
      return;
    }
    if (!fromQueue) enqueue(item);
    box(`<div class="restock-msg">No connection. ${fromQueue ? "Still queued" : "Queued"}: it will be checked when you
         have signal (a sighting counts for 2 working days). Restocks (${queue().length}) on the search screen.</div>`);
    return;
  }
  if (!pv.can_book) {
    if (fromQueue) dequeue(item);
    box(`<div class="restock-msg bad"><b>Not booked.</b> ${esc(pv.reason)}</div>`);
    return;
  }
  const onSale = pv.on_sale_now == null ? "" : ` · on sale now ${pv.on_sale_now}`;
  box(`<div class="restock-card">
      <div><b>Book ${pv.book_in} into ${esc(pv.bin)}</b></div>
      <div class="restock-sub">${esc(pv.title || pv.sku)} · value £0${onSale} · seen ${esc(pv.seen_on)}</div>
      ${(pv.notes || []).map((n) => `<div class="restock-sub">${esc(n)}</div>`).join("")}
      <button class="restock-btn go" data-restock="book" data-token="${esc(pv.token)}" data-store="${esc(pv.store)}">
        Book ${pv.book_in}: seen at ${esc(pv.store)}</button>
      <button class="restock-btn" data-restock="cancel">Cancel</button>
    </div>`);
  $("restockBox").dataset.sku = item.sku;
  $("restockBox").dataset.seen = item.seen_on;
  $("restockBox").dataset.queued = fromQueue ? "1" : "";
}

async function book(token, store) {
  const sku = $("restockBox").dataset.sku;
  const seen = $("restockBox").dataset.seen;
  box(`<div class="restock-msg">Booking…</div>`);
  let cm;
  try {
    cm = await signedPost("commit", { token, store });
  } catch (e) {
    box(`<div class="restock-msg bad">Could not reach the office: nothing was booked. Check it again.</div>`);
    return;
  }
  dequeue({ sku, seen_on: seen });
  if (cm.booked) {
    box(`<div class="restock-msg ok"><b>Booked ${cm.quantity} into ${esc(cm.bin)}.</b>
         ${cm.verified ? "Linnworks reads back " + esc(cm.bin_after) + " in the bin." :
           "Sent, but Linnworks did not read back as expected: check it in Linnworks."}
         The app's stock figure updates with tomorrow's catalogue.</div>`);
  } else {
    box(`<div class="restock-msg bad"><b>Not booked.</b> ${esc(cm.reason)}</div>`);
  }
}

/* ------------------------------------------------------------- queue */

function enqueue(item) {
  const q = queue().filter((x) => !(x.sku === item.sku && x.seen_on === item.seen_on));
  q.push({ sku: item.sku, title: item.title || "", seen_on: item.seen_on, queued_at: new Date().toISOString() });
  saveQueue(q);
}

function dequeue(item) {
  saveQueue(queue().filter((x) => !(x.sku === item.sku && x.seen_on === item.seen_on)));
}

function paintSetupButton() {
  const b = $("restockSetup");
  if (!b) return;
  const dev = device();
  const n = queue().length;
  b.style.display = "";
  b.textContent = !dev ? "Restock setup" : n ? `Restocks (${n})` : "Restock";
}

async function openPanel() {
  const dev = device();
  if (!dev) {
    const code = prompt("Type the restock code from the gateway (8 letters and numbers):");
    if (!code) return;
    try {
      const res = await fetch(OFFICE + "enrol", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) { alert("Not set up: " + (out.error || ("HTTP " + res.status))); return; }
      localStorage.setItem(DEVICE_KEY, JSON.stringify({ device_id: out.device_id, key: out.key, name: out.name }));
      alert(`This device can now restock as "${out.name}".`);
    } catch (e) {
      alert("Could not reach the office. Connect to wi-fi and try again.");
      return;
    }
    paintSetupButton();
    return;
  }
  const q = queue();
  let status = "checking…";
  $("restockPanelBody").innerHTML = "";
  ctx.showScreen("restockPanel");
  try {
    const s = await signedPost("status", {});
    status = s.switch_on ? "ON" : "OFF: the switch on the gateway is not set";
  } catch (e) {
    status = String(e.message || "").startsWith("REFUSED:") ? "this device is no longer allowed" : "no connection";
  }
  $("restockPanelBody").innerHTML =
    `<div class="restock-sub">Device: ${esc(dev.name)} · restock ${esc(status)}</div>` +
    (q.length ? q.map((x, i) => `<div class="row">
        <div class="t">${esc(x.title || x.sku)}</div>
        <div class="m">${esc(x.sku)} · seen ${esc(x.seen_on)}</div>
        <button class="restock-btn" data-qcheck="${i}">Check now</button>
        <button class="restock-btn" data-qdrop="${i}">Remove</button></div>`).join("")
      : `<div class="empty">No restocks waiting.</div>`);
}

/* ------------------------------------------------------------- wiring */

export function initRestock(context) {
  ctx = context;
  paintSetupButton();
  $("restockSetup").addEventListener("click", openPanel);
  $("restockPanelBack").addEventListener("click", () => ctx.showScreen("search"));
  $("restockBox").addEventListener("click", (e) => {
    const b = e.target.closest("[data-restock]");
    if (!b) return;
    const p = ctx.product();
    if (b.dataset.restock === "check" && p) check({ sku: p.s, title: p.t, seen_on: ukToday() }, false);
    else if (b.dataset.restock === "book") book(b.dataset.token, b.dataset.store);
    else if (b.dataset.restock === "cancel") paintProduct(p);
  });
  $("restockPanelBody").addEventListener("click", async (e) => {
    const c = e.target.closest("[data-qcheck]");
    const d = e.target.closest("[data-qdrop]");
    const q = queue();
    if (d) { q.splice(Number(d.dataset.qdrop), 1); saveQueue(q); openPanel(); return; }
    if (c) {
      const item = q[Number(c.dataset.qcheck)];
      const p = ctx.findSku(item.sku);
      if (p) ctx.openProduct(p);
      await check(item, true);
    }
  });
}
