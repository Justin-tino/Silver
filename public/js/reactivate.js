// ============================================================
// SilverCare — Inactive Account Reactivation via Face Scan
// Step 1: find the senior account by OSCA / Senior Citizen ID →
// Step 2: face match against the stored registration/KYC face
// photo (same face-api.js library + models as the KYC tab).
// Step 3: the senior waits on this page while OSCA staff review
// the request — the screen polls the server and updates itself
// as soon as the request is approved (or not approved).
// ============================================================
(function () {
    'use strict';

    const MODELS_URL = 'https://justadudewhohacks.github.io/face-api.js/models';
    const MATCH_THRESHOLD = 0.6;

    let seniorId = '';
    let token = '';
    let modelsLoaded = false;
    let modelsLoading = null;       // in-flight model load promise (dedupes retries)
    let referenceDescriptor = null; // cached — the stored photo never changes during the session
    let stream = null;
    let lastDistance = null;
    let lastSnapshot = '';

    const $ = (id) => document.getElementById(id);

    function showStep(n) {
        [1, 2, 3].forEach(i => {
            const panel = $('step' + i);
            const dot = $('dot' + i);
            if (panel) panel.classList.toggle('show', i === n);
            if (dot) dot.classList.toggle('on', i === n);
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function setMsg(id, type, text) {
        const el = $(id);
        if (!el) return;
        el.className = 'msg' + (type ? ' ' + type : '');
        el.textContent = text || '';
        if (text) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function setBusy(btn, busy, label) {
        if (!btn) return;
        btn.disabled = !!busy;
        // Keep the FontAwesome icon — only swap the text node that follows it.
        const icon = btn.querySelector('i');
        if (label !== undefined) {
            if (icon && icon.nextSibling) {
                icon.nextSibling.textContent = ' ' + label;
            } else {
                btn.textContent = label;
            }
            delete btn.dataset.label;
        } else if (busy) {
            btn.dataset.label = (icon && icon.nextSibling ? icon.nextSibling.textContent : btn.textContent).trim();
            if (icon && icon.nextSibling) icon.nextSibling.textContent = ' Please wait…';
            else btn.textContent = 'Please wait…';
        } else if (btn.dataset.label) {
            if (icon && icon.nextSibling) icon.nextSibling.textContent = ' ' + btn.dataset.label;
            else btn.textContent = btn.dataset.label;
            delete btn.dataset.label;
        }
    }

    async function postJson(url, body) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });
        let data = {};
        try { data = await res.json(); } catch (e) { /* keep {} */ }
        if (!res.ok) throw new Error((data && data.message) || 'Request failed. Please try again.');
        return data;
    }

    // ---- Step 1: find the senior account by OSCA / Senior ID ----
    const findAccountBtn = $('findAccountBtn');
    async function findAccount() {
        const input = $('reactSeniorId');
        seniorId = (input && input.value ? input.value : '').trim();
        if (!seniorId) {
            setMsg('msg1', 'err', 'Please type your OSCA / Senior Citizen ID number.');
            return;
        }
        setBusy(findAccountBtn, true);
        setMsg('msg1', '', '');
        try {
            const data = await postJson('/api/reactivation/start', { seniorId });
            token = data.token || '';
            if (!token) throw new Error('Could not start the face scan. Please try again.');
            if (data.name) {
                $('faceHint').innerHTML = 'Hello, <strong>' + (data.name || 'Senior Citizen') + '</strong>! (OSCA ID ' +
                    (data.seniorId || seniorId) + ') Allow camera access, look straight at the camera with good light, then press <strong>Start Camera</strong> and <strong>Scan My Face</strong>.';
            }
            setMsg('msg1', 'ok', 'Account found! Please continue to the face scan.');
            // Move on right away — face recognition loads in the background on Step 2.
            showStep(2);
            setMsg('msg2', 'info', 'Loading face recognition… please wait a moment.');
            loadModelsInBackground();
        } catch (err) {
            setMsg('msg1', 'err', err.message);
        } finally {
            setBusy(findAccountBtn, false, 'Continue to Face Scan');
        }
    }
    if (findAccountBtn) findAccountBtn.addEventListener('click', findAccount);
    // Pressing Enter in the OSCA ID field should do the same as clicking Continue.
    const seniorIdInput = $('reactSeniorId');
    if (seniorIdInput) seniorIdInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); findAccount(); }
    });

    // ---- face-api.js helpers (same library + models as the KYC tab) ----
    // The face-api.js script tag loads from a CDN — it may not be ready the
    // moment Step 2 shows, so wait for the global to appear before giving up.
    function waitForFaceApi(timeoutMs) {
        return new Promise((resolve, reject) => {
            const started = Date.now();
            (function check() {
                if (typeof faceapi !== 'undefined') return resolve();
                if (Date.now() - started > timeoutMs) return reject(new Error('library'));
                setTimeout(check, 250);
            })();
        });
    }

    async function loadModelsInBackground() {
        if (modelsLoaded) { setMsg('msg2', '', ''); return; }
        if (modelsLoading) { await modelsLoading; return; }
        modelsLoading = (async () => {
            try {
                setMsg('msg2', 'info', 'Loading face recognition… this takes a few seconds on first use.');
                await waitForFaceApi(15000);
                await faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_URL);
                await faceapi.nets.faceLandmark68Net.loadFromUri(MODELS_URL);
                await faceapi.nets.faceRecognitionNet.loadFromUri(MODELS_URL);
                modelsLoaded = true;
                setMsg('msg2', 'info', 'Ready! Press Start Camera, then Scan My Face.');
            } catch (err) {
                console.error('Face model load failed:', err);
                modelsLoading = null; // allow the senior to retry by pressing Scan My Face
                setMsg('msg2', 'err', 'Face recognition could not load (internet is needed to load it once). Press "Scan My Face" to try again — or visit the OSCA office for help.');
            }
        })();
        await modelsLoading;
        if (modelsLoaded) modelsLoading = null;
    }

    const startCamBtn = $('startCamBtn');
    if (startCamBtn) startCamBtn.addEventListener('click', async () => {
        setMsg('msg2', '', '');
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('This device or browser does not support camera access. Please use a phone or computer with a camera.');
            }
            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
                audio: false
            });
            const video = $('liveVideo');
            video.srcObject = stream;
            await video.play().catch(() => {});
            $('scanBtn').disabled = false;
            setMsg('msg2', 'info', 'Camera is on. Look straight at the camera, then press Scan My Face.');
        } catch (err) {
            console.error('Camera error:', err);
            setMsg('msg2', 'err', 'Could not open the camera. Please allow camera permission in your browser, or visit the OSCA office for help.');
        }
    });

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    }

    function formatPercent(distance) {
        const pct = Math.max(0, Math.min(100, Math.round((1 - distance) * 100)));
        return pct + '%';
    }

    // ---- Step 2: scan + submit ----
    // Detector tuned for seniors' webcams: larger input + lower score threshold
    // catches faces at typical chair-to-webcam distance far more reliably.
    function detectorOptions() {
        return new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 });
    }

    const scanBtn = $('scanBtn');
    if (scanBtn) scanBtn.addEventListener('click', async () => {
        if (!token) { setMsg('msg2', 'err', 'Your session expired. Please start over.'); return; }
        const video = $('liveVideo');
        if (!video || !video.srcObject) { setMsg('msg2', 'err', 'Please press Start Camera first.'); return; }
        if (typeof faceapi === 'undefined' || !modelsLoaded) {
            // Not loaded yet — kick off a retry instead of dead-ending.
            setMsg('msg2', 'info', 'Face recognition is still loading — trying to finish loading it now…');
            await loadModelsInBackground();
            if (!modelsLoaded) return;
        }

        setBusy(scanBtn, true);
        setMsg('msg2', 'info', 'Scanning your face… please stay still and look at the camera.');
        $('matchText').textContent = '';
        $('matchFill').style.width = '0';
        $('submitBtn').disabled = true;
        lastDistance = null;

        try {
            // 1) Load the stored registration/KYC face photo (token-gated).
            //    It never changes during the session, so detect it only once
            //    and reuse the descriptor — repeat scans become much faster.
            if (!referenceDescriptor) {
                const refRes = await fetch('/api/reactivation/reference/' + encodeURIComponent(token));
                const refData = await refRes.json().catch(() => ({}));
                if (!refRes.ok) throw new Error((refData && refData.message) || 'Could not load your stored photo.');
                const refImg = await loadImage(refData.referenceImage);
                const refDet = await faceapi.detectSingleFace(refImg, detectorOptions()).withFaceLandmarks().withFaceDescriptor();
                if (!refDet) throw new Error('We could not read your stored photo. Please visit the OSCA office for help.');
                referenceDescriptor = refDet.descriptor;
            }

            // 2) Wait until the camera actually produces frames before detecting.
            if (!video.videoWidth) {
                await new Promise((resolve) => {
                    if (video.videoWidth) return resolve();
                    video.addEventListener('loadeddata', () => resolve(), { once: true });
                    setTimeout(resolve, 3000); // don't hang forever
                });
            }

            // 3) Detect the live face from the camera (retry once — a single
            //    frame can catch a blink, a motion blur or a half-turned head).
            let liveDet = await faceapi.detectSingleFace(video, detectorOptions()).withFaceLandmarks().withFaceDescriptor();
            if (!liveDet) {
                setMsg('msg2', 'info', 'Didn\u2019t catch your face yet — hold still, facing the light…');
                await new Promise((r) => setTimeout(r, 700));
                liveDet = await faceapi.detectSingleFace(video, detectorOptions()).withFaceLandmarks().withFaceDescriptor();
            }
            if (!liveDet) {
                setMsg('msg2', 'err', 'No face detected. Please move closer, face the light, remove sunglasses/mask, and try again.');
                return;
            }

            // 4) Compare.
            const distance = faceapi.euclideanDistance(referenceDescriptor, liveDet.descriptor);
            lastDistance = distance;
            const pct = formatPercent(distance);
            $('matchFill').style.width = pct;
            if (distance <= MATCH_THRESHOLD) {
                $('matchText').textContent = 'Match: ' + pct + ' ✓ — You may now send your request.';
                setMsg('msg2', 'ok', 'Face matched your registration photo (' + pct + '). Press "Send Reactivation Request".');

                // Snapshot the live frame for staff review.
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth || 640;
                canvas.height = video.videoHeight || 480;
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                lastSnapshot = canvas.toDataURL('image/jpeg', 0.75);
                $('submitBtn').disabled = false;
            } else {
                $('matchText').textContent = 'Match: ' + pct + ' — too low, please try again.';
                setMsg('msg2', 'err', 'Face did not match (' + pct + '). Face the camera clearly with good light and try again — or visit the OSCA office for help.');
            }
        } catch (err) {
            console.error('Face scan error:', err);
            setMsg('msg2', 'err', err.message || 'Face scan failed. Please try again.');
        } finally {
            setBusy(scanBtn, false, 'Scan My Face');
        }
    });

    const submitBtn = $('submitBtn');
    if (submitBtn) submitBtn.addEventListener('click', async () => {
        if (!token || lastDistance === null || !lastSnapshot) {
            setMsg('msg2', 'err', 'Please scan your face successfully first.');
            return;
        }
        setBusy(submitBtn, true);
        try {
            await postJson('/api/reactivation/submit', { token, distance: lastDistance, liveImage: lastSnapshot });
            if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
            $('scanBtn').disabled = true;
            enterWaitingStep();
        } catch (err) {
            setMsg('msg2', 'err', err.message);
            setBusy(submitBtn, false, 'Send Reactivation Request');
            submitBtn.disabled = !(lastDistance !== null && lastDistance <= MATCH_THRESHOLD);
        }
    });

    // ---- Step 3: wait for OSCA staff review (auto-updating screen) ----
    let pollTimer = null;
    const POLL_INTERVAL_MS = 10000;

    function enterWaitingStep() {
        showStep(3);
        $('waitBox').style.display = 'block';
        $('approvedBox').style.display = 'none';
        $('rejectedBox').style.display = 'none';
        const now = new Date();
        $('waitSince').textContent = 'Sent today at ' +
            now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(pollReactivationStatus, POLL_INTERVAL_MS);
        pollReactivationStatus(); // first check right away
    }

    async function pollReactivationStatus() {
        if (!seniorId) return;
        try {
            const res = await fetch('/api/reactivation/status?seniorId=' + encodeURIComponent(seniorId));
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) return; // transient issue — keep waiting
            if (data.status === 'Approved') stopPolling('approved');
            else if (data.status === 'Rejected') stopPolling('rejected', data.reviewNote || '');
        } catch (e) { /* network hiccup — keep polling */ }
    }

    function stopPolling(outcome, note) {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        $('waitBox').style.display = 'none';
        if (outcome === 'approved') {
            $('approvedBox').style.display = 'block';
        } else if (outcome === 'rejected') {
            $('rejectedBox').style.display = 'block';
            $('rejectedReason').textContent = note
                ? 'OSCA staff note: ' + note + ' Please visit the OSCA Magalang office with a valid ID for assistance.'
                : 'OSCA staff could not approve your request. Please visit the OSCA Magalang office with a valid ID for assistance.';
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    const waitCheckBtn = $('waitCheckBtn');
    if (waitCheckBtn) waitCheckBtn.addEventListener('click', () => pollReactivationStatus());

    window.addEventListener('pagehide', () => {
        if (stream) stream.getTracks().forEach(t => t.stop());
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    });
})();
