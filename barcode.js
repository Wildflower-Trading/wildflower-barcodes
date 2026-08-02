/* Pure-JS EAN-13 / UPC-A / EAN-8 renderer -> SVG.
   No dependencies: the app must work with no network at all. */

const L = ["0001101","0011001","0010011","0111101","0100011",
           "0110001","0101111","0111011","0110111","0001011"];
const G = ["0100111","0110011","0011011","0100001","0011101",
           "0111001","0000101","0010001","0001001","0010111"];
const R = ["1110010","1100110","1101100","1000010","1011100",
           "1001110","1010000","1000100","1001000","1110100"];

// Which of the first six digits use G rather than L, keyed by the lead digit.
const PARITY = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG",
                "LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];

function gs1CheckDigit(body) {
  let total = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    total += Number(body[i]) * w;
  }
  return (10 - (total % 10)) % 10;
}

/* Returns { modules: "1011...", guards: [[start,end],...] } where guards are
   module ranges whose bars run longer, the way a real barcode looks. */
function encodeEAN13(code) {
  const parity = PARITY[Number(code[0])];
  let bits = "101";
  const guards = [[0, 3]];
  for (let i = 1; i <= 6; i++) {
    bits += (parity[i - 1] === "L" ? L : G)[Number(code[i])];
  }
  guards.push([bits.length, bits.length + 5]);
  bits += "01010";
  for (let i = 7; i <= 12; i++) bits += R[Number(code[i])];
  guards.push([bits.length, bits.length + 3]);
  bits += "101";
  return { modules: bits, guards };
}

function encodeEAN8(code) {
  let bits = "101";
  const guards = [[0, 3]];
  for (let i = 0; i < 4; i++) bits += L[Number(code[i])];
  guards.push([bits.length, bits.length + 5]);
  bits += "01010";
  for (let i = 4; i < 8; i++) bits += R[Number(code[i])];
  guards.push([bits.length, bits.length + 3]);
  bits += "101";
  return { modules: bits, guards };
}

/* Human-readable digits, as module-coordinate spans sitting under the group of
   bars that actually encodes them. Each span is drawn with an explicit
   textLength so the digits can never overrun each other whatever the font. */
function textLayout(code, symbology) {
  if (symbology === "EAN8") {
    return [
      { text: code.slice(0, 4), from: 4, to: 30 },
      { text: code.slice(4, 8), from: 37, to: 63 },
    ];
  }
  if (symbology === "UPCA") {
    // Rendered from "0"+code, so code[0] lives at modules 3-10, code[11] at 85-92.
    return [
      { text: code[0], from: 3, to: 9 },
      { text: code.slice(1, 6), from: 11, to: 44 },
      { text: code.slice(6, 11), from: 51, to: 84 },
      { text: code[11], from: 86, to: 92 },
    ];
  }
  return [
    { text: code[0], from: -9, to: -3 },      // lead digit sits in the quiet zone
    { text: code.slice(1, 7), from: 4, to: 44 },
    { text: code.slice(7, 13), from: 51, to: 91 },
  ];
}

/**
 * Render a barcode as an SVG string.
 * @param {string} code   digits only, already validated
 * @param {string} symbology  "EAN13" | "UPCA" | "EAN8"
 */
export function renderBarcode(code, symbology, opts = {}) {
  let encodeInput = code;
  if (symbology === "UPCA") encodeInput = "0" + code;   // UPC-A == EAN-13 with a leading zero

  const { modules, guards } =
    symbology === "EAN8" ? encodeEAN8(code) : encodeEAN13(encodeInput);

  const quiet = 11;                       // mandatory quiet zone, in modules
  const width = modules.length + quiet * 2;
  // Bar height is deliberately tunable. Upright, the screen's width caps the
  // symbol length, so tall bars are free. Rotated, the symbol runs down the
  // long axis and it is the bar height that has to fit across the screen, so
  // shorter bars buy a substantially longer - and easier to scan - symbol.
  const barH = opts.barHeight || 62;
  const guardExtra = Math.max(4, Math.round(barH * 0.11));
  const textH = 11;
  const height = barH + guardExtra + textH + 2;

  const isGuard = new Array(modules.length).fill(false);
  for (const [from, to] of guards) {
    for (let i = from; i < to; i++) isGuard[i] = true;
  }

  let rects = "";
  let i = 0;
  while (i < modules.length) {
    if (modules[i] === "0") { i++; continue; }
    const start = i;
    const guard = isGuard[i];
    while (i < modules.length && modules[i] === "1" && isGuard[i] === guard) i++;
    const h = barH + (guard ? guardExtra : 0);
    rects += `<rect x="${quiet + start}" y="0" width="${i - start}" height="${h}"/>`;
  }

  let text = "";
  for (const part of textLayout(code, symbology)) {
    const x = quiet + part.from;
    const len = part.to - part.from;
    text += `<text x="${x}" y="${height - 2}" font-size="${textH}" ` +
            `textLength="${len}" lengthAdjust="spacingAndGlyphs" ` +
            `font-family="Menlo,Consolas,monospace">${part.text}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
         `width="100%" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">` +
         `<rect x="0" y="0" width="${width}" height="${height}" fill="#fff"/>` +
         `<g fill="#000">${rects}${text}</g></svg>`;
}

export { gs1CheckDigit };
