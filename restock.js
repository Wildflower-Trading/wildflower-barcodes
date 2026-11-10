/* Restock from the barcode app (Jason only, 8 Nov 2026).

   Walking Costco or Booker, Jason scans a line that shows no stock and books 12 units
   back into its Costco / Booker pick bin "to get the product back into the mix".

   Only a device enrolled with a one-time code from the gateway sees the button. That
   device holds its own random key and signs every request with it; the catalogue
   passcode is never used for a restock. Two steps, both on the gateway: "check" asks
   the stock tool what it would book (bin, 12 units, value 0, or why not); "book"
   books exactly that after Jason confirms the store. With no signal the request is
   queued and checked later: a sighting is valid for 2 working days.

   10 Nov 2026: a line with more than one Costco / Booker bin (The Wild Mushroom: Seasonings /
   Spices and Catering Fruit / Choc / Juice) comes back with its bins; each is a button, and
   the tapped bin is checked again by the stock tool before anything can be booked.

   "Other bin…" lists every Warehouse A bin on the line's default supplier side (C - for
   Costco, B - for Booker) with a search box. A bin the line has no row in is booked as a
   NEW bin: the stock tool makes the row, and refuses while the line's cost is a placeholder. */

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

/* ------------------------------------------------------------- supplier cost */

/* The Supplier tab "Purchase price" for the product's Booker / Costco links, from
   the morning catalogue: p.u = [[shop, code, cost, default 0/1, pack size], ...],
   p.ds = the default supplier when it is not Booker or Costco. Ex VAT, per
   Linnworks unit; Linnworks keeps no date against it. */
const PLACEHOLDER = [0, 0.01, 1];

function costNote(r) {
  const [shop, , cost, , pack] = r;
  const bits = [];
  if (PLACEHOLDER.includes(cost)) bits.push("placeholder cost, not a real price");
  else if (shop === "Costco" && Math.round(cost * 100) % 100 === 97) bits.push(".97 = Costco clearance price");
  if (pack > 1) bits.push(`supplier pack ${pack}`);
  return bits.length ? ` (${bits.join(", ")})` : "";
}

export function costLines(p) {
  if (!p) return [];
  const rows = p.u || [];
  const out = [];
  if (rows.length) {
    out.push("Linnworks supplier cost (ex VAT, per our unit):");
    for (const r of rows) {
      out.push(`${r[0]}${r[1] ? " " + r[1] : ""}: £${Number(r[2]).toFixed(2)}${r[3] ? " default" : ""}${costNote(r)}`);
    }
  } else if (!p.ds) {
    out.push("No Booker / Costco cost in Linnworks.");
  }
  if (p.ds) out.push(`Default supplier: ${p.ds} (not Booker / Costco)`);
  return out;
}

function defaultCost(p) {
  const r = ((p && p.u) || []).find((x) => x[3]);
  return r ? `Linnworks cost £${Number(r[2]).toFixed(2)} (${r[0]}${r[1] ? " " + r[1] : ""})${costNote(r)}: check the shelf price ex VAT` : "";
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
    pv = await signedPost("preview", Object.assign({ sku: item.sku, seen_on: item.seen_on },
      item.bin ? { bin: item.bin } : {}, item.bin && item.new_bin ? { new_bin: true } : {}));
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
  remember(item, fromQueue);
  if (!pv.can_book && Array.isArray(pv.bins) && pv.bins.length > 1 && !item.bin) {
    $("restockBox").dataset.bins = JSON.stringify(pv.bins);
    paintBinChoice(pv.bins);
    return;
  }
  if (!pv.can_book) {
    if (fromQueue) dequeue(item);
    const noRow = /no [BC] - bin row/.test(String(pv.reason || ""));
    box(`<div class="restock-msg bad"><b>Not booked.</b> ${esc(pv.reason)}</div>
         ${noRow || item.bin ? `<button class="restock-btn" data-restock="other">${noRow ? "Pick a bin" : "Other bin…"}</button>` : ""}`);
    return;
  }
  const onSale = pv.on_sale_now == null ? "" : ` · on sale now ${pv.on_sale_now}`;
  box(`<div class="restock-card">
      <div><b>Book ${pv.book_in} into ${esc(pv.bin)}</b></div>
      ${pv.new_bin ? `<div class="restock-sub restock-new">NEW bin for this line: Linnworks will add it</div>` : ""}
      <div class="restock-sub">${esc(pv.title || pv.sku)} · value £0${onSale} · seen ${esc(pv.seen_on)}</div>
      ${(pv.notes || []).map((n) => `<div class="restock-sub">${esc(n)}</div>`).join("")}
      ${defaultCost(ctx.product()) ? `<div class="restock-sub restock-cost">${esc(defaultCost(ctx.product()))}</div>` : ""}
      <button class="restock-btn go" data-restock="book" data-token="${esc(pv.token)}" data-store="${esc(pv.store)}">
        Book ${pv.book_in}: seen at ${esc(pv.store)}</button>
      <button class="restock-btn" data-restock="rebin">Other bin</button>
      <button class="restock-btn" data-restock="cancel">Cancel</button>
    </div>`);
}

function remember(item, fromQueue) {
  const d = $("restockBox").dataset;
  if (!item.bin && d.sku !== item.sku) d.bins = "";
  d.sku = item.sku;
  d.seen = item.seen_on;
  d.title = item.title || "";
  d.queued = fromQueue ? "1" : "";
}

function paintBinChoice(bins) {
  box(`<div class="restock-card">
      <div><b>Which bin?</b></div>
      <div class="restock-sub">This line has ${bins.length} Costco / Booker bins in Linnworks. Tap the one to book 12 into.
        Nothing is booked until you confirm on the next screen.</div>
      ${bins.map((b) => `<button class="restock-btn restock-bin" data-restock="bin" data-bin="${esc(b)}">${esc(b)}</button>`).join("")}
      <button class="restock-btn" data-restock="other">Other bin…</button>
      <button class="restock-btn" data-restock="cancel">Cancel</button>
    </div>`);
}

/* Every bin on the line's side, from Linnworks' own bin list, with a search box. */
async function paintOtherBins() {
  const d = $("restockBox").dataset;
  box(`<div class="restock-msg">Fetching the bin list…</div>`);
  let out;
  try {
    out = await signedPost("bins", { sku: d.sku });
  } catch (e) {
    box(`<div class="restock-msg bad">Could not reach the office for the bin list. Try again with signal.</div>
         <button class="restock-btn" data-restock="cancel">Back</button>`);
    return;
  }
  const bins = Array.isArray(out.bins) ? out.bins : [];
  if (!bins.length) {
    box(`<div class="restock-msg bad"><b>No bin list.</b> ${esc(out.reason || "nothing came back")}</div>
         <button class="restock-btn" data-restock="cancel">Back</button>`);
    return;
  }
  const has = new Set((out.has || []).map((b) => b.toLowerCase()));
  box(`<div class="restock-card">
      <div><b>All ${esc(out.store)} bins (${esc(out.side)} -)</b></div>
      <div class="restock-sub">Tap the bin to book 12 into. A bin this line has never used becomes a NEW bin for it.
        Nothing is booked until you confirm on the next screen.</div>
      <input id="restockBinFilter" class="restock-filter" type="search" placeholder="Type to narrow, e.g. spice" autocomplete="off">
      <div id="restockBinList">
      ${bins.map((b) => `<button class="restock-btn restock-bin" data-restock="pick" data-bin="${esc(b)}"
          data-new="${has.has(b.toLowerCase()) ? "" : "1"}" data-key="${esc(b.toLowerCase())}">${esc(b)}${
          has.has(b.toLowerCase()) ? " · this line's bin" : ""}</button>`).join("")}
      </div>
      <button class="restock-btn" data-restock="cancel">Cancel</button>
    </div>`);
  const f = $("restockBinFilter");
  f.addEventListener("input", () => {
    const q = f.value.trim().toLowerCase();
    $("restockBinList").querySelectorAll("[data-key]").forEach((el) => {
      el.style.display = !q || el.dataset.key.includes(q) ? "" : "none";
    });
  });
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
    else if (b.dataset.restock === "bin") {
      const d = $("restockBox").dataset;
      check({ sku: d.sku, title: d.title, seen_on: d.seen, bin: b.dataset.bin }, d.queued === "1");
    } else if (b.dataset.restock === "pick") {
      const d = $("restockBox").dataset;
      check({ sku: d.sku, title: d.title, seen_on: d.seen, bin: b.dataset.bin, new_bin: b.dataset.new === "1" },
        d.queued === "1");
    } else if (b.dataset.restock === "other") {
      paintOtherBins();
    } else if (b.dataset.restock === "rebin") {
      let bins = [];
      try { bins = JSON.parse($("restockBox").dataset.bins || "[]"); } catch (err) { bins = []; }
      if (bins.length > 1) paintBinChoice(bins); else paintOtherBins();
    }
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
