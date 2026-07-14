/* app.js — UI glue for the UPN → SEPA (EPC) QR converter.
   Depends on globals: jsQR, qrcode (qrcode-generator), UPN2EPC (convert.js). */
(function () {
  'use strict';
  var A = window.UPN2EPC;

  var el = function (id) { return document.getElementById(id); };
  var inputCard = el('input-card');
  var resultCard = el('result-card');
  var camera = el('camera');
  var video = el('video');
  var messages = el('messages');
  var qrCanvas = el('qr-canvas');
  var epcRaw = el('epc-raw');
  var toast = el('toast');
  var screenStatus = el('screen-status');
  var screenStatusText = el('screen-status-text');

  var fName = el('f-name'), fIban = el('f-iban'), fAmount = el('f-amount'), fRef = el('f-ref');

  // Offscreen canvas reused for decoding camera frames / uploaded images.
  var scanCanvas = document.createElement('canvas');

  var stream = null;         // active camera MediaStream
  var captureStream = null;  // active screen-capture MediaStream
  var scanning = false;      // camera loop flag
  var cameraStarting = false;// guards the async getUserMedia window (double-tap)
  var screenTimer = null;    // screen-capture poll timer
  var lastCamScan = 0;       // throttle timestamp for the camera loop
  var parsed = null;         // last parsed UPN
  var purposeCode = '';      // carried through from the UPN, not user-edited

  // ---- QR text decoding (encoding-aware) ----------------------------------
  // The ZBS UPN QR standard mandates ISO-8859-2 (Latin-2), so we re-decode jsQR's
  // raw bytes as Latin-2 rather than trusting its UTF-8 guess (which mangles
  // č/š/ž). Payment-critical fields (IBAN, amount, reference, purpose code) are
  // all ASCII, so the encoding choice only ever affects display text — never the
  // correctness of the payment itself.
  function decodeQrText(result) {
    try {
      var arr = result.binaryData;
      if (arr && arr.length) {
        return new TextDecoder('iso-8859-2').decode(Uint8Array.from(arr));
      }
    } catch (e) { /* TextDecoder/label unsupported — fall through */ }
    return result.data || '';
  }

  function looksLikeUpn(text) {
    return String(text || '').trim().toUpperCase().indexOf('UPNQR') === 0;
  }

  // ---- amount helpers ------------------------------------------------------
  function centsToEuros(cents) {
    // Guard the SEPA ceiling so .toFixed() never emits exponential notation
    // (which would re-parse into a wrong amount).
    if (cents == null || cents <= 0 || !isFinite(cents) || cents > 99999999999) return '';
    return (cents / 100).toFixed(2);
  }
  function eurosToCents(str) {
    if (str == null) return null;
    var s = String(str).replace(/[^0-9.,-]/g, '');
    if (!s || s.indexOf('-') !== -1) return null; // amounts can't be negative
    // The LAST '.' or ',' is the decimal separator; any earlier ones are grouping.
    var dec = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    var intPart, fracPart;
    if (dec === -1) { intPart = s; fracPart = ''; }
    else { intPart = s.slice(0, dec).replace(/[.,]/g, ''); fracPart = s.slice(dec + 1).replace(/[.,]/g, ''); }
    if (!intPart && !fracPart) return null;
    var euros = parseFloat((intPart || '0') + '.' + (fracPart || '0'));
    if (!isFinite(euros)) return null;
    return Math.round(euros * 100);
  }

  // ---- results view --------------------------------------------------------
  function showResult(upn) {
    parsed = upn;
    purposeCode = upn.purposeCode || '';
    fName.value = upn.recipientName || '';
    fIban.value = A.normalizeIban(upn.recipientIban) || '';
    fAmount.value = centsToEuros(upn.amountCents);
    fRef.value = A.buildRemittance(upn);

    inputCard.classList.add('hidden');
    resultCard.classList.remove('hidden');
    // Re-trigger the entrance animation each time we land on a result.
    resultCard.classList.remove('reveal');
    void resultCard.offsetWidth;
    resultCard.classList.add('reveal');
    haptic();
    regenerate();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function haptic() {
    try { if (navigator.vibrate) navigator.vibrate(28); } catch (e) { /* no-op */ }
  }

  // Rebuild the EPC payload + QR from the (possibly edited) form fields.
  function regenerate() {
    var cents = eurosToCents(fAmount.value);
    var payload = A.buildEpcPayload({
      name: fName.value,
      iban: fIban.value,
      bic: '',
      amountCents: cents,
      purposeCode: purposeCode,
      remittance: fRef.value
    });
    renderQr(qrCanvas, payload);
    epcRaw.textContent = payload;
    renderMessages({
      recipientIban: A.normalizeIban(fIban.value),
      recipientName: fName.value.trim(),
      amountCents: cents
    });
  }

  function renderMessages(view) {
    var v = A.validate(view);
    var html = '';
    v.errors.forEach(function (m) { html += '<div class="msg error">' + esc(m) + '</div>'; });
    if (v.warnings.length) {
      html += '<div class="msg warn"><strong>Double-check before paying:</strong><ul>' +
        v.warnings.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul></div>';
    }
    messages.innerHTML = html;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---- QR rendering (qrcode-generator -> canvas) ---------------------------
  function renderQr(canvas, text) {
    qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8']; // EPC charset = UTF-8
    var qr = qrcode(0, 'M'); // type 0 = auto version; EPC mandates ECC level M
    qr.addData(text, 'Byte');
    qr.make();
    var count = qr.getModuleCount();
    var quiet = 4;                       // required quiet zone (modules)
    var total = count + quiet * 2;
    var scale = Math.max(2, Math.floor(680 / total)); // crisp internal resolution
    var size = total * scale;
    canvas.width = size; canvas.height = size;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
        }
      }
    }
  }

  // ---- decoding entry points ----------------------------------------------
  function handleDecodedText(text) {
    try {
      var upn = A.parseUpnQr(text);
      showResult(upn);
    } catch (e) {
      if (e && e.code === 'NOT_UPN') {
        showInputError('That QR code isn\'t a Slovenian UPN payment code. Scan the QR printed on a UPN bill (položnica).');
      } else {
        showInputError('Could not read that QR code. Please try again.');
      }
    }
  }

  function showInputError(msg) {
    inputCard.classList.remove('hidden');
    resultCard.classList.add('hidden');
    var box = el('input-buttons');
    var existing = document.getElementById('input-error');
    if (existing) existing.remove();
    var d = document.createElement('div');
    d.className = 'msg error'; d.id = 'input-error'; d.textContent = msg;
    box.parentNode.insertBefore(d, box);
  }
  function clearInputError() {
    var e = document.getElementById('input-error');
    if (e) e.remove();
  }

  // Downscale a live video frame to <= maxDim and try to decode a QR from it.
  // Bounds per-frame CPU/battery cost regardless of camera/screen resolution.
  function decodeFrame(v, maxDim) {
    var vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;
    var scale = Math.min(1, maxDim / Math.max(vw, vh));
    var w = Math.max(1, Math.round(vw * scale)), h = Math.max(1, Math.round(vh * scale));
    scanCanvas.width = w; scanCanvas.height = h;
    var ctx = scanCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, w, h);
    return jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
  }

  // ---- camera --------------------------------------------------------------
  function startCamera() {
    if (scanning || cameraStarting) return; // re-entry guard (double-tap during async getUserMedia)
    clearInputError();
    stopScreenCapture();                    // mutually exclusive with screen capture
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showInputError('Camera not available in this browser. Use "Upload image" instead.');
      return;
    }
    cameraStarting = true;
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false
    }).then(function (s) {
      stream = s;
      video.srcObject = s;
      video.setAttribute('playsinline', '');
      el('input-buttons').classList.add('hidden');
      document.querySelector('details.adv').classList.add('hidden');
      camera.classList.remove('hidden');
      setupTorch(s);
      // Playback can reject independently of permission (iOS autoplay/abort). If
      // so, release the already-live stream and restore the UI — don't leak it.
      video.play().then(function () {
        cameraStarting = false;
        scanning = true;
        lastCamScan = 0;
        requestAnimationFrame(scanLoop);
      }).catch(function () {
        cameraStarting = false;
        stopCamera();
        showInputError('Could not start the camera preview. Try again, or use "Upload image".');
      });
    }).catch(function () {
      cameraStarting = false;
      showInputError('Camera permission was denied. Allow camera access, or use "Upload image".');
    });
  }

  function stopCamera() {
    scanning = false;
    cameraStarting = false;
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    camera.classList.add('hidden');
    el('input-buttons').classList.remove('hidden');
    document.querySelector('details.adv').classList.remove('hidden');
  }

  function scanLoop() {
    if (!scanning) return;
    var t = nowMs();
    // Throttle to ~9 decodes/s — plenty for a static bill, far cheaper than 60fps.
    if (t - lastCamScan >= 110 && video.readyState === video.HAVE_ENOUGH_DATA) {
      lastCamScan = t;
      var result = decodeFrame(video, 1024);
      if (result) {
        var text = decodeQrText(result);
        if (looksLikeUpn(text)) { stopCamera(); handleDecodedText(text); return; }
      }
    }
    requestAnimationFrame(scanLoop);
  }

  function setupTorch(s) {
    var btn = el('btn-torch');
    var track = s.getVideoTracks()[0];
    var caps = track.getCapabilities ? track.getCapabilities() : {};
    if (!caps || !caps.torch) { btn.classList.add('hidden'); return; }
    var on = false;
    btn.classList.remove('hidden');
    btn.textContent = 'Torch'; // reset label in case a prior session left it "Torch off"
    btn.onclick = function () {
      on = !on;
      track.applyConstraints({ advanced: [{ torch: on }] }).catch(function () {});
      btn.textContent = on ? 'Torch off' : 'Torch';
    };
  }

  // ---- image file decoding -------------------------------------------------
  function handleFile(file) {
    if (!file) return;
    clearInputError();
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var w = img.naturalWidth, h = img.naturalHeight;
      var scale = Math.min(1, 1600 / Math.max(w, h)); // cap size for perf
      w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));
      scanCanvas.width = w; scanCanvas.height = h;
      var ctx = scanCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      var data = ctx.getImageData(0, 0, w, h);
      var result = jsQR(data.data, w, h, { inversionAttempts: 'attemptBoth' });
      if (result) { handleDecodedText(decodeQrText(result)); }
      else { showInputError('No QR code found in that image. Try a sharper, closer photo of just the code.'); }
    };
    img.onerror = function () { URL.revokeObjectURL(url); showInputError('Could not open that image file.'); };
    img.src = url;
  }

  // ---- screen capture ------------------------------------------------------
  // Grab a frame of a screen/window/tab the user picks and scan it for a QR.
  // The stream is released the instant we find a code (or give up) — we never
  // keep capturing the screen, and nothing leaves the device.
  function setScreenStatus(text) {
    if (text) { screenStatusText.textContent = text; screenStatus.classList.remove('hidden'); }
    else { screenStatus.classList.add('hidden'); }
  }

  function stopScreenCapture() {
    if (screenTimer) { clearTimeout(screenTimer); screenTimer = null; }
    if (captureStream) { captureStream.getTracks().forEach(function (t) { t.stop(); }); captureStream = null; }
    setScreenStatus('');
  }

  function startScreenCapture() {
    clearInputError();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showInputError('Screen capture isn\'t supported in this browser. Use "Upload image" instead.');
      return;
    }
    stopScreenCapture(); // re-entry: release any prior capture + timer first
    stopCamera();        // mutually exclusive with the camera
    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false })
      .then(function (s) {
        captureStream = s;
        // If the user stops sharing via the browser's own control, clean up —
        // but only if this is still the current capture (once, then auto-removed).
        var track = s.getVideoTracks()[0];
        if (track) track.addEventListener('ended', function () { if (captureStream === s) stopScreenCapture(); }, { once: true });

        var v = document.createElement('video');
        v.srcObject = s; v.muted = true; v.setAttribute('playsinline', '');
        v.play().then(function () {
          setScreenStatus('Looking for a QR code on your screen…');
          var stopAt = nowMs() + 8000; // give up after ~8s, then release the stream
          (function tick() {
            if (captureStream !== s) return; // superseded by a newer capture, or stopped
            var result = decodeFrame(v, 1600);
            if (result) {
              var text = decodeQrText(result);
              stopScreenCapture();
              if (looksLikeUpn(text)) { handleDecodedText(text); }
              else { showInputError('Found a QR on screen, but it isn\'t a Slovenian UPN payment code.'); }
              return;
            }
            if (nowMs() > stopAt) {
              stopScreenCapture();
              showInputError('No QR code found on the shared screen. Make sure the UPN code is fully visible, then try again.');
              return;
            }
            screenTimer = setTimeout(tick, 220); // ~5 scans/s, matches the 5fps source
          })();
        }).catch(function () {
          stopScreenCapture();
          showInputError('Could not read the screen capture. Please try again.');
        });
      })
      .catch(function () { /* user cancelled the picker or denied — no error needed */ });
  }

  function nowMs() {
    return (window.performance && performance.now) ? performance.now() : (+new Date());
  }

  // ---- actions -------------------------------------------------------------
  function downloadPng() {
    try {
      var link = document.createElement('a');
      link.download = 'sepa-payment-qr.png';
      link.href = qrCanvas.toDataURL('image/png');
      document.body.appendChild(link); link.click(); link.remove();
    } catch (e) { showToast('Could not save image'); }
  }

  function copyDetails() {
    var cents = eurosToCents(fAmount.value);
    var lines = [
      'Recipient: ' + fName.value,
      'IBAN: ' + A.normalizeIban(fIban.value),
      'Amount: ' + (cents ? 'EUR ' + (cents / 100).toFixed(2) : '(enter manually)'),
      'Reference: ' + fRef.value
    ];
    var text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { showToast('Copied'); },
        function () { showToast('Copy failed'); });
    } else {
      showToast('Copy not supported');
    }
  }

  var toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 1600);
  }

  function reset() {
    parsed = null;
    stopCamera();
    stopScreenCapture();
    resultCard.classList.add('hidden');
    inputCard.classList.remove('hidden');
    clearInputError();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---- wire up -------------------------------------------------------------
  el('btn-camera').addEventListener('click', startCamera); // self-manages mutual exclusivity
  el('btn-cam-cancel').addEventListener('click', stopCamera);
  el('btn-upload').addEventListener('click', function () { el('file-input').click(); });
  el('file-input').addEventListener('change', function (e) {
    if (e.target.files && e.target.files[0]) {
      stopCamera(); stopScreenCapture(); // cancel any in-flight scan so it can't clobber the result
      handleFile(e.target.files[0]);
    }
    e.target.value = ''; // allow re-selecting the same file
  });

  // "Capture screen" — only offered where the browser supports it.
  var btnScreen = el('btn-screen');
  if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
    btnScreen.hidden = false;
    btnScreen.addEventListener('click', startScreenCapture); // self-manages mutual exclusivity
  }

  el('btn-paste').addEventListener('click', function () {
    var t = el('paste-text').value;
    if (t.trim()) { stopCamera(); stopScreenCapture(); handleDecodedText(t); }
  });

  // Paste a QR screenshot from the clipboard anywhere.
  document.addEventListener('paste', function (e) {
    if (!e.clipboardData) return;
    var items = e.clipboardData.items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image') === 0) {
        var file = items[i].getAsFile();
        if (file) { e.preventDefault(); stopCamera(); stopScreenCapture(); handleFile(file); return; }
      }
    }
  });

  ['input', 'change'].forEach(function (ev) {
    [fName, fIban, fAmount, fRef].forEach(function (f) { f.addEventListener(ev, regenerate); });
  });
  el('btn-download').addEventListener('click', downloadPng);
  el('btn-copy').addEventListener('click', copyDetails);
  el('btn-again').addEventListener('click', reset);

  // Release the camera / screen capture when the tab is hidden.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (scanning) stopCamera(); stopScreenCapture(); }
  });
})();
