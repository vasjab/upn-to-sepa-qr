/*
 * convert.js — Slovenian UPN QR  ->  EPC (SEPA) QR conversion logic.
 *
 * Pure, DOM-free, environment-agnostic. Runs in the browser (attaches to
 * window.UPN2EPC) and in Node (module.exports) so the same code is unit-tested.
 *
 * Two standards involved:
 *   UPN QR  — ZBS (Bank Association of Slovenia) "UPN QR" positional text format,
 *             ~19 LF-separated lines, starts with "UPNQR". Encoding: ISO-8859-2.
 *   EPC QR  — EPC069-12 "GiroCode" / SEPA Credit Transfer QR. The format Revolut,
 *             N26 and most EU banking apps scan to pre-fill a SEPA transfer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UPN2EPC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- helpers -------------------------------------------------------------

  function sanitize(s) {
    // Flatten to a single clean line: no CR/LF/TAB, collapse runs of spaces.
    return String(s == null ? '' : s)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function clip(s, n) {
    s = String(s == null ? '' : s);
    // Length is measured in JS characters; EPC field limits are character counts.
    return s.length > n ? s.slice(0, n).trim() : s;
  }

  // UTF-8 byte length without depending on TextEncoder (works in Node + browser).
  function utf8Len(s) {
    s = String(s == null ? '' : s);
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; } // surrogate pair
      else n += 3;
    }
    return n;
  }

  var EPC_MAX_BYTES = 331; // EPC069-12: keeps the symbol within QR version 13 at ECC-M.

  function normalizeIban(iban) {
    return String(iban == null ? '' : iban).replace(/\s+/g, '').toUpperCase();
  }

  // ISO 7064 mod-97-10 IBAN check. Returns true if the IBAN checksum is valid.
  function isValidIban(iban) {
    var s = normalizeIban(iban);
    if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(s)) return false;
    var rearranged = s.slice(4) + s.slice(0, 4);
    var rem = 0;
    for (var i = 0; i < rearranged.length; i++) {
      var c = rearranged.charCodeAt(i);
      var val = c >= 65 ? c - 55 : c - 48; // A-Z -> 10..35, 0-9 -> 0..9
      // Feed digit-by-digit to keep the running remainder small.
      var digits = val > 9 ? String(val) : String(val);
      for (var j = 0; j < digits.length; j++) {
        rem = (rem * 10 + (digits.charCodeAt(j) - 48)) % 97;
      }
    }
    return rem === 1;
  }

  // ---- UPN QR parsing ------------------------------------------------------

  // Parse the UPN QR amount field. Per the ZBS standard it is 11 digits in
  // euro-cents, zero-padded (e.g. "00000012345" -> 12345 cents -> 123.45 EUR).
  // Returns integer cents, or null when there is no amount.
  function parseUpnAmountCents(raw) {
    var digits = String(raw == null ? '' : raw).replace(/[^0-9]/g, '');
    if (!digits) return null;
    var cents = parseInt(digits, 10);
    // Reject absurd/overflowing amounts (max is 999,999,999.99 = 11-digit cents).
    // Anything larger is a malformed field — treat as "no amount" so it can't
    // silently round-trip through exponential notation into a wrong value.
    if (!isFinite(cents) || cents < 0 || cents > 99999999999) return null;
    return cents;
  }

  // Format a Slovenian reference (sklic) for human-readable remittance text.
  // Input like "SI00123456789" -> "SI00 123456789". "SI99"/empty -> "".
  function formatSiReference(raw) {
    var r = sanitize(raw).replace(/\s+/g, '').toUpperCase();
    if (!r) return '';
    var m = r.match(/^SI(\d{2})(.*)$/);
    if (!m) return r; // Unknown shape — pass through untouched.
    var model = m[1];
    var rest = m[2];
    if (!rest) return ''; // Bare "SIxx" with no digits carries no reference.
    return 'SI' + model + ' ' + rest;
  }

  var UPN_FIELDS = [
    'tag',              // 0  "UPNQR"
    'payerIban',        // 1
    'payerDeposit',     // 2  polog
    'payerWithdrawal',  // 3  dvig
    'payerReference',   // 4
    'payerName',        // 5
    'payerStreet',      // 6
    'payerCity',        // 7
    'amountRaw',        // 8  znesek (11-digit cents)
    'paymentDate',      // 9  datum plačila
    'urgent',           // 10 nujno
    'purposeCode',      // 11 koda namena (SEPA purpose, 4 chars)
    'purposeText',      // 12 namen / opis plačila
    'dueDate',          // 13 rok plačila
    'recipientIban',    // 14 IBAN prejemnika
    'recipientReference', // 15 referenca prejemnika (sklic)
    'recipientName',    // 16 ime prejemnika
    'recipientStreet',  // 17 ulica prejemnika
    'recipientCity',    // 18 kraj prejemnika
    'controlSum'        // 19 kontrolna vsota (payload length)
  ];

  function parseUpnQr(rawText) {
    var text = String(rawText == null ? '' : rawText)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
    var lines = text.split('\n');

    if ((lines[0] || '').trim().toUpperCase() !== 'UPNQR') {
      var err = new Error('This does not look like a Slovenian UPN QR code.');
      err.code = 'NOT_UPN';
      throw err;
    }

    var out = {};
    for (var i = 0; i < UPN_FIELDS.length; i++) {
      out[UPN_FIELDS[i]] = (lines[i] != null ? String(lines[i]) : '').trim();
    }
    out.recipientIban = normalizeIban(out.recipientIban);
    out.amountCents = parseUpnAmountCents(out.amountRaw);
    return out;
  }

  // ---- EPC QR building -----------------------------------------------------

  // Compose the remittance/purpose text a foreign SEPA transfer should carry.
  // SI references are NOT ISO-11649 (RF) references, so we cannot put them in
  // the EPC *structured* field — they go into the unstructured remittance text,
  // which is exactly where a Slovenian payee reads/reconciles them from.
  function buildRemittance(parsed) {
    var ref = formatSiReference(parsed.recipientReference);
    var parts = [];
    if (ref) parts.push(ref);
    if (parsed.purposeText) parts.push(sanitize(parsed.purposeText));
    return clip(sanitize(parts.join(' ')), 140);
  }

  function formatEpcAmount(cents) {
    if (cents == null || cents <= 0) return '';       // open amount -> omit
    if (cents > 99999999999) return '';               // > 999,999,999.99 invalid
    return 'EUR' + (cents / 100).toFixed(2);
  }

  // Build the EPC (EPC069-12) payload string. Version 002 => BIC optional, so a
  // BIC-less Slovenian payment is fully valid (SEPA routes by IBAN anyway).
  function buildEpcPayload(input) {
    var name = clip(sanitize(input.name), 70);
    var iban = clip(normalizeIban(input.iban), 34);  // IBAN max length
    var bic = clip(normalizeIban(input.bic), 11);    // BIC is 8 or 11 chars; usually empty
    var amountLine = formatEpcAmount(input.amountCents);
    var purpose = clip(sanitize(input.purposeCode).toUpperCase().replace(/[^A-Z]/g, ''), 4);
    var remittance = clip(sanitize(input.remittance), 140);

    function assemble(rem) {
      var lines = [
        'BCD',        // 0  Service Tag
        '002',        // 1  Version (002: BIC optional)
        '1',          // 2  Character set (1 = UTF-8)
        'SCT',        // 3  Identification (SEPA Credit Transfer)
        bic,          // 4  BIC of beneficiary bank (optional in v002)
        name,         // 5  Name of beneficiary (max 70)
        iban,         // 6  IBAN of beneficiary
        amountLine,   // 7  Amount, e.g. EUR123.45 (optional)
        purpose,      // 8  Purpose code (optional, 4 chars)
        '',           // 9  Structured remittance (unused — SI refs aren't RF)
        rem,          // 10 Unstructured remittance (max 140)
        ''            // 11 Beneficiary-to-originator info (optional)
      ];
      // EPC allows trailing unused elements to be omitted.
      while (lines.length > 6 && lines[lines.length - 1] === '') lines.pop();
      return lines.join('\n');
    }

    // Enforce the 331-byte EPC ceiling by trimming the unstructured remittance.
    // Every other field is length-bounded (name<=70, iban<=34, bic<=11, amount,
    // purpose<=4), so the fixed portion alone always stays well under 331 — which
    // guarantees this loop can reach a payload that fits, not just shrink to empty.
    var payload = assemble(remittance);
    while (remittance.length > 0 && utf8Len(payload) > EPC_MAX_BYTES) {
      remittance = remittance.slice(0, -1).trim();
      payload = assemble(remittance);
    }
    return payload;
  }

  // Validate a parsed UPN for the essentials needed to pay. Returns
  // { errors: [...], warnings: [...] }.
  function validate(parsed) {
    var errors = [];
    var warnings = [];
    if (!parsed.recipientIban) {
      errors.push('No recipient IBAN found in the QR code.');
    } else if (!isValidIban(parsed.recipientIban)) {
      warnings.push('The recipient IBAN failed its checksum — double-check it before paying.');
    }
    if (!parsed.recipientName) {
      warnings.push('No recipient name found in the QR code.');
    }
    if (parsed.amountCents == null || parsed.amountCents <= 0) {
      warnings.push('No amount was set in the QR code — enter it manually before paying.');
    }
    return { errors: errors, warnings: warnings };
  }

  // One-shot convenience: parsed UPN -> EPC payload using defaults.
  function upnToEpc(parsed) {
    return buildEpcPayload({
      name: parsed.recipientName,
      iban: parsed.recipientIban,
      bic: '',
      amountCents: parsed.amountCents,
      purposeCode: parsed.purposeCode,
      remittance: buildRemittance(parsed)
    });
  }

  return {
    parseUpnQr: parseUpnQr,
    parseUpnAmountCents: parseUpnAmountCents,
    formatSiReference: formatSiReference,
    buildRemittance: buildRemittance,
    formatEpcAmount: formatEpcAmount,
    buildEpcPayload: buildEpcPayload,
    upnToEpc: upnToEpc,
    validate: validate,
    isValidIban: isValidIban,
    normalizeIban: normalizeIban,
    utf8Len: utf8Len,
    EPC_MAX_BYTES: EPC_MAX_BYTES,
    UPN_FIELDS: UPN_FIELDS
  };
});
