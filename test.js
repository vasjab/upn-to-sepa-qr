/* Node test for convert.js — run with: node test.js */
const A = require('./convert.js');

let pass = 0, fail = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.error('FAIL: ' + msg + '\n   expected: ' + e + '\n   actual:   ' + a); }
}
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('FAIL: ' + msg); } }

// A realistic UPN QR payload (the text a UPN QR encodes). 20 LF-separated lines.
const sampleUpn = [
  'UPNQR',
  '',                       // payer IBAN
  '',                       // deposit
  '',                       // withdrawal
  '',                       // payer reference
  'JOŽE NOVAK',             // payer name (contains Ž)
  'DUNAJSKA CESTA 1',
  '1000 LJUBLJANA',
  '00000012345',            // amount = 123.45 EUR
  '',                       // payment date
  '',                       // urgent
  'OTHR',                   // purpose code
  'Plačilo računa 2024-001',// purpose text (č)
  '17.07.2026',             // due date
  'SI56263300012039086',    // recipient IBAN (valid SI example)
  'SI121234567890',         // recipient reference (sklic)
  'ELEKTRO LJUBLJANA D.D.', // recipient name
  'SLOVENSKA CESTA 58',
  '1000 LJUBLJANA',
  '183'                     // control sum
].join('\n');

// --- parsing ---
const p = A.parseUpnQr(sampleUpn);
eq(p.recipientName, 'ELEKTRO LJUBLJANA D.D.', 'recipient name');
eq(p.recipientIban, 'SI56263300012039086', 'recipient IBAN');
eq(p.recipientReference, 'SI121234567890', 'recipient reference');
eq(p.purposeCode, 'OTHR', 'purpose code');
eq(p.purposeText, 'Plačilo računa 2024-001', 'purpose text preserved (č)');
eq(p.amountCents, 12345, 'amount parsed to cents');

// --- amount bounds (reject absurd/overflowing amounts) ---
eq(A.parseUpnAmountCents('99999999999'), 99999999999, 'max amount (999,999,999.99) accepted');
eq(A.parseUpnAmountCents('100000000000'), null, 'over-max amount -> null');
eq(A.parseUpnAmountCents('999999999999999999999999'), null, 'absurd 24-digit amount -> null (no silent wrap)');
eq(A.parseUpnAmountCents('00000012345'), 12345, 'normal padded amount still parses');

// --- IBAN validation ---
ok(A.isValidIban('SI56263300012039086'), 'valid SI IBAN passes checksum');
ok(!A.isValidIban('SI56263300012039087'), 'tampered SI IBAN fails checksum');
ok(A.isValidIban('DE89370400440532013000'), 'valid DE IBAN passes checksum');

// --- reference formatting ---
eq(A.formatSiReference('SI121234567890'), 'SI12 1234567890', 'SI ref gets a space after model');
eq(A.formatSiReference('SI99'), '', 'SI99 with no digits -> empty');
eq(A.formatSiReference('SI00'), '', 'SI00 with no digits -> empty');
eq(A.formatSiReference(''), '', 'empty ref -> empty');

// --- amount formatting ---
eq(A.formatEpcAmount(12345), 'EUR123.45', 'amount -> EUR123.45');
eq(A.formatEpcAmount(5), 'EUR0.05', 'small amount padded to 2 decimals');
eq(A.formatEpcAmount(0), '', 'zero amount omitted');
eq(A.formatEpcAmount(null), '', 'null amount omitted');
eq(A.formatEpcAmount(100000), 'EUR1000.00', 'thousands, no separator');

// --- full EPC payload ---
const epc = A.upnToEpc(p);
const epcLines = epc.split('\n');
eq(epcLines[0], 'BCD', 'EPC service tag');
eq(epcLines[1], '002', 'EPC version 002');
eq(epcLines[2], '1', 'EPC charset 1 (UTF-8)');
eq(epcLines[3], 'SCT', 'EPC identification SCT');
eq(epcLines[4], '', 'EPC BIC empty (optional in v002)');
eq(epcLines[5], 'ELEKTRO LJUBLJANA D.D.', 'EPC beneficiary name');
eq(epcLines[6], 'SI56263300012039086', 'EPC IBAN');
eq(epcLines[7], 'EUR123.45', 'EPC amount');
eq(epcLines[8], 'OTHR', 'EPC purpose');
eq(epcLines[9], '', 'EPC structured remittance empty');
eq(epcLines[10], 'SI12 1234567890 Plačilo računa 2024-001', 'EPC unstructured remittance = ref + purpose');
ok(epcLines.length === 11, 'trailing empty (line 11) trimmed -> 11 lines');
ok(Buffer.byteLength(epc, 'utf8') <= 331, 'EPC payload within 331 bytes (' + Buffer.byteLength(epc,'utf8') + ')');

// --- open-amount bill ---
const openUpn = sampleUpn.replace('00000012345', '00000000000');
const po = A.parseUpnQr(openUpn);
eq(po.amountCents, 0, 'zero amount parsed');
const epcOpen = A.upnToEpc(po).split('\n');
eq(epcOpen[7], '', 'open amount -> EPC amount line empty');

// --- SI99 (no structured reference) ---
const noRefUpn = sampleUpn.replace('SI121234567890', 'SI99');
const pn = A.parseUpnQr(noRefUpn);
eq(A.upnToEpc(pn).split('\n')[10], 'Plačilo računa 2024-001', 'SI99 -> remittance is purpose only');

// --- validation surfaces problems ---
const v = A.validate(p);
eq(v.errors, [], 'valid sample -> no errors');
const vBad = A.validate(A.parseUpnQr(sampleUpn.replace('SI56263300012039086', '')));
ok(vBad.errors.length === 1, 'missing IBAN -> one error');

// --- 331-byte EPC ceiling is enforced by trimming remittance ---
const longPurpose = 'X'.repeat(300);
const bigUpn = sampleUpn.replace('Plačilo računa 2024-001', longPurpose);
const epcBig = A.upnToEpc(A.parseUpnQr(bigUpn));
ok(A.utf8Len(epcBig) <= A.EPC_MAX_BYTES, 'oversized payload trimmed to <=331 bytes (' + A.utf8Len(epcBig) + ')');
ok(epcBig.split('\n')[6] === 'SI56263300012039086', 'IBAN preserved when remittance trimmed');
ok(epcBig.split('\n')[7] === 'EUR123.45', 'amount preserved when remittance trimmed');

// --- oversized non-remittance fields (BIC/IBAN) can't blow the ceiling ---
const epcLongBic = A.buildEpcPayload({ name: 'N', iban: 'SI56263300012039086', bic: 'X'.repeat(400), amountCents: 1, purposeCode: '', remittance: 'short' });
ok(A.utf8Len(epcLongBic) <= A.EPC_MAX_BYTES, 'long BIC clipped -> payload <=331 (' + A.utf8Len(epcLongBic) + ')');
ok(epcLongBic.split('\n')[4].length <= 11, 'BIC clipped to <=11 chars');
const epcLongIban = A.buildEpcPayload({ name: 'N', iban: 'SI' + '9'.repeat(60), bic: '', amountCents: 1, purposeCode: '', remittance: 'x' });
ok(epcLongIban.split('\n')[6].length <= 34, 'IBAN clipped to <=34 chars');

// --- RF (ISO 11649) reference passes through into remittance ---
const rfUpn = sampleUpn.replace('SI121234567890', 'RF18539007547034');
eq(A.upnToEpc(A.parseUpnQr(rfUpn)).split('\n')[10], 'RF18539007547034 Plačilo računa 2024-001', 'RF ref carried in remittance');

// --- non-UPN input throws ---
let threw = false;
try { A.parseUpnQr('http://example.com/pay?x=1'); } catch (e) { threw = (e.code === 'NOT_UPN'); }
ok(threw, 'non-UPN input throws NOT_UPN');

// --- ISO-8859-2 decode path (mirrors what the browser does with jsQR bytes) ---
// Encode "JOŽE ČŠŽ" in ISO-8859-2 byte values and decode back.
const latin2 = { 'Ž': 0xAE, 'Č': 0xC8, 'Š': 0xA9, 'ž': 0xBE, 'č': 0xE8, 'š': 0xB9 };
function encLatin2(s){ return Uint8Array.from([...s].map(ch => latin2[ch] != null ? latin2[ch] : ch.charCodeAt(0))); }
const bytes = encLatin2('JOŽE ČŠŽ');
const decoded = new TextDecoder('iso-8859-2').decode(bytes);
eq(decoded, 'JOŽE ČŠŽ', 'ISO-8859-2 round-trips Slovenian chars');
// And that same byte stream is NOT valid UTF-8 (so the browser heuristic picks Latin-2)
let utf8Fatal = false;
try { new TextDecoder('utf-8', {fatal:true}).decode(bytes); } catch(e){ utf8Fatal = true; }
ok(utf8Fatal, 'Latin-2 Slovenian bytes are rejected by strict UTF-8 (heuristic works)');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
