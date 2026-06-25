import { auth, db } from './firebase-init.js';
import { ref, get, onValue, update } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-database.js";

// Helper: Generate professional, unique claim reference numbers
function generateReferenceNumber(prefix = 'REF') {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `${prefix}-${result}`;
}

// Helper: Log financial transactions securely to admin Overview
async function logTransaction(type, seniorName, seniorUid, amount, refNumber = '', reason = '') {
    try {
        const txKey = 'tx_' + Date.now() + Math.random().toString(36).substring(2, 7);
        await update(ref(db, `transactions/${txKey}`), {
            type: type,
            seniorName: seniorName,
            seniorUid: seniorUid,
            amount: amount,
            refNumber: refNumber,
            reason: reason,
            processedBy: window.currentStaffName || 'Staff Member',
            createdAt: Date.now()
        });
    } catch (e) {
        console.error('Failed to log transaction:', e);
    }
}

// Helper: Dynamically toggle Employee Notifications red dot badge
function updateEmployeeNotifBadge() {
    const empNotifBadge = document.getElementById('empNotifBadge');
    if (empNotifBadge) {
        const total = (window.pendingPensionPayoutCount || 0) + (window.pendingClaimPayoutCount || 0);
        empNotifBadge.style.display = total > 0 ? 'block' : 'none';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (window.location.pathname !== '/employee') return;

    // Logout handler
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            try {
                await auth.signOut();
                localStorage.removeItem('userRole');
                window.location.href = '/';
            } catch (err) {
                console.error('Logout error:', err);
            }
        });
    }

    auth.onAuthStateChanged(async (user) => {
        if (user) {
            // Set greeting
            const userSnap = await get(ref(db, 'users/' + user.uid));
            let staffName = 'Staff';
            if (userSnap.exists()) {
                staffName = userSnap.val().name;
                document.getElementById('employeeGreeting').textContent = `Welcome, ${staffName}!`;
            } else {
                document.getElementById('employeeGreeting').textContent = `Welcome, Staff!`;
            }
            window.currentStaffName = staffName;

            // Real-time MAINTENANCE MODE watcher
            onValue(ref(db, 'system/settings/maintenanceMode'), async (snap) => {
                if (snap.exists() && snap.val() === true) {
                    showMaintenanceOverlay();
                    setTimeout(async () => {
                        await auth.signOut();
                        localStorage.removeItem('userRole');
                        window.location.href = '/';
                    }, 3000);
                }
            });

            // Real-time users listener — drives all tabs
            onValue(ref(db, 'users'), (snapshot) => {
                const data = snapshot.exists() ? snapshot.val() : {};
                renderEmployeeDashboard(data);
            });

            // Real-time welfare claims listener
            onValue(ref(db, 'claims'), (snapshot) => {
                const claimsData = snapshot.exists() ? snapshot.val() : {};
                renderClaimsDashboard(claimsData);
            });
        }
    });

    // Close Claim details modal
    const closeClaimModal = document.getElementById('closeClaimModal');
    const claimDetailsModal = document.getElementById('claimDetailsModal');
    if (closeClaimModal && claimDetailsModal) {
        closeClaimModal.addEventListener('click', () => {
            claimDetailsModal.style.display = 'none';
        });
    }

    // ── Walk-in Senior Registration ──────────────────────────────────────────
    const startRegBtn = document.getElementById('startRegBtn');
    const cancelRegBtn = document.getElementById('cancelRegBtn');
    const registerCTA = document.getElementById('registerCTA');
    const registerFormContent = document.getElementById('registerFormContent');
    const empRegisterForm = document.getElementById('empRegisterForm');

    // Face scan elements
    const regScanFaceBtn = document.getElementById('regScanFaceBtn');
    const regRetakeBtn = document.getElementById('regRetakeBtn');
    const regVideo = document.getElementById('regVideo');
    const regCanvas = document.getElementById('regCanvas');
    const regCameraPlaceholder = document.getElementById('regCameraPlaceholder');
    const regFaceGuide = document.getElementById('regFaceGuide');
    const regCaptureFlash = document.getElementById('regCaptureFlash');
    const regCapturedPreview = document.getElementById('regCapturedPreview');
    const regFaceStatus = document.getElementById('regFaceStatus');

    let regStream = null;
    let regCapturedFaceData = null;

    if (startRegBtn) {
        startRegBtn.addEventListener('click', () => {
            registerCTA.style.display = 'none';
            registerFormContent.style.display = 'block';
        });
    }

    if (cancelRegBtn) {
        cancelRegBtn.addEventListener('click', () => {
            registerFormContent.style.display = 'none';
            registerCTA.style.display = 'block';
            if (empRegisterForm) empRegisterForm.reset();
            stopRegCamera();
            regCapturedFaceData = null;
            resetRegFaceUI();
        });
    }

    function stopRegCamera() {
        if (regStream) {
            regStream.getTracks().forEach(t => t.stop());
            regStream = null;
        }
        if (regVideo) regVideo.srcObject = null;
    }

    function resetRegFaceUI() {
        if (regVideo) regVideo.style.display = 'none';
        if (regCameraPlaceholder) regCameraPlaceholder.style.display = 'flex';
        if (regFaceGuide) regFaceGuide.style.display = 'none';
        if (regCapturedPreview) { regCapturedPreview.style.display = 'none'; regCapturedPreview.src = ''; }
        if (regRetakeBtn) regRetakeBtn.style.display = 'none';
        if (regScanFaceBtn) {
            regScanFaceBtn.innerHTML = '<i class="fas fa-user-check"></i> Start Camera & Scan Face';
            regScanFaceBtn.style.background = 'linear-gradient(135deg, #22c55e, #16a34a)';
            regScanFaceBtn.disabled = false;
            regScanFaceBtn.style.display = '';
        }
        if (regFaceStatus) {
            regFaceStatus.innerHTML = '<i class="fas fa-exclamation-circle"></i> Face scan is required before submitting';
            regFaceStatus.style.color = '#ef4444';
        }
        regCapturedFaceData = null;
    }

    // Face scan button logic
    if (regScanFaceBtn) {
        regScanFaceBtn.addEventListener('click', async () => {
            // If face already captured, do nothing (retake handles it)
            if (regCapturedFaceData) return;

            // If camera is streaming, capture the frame
            if (regStream) {
                await captureRegFace();
                return;
            }

            // Start camera
            regScanFaceBtn.disabled = true;
            regScanFaceBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting Camera...';

            try {
                regStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } });
                regVideo.srcObject = regStream;
                regVideo.style.display = 'block';
                regCameraPlaceholder.style.display = 'none';
                if (regFaceGuide) { regFaceGuide.style.display = 'flex'; }

                regScanFaceBtn.disabled = false;
                regScanFaceBtn.innerHTML = '<i class="fas fa-camera"></i> Tap to Capture';
                regScanFaceBtn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
            } catch (err) {
                scNotify('error', 'Camera access denied. Please allow camera permissions.');
                console.error('Camera error:', err);
                regScanFaceBtn.disabled = false;
                regScanFaceBtn.innerHTML = '<i class="fas fa-user-check"></i> Start Camera & Scan Face';
            }
        });
    }

    // Retake button
    if (regRetakeBtn) {
        regRetakeBtn.addEventListener('click', () => {
            regCapturedFaceData = null;
            if (regCapturedPreview) { regCapturedPreview.style.display = 'none'; regCapturedPreview.src = ''; }
            if (regRetakeBtn) regRetakeBtn.style.display = 'none';
            if (regScanFaceBtn) {
                regScanFaceBtn.style.display = '';
                regScanFaceBtn.innerHTML = '<i class="fas fa-user-check"></i> Start Camera & Scan Face';
                regScanFaceBtn.style.background = 'linear-gradient(135deg, #22c55e, #16a34a)';
                regScanFaceBtn.disabled = false;
            }
            if (regFaceStatus) {
                regFaceStatus.innerHTML = '<i class="fas fa-exclamation-circle"></i> Face scan is required before submitting';
                regFaceStatus.style.color = '#ef4444';
            }
        });
    }

    async function captureRegFace() {
        if (!regStream || !regVideo || !regCanvas) return;

        regCanvas.width = regVideo.videoWidth;
        regCanvas.height = regVideo.videoHeight;
        const ctx = regCanvas.getContext('2d');
        ctx.drawImage(regVideo, 0, 0);

        // Flash effect
        if (regCaptureFlash) {
            regCaptureFlash.style.opacity = '0.7';
            setTimeout(() => { regCaptureFlash.style.opacity = '0'; }, 200);
        }

        // Show detecting state
        regScanFaceBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Detecting face...';
        regScanFaceBtn.disabled = true;

        // ── Face Detection ──
        let faceDetected = false;

        try {
            if ('FaceDetector' in window) {
                const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 5 });
                const faces = await detector.detect(regCanvas);
                if (faces.length === 1) {
                    const faceArea = faces[0].boundingBox.width * faces[0].boundingBox.height;
                    const imageArea = regCanvas.width * regCanvas.height;
                    faceDetected = (faceArea / imageArea) > 0.04;
                } else if (faces.length > 1) {
                    scNotify('warning', 'Multiple faces detected. Please ensure only the senior\'s face is in the frame.');
                    regScanFaceBtn.innerHTML = '<i class="fas fa-camera"></i> Tap to Capture';
                    regScanFaceBtn.disabled = false;
                    return;
                }
            }

            // Fallback: skin-tone analysis
            if (!faceDetected) {
                const imageData = ctx.getImageData(0, 0, regCanvas.width, regCanvas.height);
                const data = imageData.data;
                let skinPixels = 0;
                const startX = Math.floor(regCanvas.width * 0.2);
                const endX = Math.floor(regCanvas.width * 0.8);
                const startY = Math.floor(regCanvas.height * 0.1);
                const endY = Math.floor(regCanvas.height * 0.7);
                let sampledPixels = 0;

                for (let y = startY; y < endY; y += 2) {
                    for (let x = startX; x < endX; x += 2) {
                        const idx = (y * regCanvas.width + x) * 4;
                        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
                        const isSkin = (
                            r > 60 && g > 40 && b > 20 &&
                            r > g && r > b &&
                            (r - g) > 10 &&
                            Math.abs(r - g) < 130 &&
                            (r + g + b) > 150 && (r + g + b) < 700
                        );
                        if (isSkin) skinPixels++;
                        sampledPixels++;
                    }
                }
                const skinRatio = skinPixels / sampledPixels;
                faceDetected = skinRatio > 0.12 && skinRatio < 0.80;
            }
        } catch (err) {
            console.warn('Face detection error:', err);
            const imageData = ctx.getImageData(0, 0, regCanvas.width, regCanvas.height);
            const data = imageData.data;
            let totalBrightness = 0;
            const pixelCount = data.length / 4;
            for (let i = 0; i < data.length; i += 16) {
                totalBrightness += (data[i] + data[i+1] + data[i+2]) / 3;
            }
            const avgBrightness = totalBrightness / (pixelCount / 4);
            faceDetected = avgBrightness > 30 && avgBrightness < 240;
        }

        if (!faceDetected) {
            scNotify('warning', 'No face detected! Please position the senior\'s face clearly within the frame and try again.');
            regScanFaceBtn.innerHTML = '<i class="fas fa-camera"></i> Tap to Capture';
            regScanFaceBtn.disabled = false;
            return;
        }

        // ── Face validated ──
        regCapturedFaceData = regCanvas.toDataURL('image/jpeg', 0.7);

        // Stop camera
        stopRegCamera();
        if (regFaceGuide) regFaceGuide.style.display = 'none';

        // Show preview
        if (regCapturedPreview) {
            regCapturedPreview.src = regCapturedFaceData;
            regCapturedPreview.style.display = 'block';
        }

        // Update UI
        regScanFaceBtn.style.display = 'none';
        if (regRetakeBtn) regRetakeBtn.style.display = 'block';
        if (regFaceStatus) {
            regFaceStatus.innerHTML = '<i class="fas fa-check-circle"></i> Face captured successfully';
            regFaceStatus.style.color = '#22c55e';
        }
    }

    // Form submit
    if (empRegisterForm) {
        empRegisterForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            // Require face scan
            if (!regCapturedFaceData) {
                scNotify('warning', 'Face scan is required! Please capture the senior\'s face before submitting.');
                return;
            }

            const email = document.getElementById('regEmail').value.trim();
            const password = document.getElementById('regPassword').value;
            const confirmPassword = document.getElementById('regConfirmPassword').value;
            const lastName = document.getElementById('regLastName').value.trim();
            const firstName = document.getElementById('regFirstName').value.trim();
            const middleName = document.getElementById('regMiddleName').value.trim();
            const extension = document.getElementById('regExtension').value.trim();
            const seniorId = document.getElementById('regSeniorId').value.trim();
            const dob = document.getElementById('regDob').value;
            const sex = document.getElementById('regSex').value;
            const civilStatus = document.getElementById('regCivil').value;
            const address = document.getElementById('regAddress').value.trim();
            const barangay = document.getElementById('regBarangay').value.trim();
            const city = document.getElementById('regCity').value.trim();
            const province = document.getElementById('regProvince').value.trim();
            const postalCode = document.getElementById('regPostalCode').value.trim();
            const citizenship = document.getElementById('regCitizenship').value;
            const cpNumber = document.getElementById('regCpNumber').value.trim();
            const submitBtn = document.getElementById('submitRegBtn');

            // Build full name from parts
            const fullname = [firstName, middleName, lastName]
                .filter(Boolean).join(' ') + (extension ? ` ${extension}` : '');

            // Validate
            if (password !== confirmPassword) {
                scNotify('warning', 'Passwords do not match. Please re-enter.');
                return;
            }
            if (password.length < 6) {
                scNotify('warning', 'Password must be at least 6 characters.');
                return;
            }

            const originalText = submitBtn.innerHTML;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating Account...';
            submitBtn.disabled = true;

            try {
                const response = await fetch('/api/register-senior', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        email,
                        password,
                        fullname,
                        firstName,
                        middleName,
                        lastName,
                        extension,
                        seniorId,
                        address,
                        barangay,
                        city,
                        province,
                        postalCode,
                        citizenship,
                        cpNumber,
                        dob,
                        sex,
                        civilStatus,
                        faceImage: regCapturedFaceData,
                        registeredBy: window.currentStaffName || 'Employee'
                    })
                });

                const data = await response.json();

                if (data.success) {
                    scNotify('success', `Senior account for "${fullname}" created successfully! They can now login with their email and password.`);
                    empRegisterForm.reset();
                    regCapturedFaceData = null;
                    resetRegFaceUI();
                    registerFormContent.style.display = 'none';
                    registerCTA.style.display = 'block';
                } else {
                    scNotify('error', data.message || 'Failed to create account.');
                }
            } catch (err) {
                console.error('Registration error:', err);
                scNotify('error', 'Network error. Please check your connection and try again.');
            } finally {
                submitBtn.innerHTML = originalText;
                submitBtn.disabled = false;
            }
        });
    }
});

// ── Maintenance overlay ──────────────────────────────────────────────────────
function showMaintenanceOverlay() {
    if (document.getElementById('maintenanceOverlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'maintenanceOverlay';
    overlay.style.cssText = `
        position:fixed;inset:0;z-index:9999;
        background:rgba(15,23,42,0.92);
        display:flex;flex-direction:column;
        justify-content:center;align-items:center;
        backdrop-filter:blur(8px);`;
    overlay.innerHTML = `
        <div style="background:#1e293b;border:1px solid #334155;border-radius:20px;
                    padding:50px 60px;text-align:center;max-width:500px;
                    box-shadow:0 25px 50px rgba(0,0,0,0.5);">
            <div style="font-size:2.5rem;margin-bottom:20px;">⚠️</div>
            <h2 style="color:#f8fafc;font-size:1.8rem;margin-bottom:12px;">System Under Maintenance</h2>
            <p style="color:#94a3b8;line-height:1.7;margin-bottom:25px;">
                The administrator has temporarily taken SilverCare offline.<br>You will be logged out automatically.
            </p>
            <span style="color:#f59e0b;font-weight:700;">🔄 Signing you out in 3 seconds...</span>
        </div>`;
    document.body.appendChild(overlay);
}

// ── Dashboard renderer ───────────────────────────────────────────────────────
function renderEmployeeDashboard(usersData) {
    const verifyContainer  = document.getElementById('verifyListContainer');
    const processContainer = document.getElementById('processListContainer');
    const payoutContainer  = document.getElementById('payoutListContainer');
    if (!verifyContainer || !processContainer || !payoutContainer) return;

    verifyContainer.innerHTML  = '';
    processContainer.innerHTML = '';
    payoutContainer.innerHTML  = '';
    
    const selectUserList = document.getElementById('selectUserList');
    if (selectUserList) selectUserList.innerHTML = '';

    let pendingCount = 0;
    let activeCount  = 0;
    const now = new Date();
    const thisMonthCount = { val: 0 };

    for (const [uid, user] of Object.entries(usersData)) {
        if (user.role !== 'senior') continue;

        const initial  = user.name ? user.name.charAt(0).toUpperCase() : '?';
        const avatarColors = ['avatar-blue', 'avatar-lightblue', 'avatar-bluegreen'];
        const avatarClass  = avatarColors[Math.abs(uid.charCodeAt(0)) % avatarColors.length];

        // Count registrations this month
        if (user.createdAt) {
            const created = new Date(user.createdAt);
            if (created.getMonth() === now.getMonth() && created.getFullYear() === now.getFullYear()) {
                thisMonthCount.val++;
            }
        }

        if (user.status === 'Pending') {
            pendingCount++;
            verifyContainer.innerHTML += `
                <div class="list-row">
                    <div class="list-row-left">
                        <div class="avatar-circle ${avatarClass}">${initial}</div>
                        <div class="list-info">
                            <h4>${user.name}</h4>
                            <p>${user.email} &bull; Submitted for verification</p>
                        </div>
                    </div>
                    <div class="list-actions">
                        <button class="btn-outline-green" data-uid="${uid}" data-action="approve">Approve</button>
                        <button class="btn-outline-red"  data-uid="${uid}" data-action="reject">Reject</button>
                    </div>
                </div>`;

        } else if (user.status === 'Active') {
            activeCount++;
            processContainer.innerHTML += `
                <div class="list-row">
                    <div class="list-row-left">
                        <div class="avatar-circle ${avatarClass}">${initial}</div>
                        <div class="list-info">
                            <h4>${user.name}</h4>
                            <p>Senior ID: ${user.seniorId || 'Unassigned'} &bull; Pension: PHP 1,500</p>
                        </div>
                    </div>
                    <div class="list-actions">
                        <span class="badge-green">Active</span>
                        <button class="btn-solid-blue" data-uid="${uid}" data-action="process">Process</button>
                    </div>
                </div>`;

            const currentMonth = new Date().toISOString().substring(0, 7); // YYYY-MM
            if (user.lastPensionMonth !== currentMonth) {
                payoutContainer.innerHTML += `
                    <div class="payout-row">
                        <div>
                            <h4>Name: ${user.name}</h4>
                            <p style="display:flex; align-items:center; gap:5px; margin: 5px 0;">Amount: PHP <input type="number" class="payout-amount-input" value="1500" style="width: 80px; padding: 2px 5px; border-radius: 4px; border: 1px solid #cbd5e1;" /></p>
                            <p>Date: ${now.toLocaleDateString()}</p>
                        </div>
                        <div style="display:flex;gap:8px;">
                            <button class="btn-tiny-green" data-uid="${uid}" data-action="payout-approve">Approve</button>
                            <button class="btn-tiny-red"   data-uid="${uid}" data-action="payout-decline">Decline</button>
                        </div>
                    </div>`;
            }

            if (selectUserList) {
                selectUserList.innerHTML += `
                    <label style="display: flex; align-items: center; justify-content: space-between; padding: 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; cursor: pointer; transition: all 0.2s;">
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <input type="checkbox" class="senior-reminder-checkbox" value="${uid}" style="width: 18px; height: 18px; cursor: pointer;">
                            <div style="display: flex; flex-direction: column;">
                                <span style="font-weight: 600; color: #1e293b; font-size: 0.95rem;">${user.name}</span>
                                <span style="font-size: 0.8rem; color: #64748b;">${user.email || 'No email provided'}</span>
                            </div>
                        </div>
                    </label>`;
            }
        }
    }

    // ── Empty states ──────────────────────────────────────────────────────────
    if (pendingCount === 0) {
        verifyContainer.innerHTML = `
            <div style="text-align:center;color:#64748b;padding:40px 20px;">
                <i class="fas fa-check-circle" style="font-size:2rem;color:#22c55e;margin-bottom:10px;display:block;"></i>
                No pending verifications at this time.
            </div>`;
    }
    if (activeCount === 0) {
        processContainer.innerHTML = `
            <div style="text-align:center;color:#64748b;padding:40px 20px;">
                <i class="fas fa-inbox" style="font-size:2rem;margin-bottom:10px;display:block;"></i>
                No active seniors to process.
            </div>`;
        payoutContainer.innerHTML = `
            <div style="text-align:center;color:#166534;padding:40px 20px;">
                No active payout requests.
            </div>`;
    }

    // ── Update stat boxes ─────────────────────────────────────────────────────
    const elMonth = document.getElementById('statThisMonth');
    const elTotal = document.getElementById('statTotalRegistered');
    const elPend  = document.getElementById('statPending');
    if (elMonth) elMonth.textContent = thisMonthCount.val;
    if (elTotal) elTotal.textContent = activeCount + pendingCount;
    if (elPend)  elPend.textContent  = pendingCount;

    // ── Badge: Red dot on Verify tab when there are pending registrations ────
    const empVerifyBadge = document.getElementById('empVerifyBadge');

    // ── KYC Identity Verification Renderer ──────────────────────────────────
    const kycContainer = document.getElementById('kycVerifyListContainer');
    const kycCountBadge = document.getElementById('kycPendingCount');
    let kycPendingCount = 0;

    if (kycContainer) {
        kycContainer.innerHTML = '';
        for (const [uid, user] of Object.entries(usersData)) {
            if (user.role !== 'senior' || user.kycStatus !== 'Pending') continue;
            kycPendingCount++;

            const initial = user.name ? user.name.charAt(0).toUpperCase() : '?';
            const submittedAt = user.kycSubmittedAt ? new Date(user.kycSubmittedAt).toLocaleString() : 'N/A';

            kycContainer.innerHTML += `
                <div style="border: 1px solid #e2e8f0; border-radius: 14px; padding: 24px; margin-bottom: 20px; background: white; box-shadow: 0 2px 8px rgba(0,0,0,0.03);">
                    <div style="display: flex; align-items: center; gap: 15px; margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid #f1f5f9;">
                        <div style="width: 48px; height: 48px; border-radius: 50%; background: #e0e7ff; color: #4f46e5; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1.2rem;">${initial}</div>
                        <div>
                            <h4 style="margin: 0 0 2px; color: #1e293b; font-size: 1.1rem; font-weight: 700;">${user.name || 'N/A'}</h4>
                            <p style="margin: 0; color: #64748b; font-size: 0.85rem;">${user.email || 'No email'} &bull; OSCA ID: ${user.seniorId || 'N/A'} &bull; Submitted: ${submittedAt}</p>
                        </div>
                    </div>

                    <div style="display: flex; gap: 24px; margin-bottom: 20px;">
                        <div style="flex: 1;">
                            <h5 style="font-size: 0.85rem; font-weight: 700; color: #1e293b; margin: 0 0 12px;"><i class="fas fa-id-card" style="margin-right:6px;color:#4f46e5;"></i> Personal Information</h5>
                            <table style="width:100%; border-collapse: collapse; font-size: 0.9rem;">
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600; width: 140px;">First Name</td><td style="padding: 6px 0; color: #1e293b;">${user.firstName || 'N/A'}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Middle Name</td><td style="padding: 6px 0; color: #1e293b;">${user.middleName || 'N/A'}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Last Name</td><td style="padding: 6px 0; color: #1e293b;">${user.lastName || 'N/A'}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Extension</td><td style="padding: 6px 0; color: #1e293b;">${user.extension || 'N/A'}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Address</td><td style="padding: 6px 0; color: #1e293b;">${user.address || 'N/A'}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Province</td><td style="padding: 6px 0; color: #1e293b;">${user.province || 'N/A'}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Barangay</td><td style="padding: 6px 0; color: #1e293b;">${user.barangay || 'N/A'}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">City</td><td style="padding: 6px 0; color: #1e293b;">${user.city || 'N/A'}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Citizenship</td><td style="padding: 6px 0; color: #1e293b;">${user.citizenship || 'N/A'}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Cellphone No.</td><td style="padding: 6px 0; color: #1e293b;">${user.cpNumber || 'N/A'}</td></tr>
                            </table>
                        </div>
                        <div style="width: 280px; flex-shrink: 0;">
                            <h5 style="font-size: 0.85rem; font-weight: 700; color: #1e293b; margin: 0 0 12px;"><i class="fas fa-camera" style="margin-right:6px;color:#4f46e5;"></i> Face Scan</h5>
                            <div style="background: #0f172a; border-radius: 12px; overflow: hidden; border: 2px solid #e2e8f0; aspect-ratio: 4/3; display: flex; align-items: center; justify-content: center;">
                                ${user.kycFaceImage
                                    ? `<img src="${user.kycFaceImage}" alt="Face" style="width:100%;height:100%;object-fit:cover;">`
                                    : `<span style="color:#64748b;font-size:0.85rem;"><i class="fas fa-user" style="font-size:2rem;display:block;margin-bottom:8px;opacity:0.5;"></i>No Image</span>`
                                }
                            </div>
                        </div>
                    </div>

                    <div style="display: flex; gap: 10px; justify-content: flex-end; border-top: 1px solid #f1f5f9; padding-top: 16px;">
                        <button class="btn-outline-red" data-uid="${uid}" data-action="kyc-reject" style="padding: 10px 24px; border-radius: 8px;">
                            <i class="fas fa-times" style="margin-right: 6px;"></i>Reject
                        </button>
                        <button class="btn-outline-green" data-uid="${uid}" data-action="kyc-approve" style="padding: 10px 24px; border-radius: 8px;">
                            <i class="fas fa-check" style="margin-right: 6px;"></i>Approve Verification
                        </button>
                    </div>
                </div>`;
        }

        if (kycPendingCount === 0) {
            kycContainer.innerHTML = `
                <div style="text-align:center;color:#64748b;padding:40px 20px;">
                    <i class="fas fa-check-circle" style="font-size:2rem;color:#8b5cf6;margin-bottom:10px;display:block;"></i>
                    No pending KYC submissions at this time.
                </div>`;
        }

        if (kycCountBadge) {
            kycCountBadge.textContent = kycPendingCount;
            kycCountBadge.style.display = kycPendingCount > 0 ? 'inline-block' : 'none';
        }
    }

    // ── Update badge to cover both account + KYC pending ─────────────────────
    if (empVerifyBadge) {
        empVerifyBadge.style.display = (pendingCount + kycPendingCount) > 0 ? 'block' : 'none';
    }

    // ── Attach button listeners ───────────────────────────────────────────────
    attachButtonListeners();
}

// ── Claims Renderer (Real System Look) ─────────────────────────────────────────
function renderClaimsDashboard(claimsData) {
    const claimsContainer = document.getElementById('claimsListContainer');
    if (!claimsContainer) return;

    const claimsPayoutContainer = document.getElementById('claimsPayoutContainer');
    if (claimsPayoutContainer) claimsPayoutContainer.innerHTML = '';
    
    let pendingClaimsCount = 0;

    for (const [claimId, claim] of Object.entries(claimsData)) {
        if (claim.status === 'Pending') {
            pendingClaimsCount++;
            const initial = claim.applicantName ? claim.applicantName.charAt(0).toUpperCase() : '?';
            const dateStr = claim.createdAt ? new Date(claim.createdAt).toLocaleDateString() : 'N/A';
            const serviceLabel = claim.serviceType.toUpperCase();

            claimsContainer.innerHTML += `
                <div class="list-row">
                    <div class="list-row-left">
                        <div class="avatar-circle avatar-lightblue" style="background:#e0f2fe; color:#0369a1;"><i class="fas fa-file-invoice"></i></div>
                        <div class="list-info">
                            <h4>${claim.applicantName}</h4>
                            <p><strong>Benefit:</strong> ${serviceLabel} &bull; <strong>Submitted:</strong> ${dateStr}</p>
                        </div>
                    </div>
                    <div class="list-actions">
                        <span class="badge-red" style="background:#ffedd5; color:#ea580c;">Pending Claim</span>
                        <button class="btn-solid-blue" data-claimid="${claimId}" data-action="view-claim" style="background:#2563eb;">View Details</button>
                    </div>
                </div>`;
        } else if (claim.status === 'Approved_Pending_Payout') {
            if (claimsPayoutContainer) {
                const defaultAmount = claim.serviceType === 'burial' ? 10000 : (claim.serviceType === 'bedridden' ? 1500 : 100000);
                claimsPayoutContainer.innerHTML += `
                    <div class="payout-row" style="background: #f0fdf4; border-color: #bbf7d0;">
                        <div>
                            <h4 style="color: #166534;">Claim: ${claim.applicantName}</h4>
                            <p style="font-size:0.85rem; color:#15803d; margin:2px 0;"><strong>Service:</strong> ${claim.serviceType.toUpperCase()}</p>
                            <p style="display:flex; align-items:center; gap:5px; margin: 5px 0;">Amount: PHP <input type="number" class="payout-amount-input" value="${defaultAmount}" style="width: 80px; padding: 2px 5px; border-radius: 4px; border: 1px solid #cbd5e1;" /></p>
                        </div>
                        <div style="display:flex;gap:8px;">
                            <button class="btn-tiny-green" data-claimid="${claimId}" data-senioruid="${claim.uid}" data-servicetype="${claim.serviceType}" data-seniorname="${claim.applicantName}" data-action="claim-payout-approve">Approve Payment</button>
                            <button class="btn-tiny-red" data-claimid="${claimId}" data-senioruid="${claim.uid}" data-servicetype="${claim.serviceType}" data-seniorname="${claim.applicantName}" data-action="claim-payout-decline">Decline</button>
                        </div>
                    </div>`;
            }
        }
    }

    if (pendingClaimsCount === 0) {
        claimsContainer.innerHTML = `
            <div style="text-align:center;color:#64748b;padding:40px 20px;">
                <i class="fas fa-hand-holding-heart" style="font-size:2rem;color:#94a3b8;margin-bottom:10px;display:block;"></i>
                No pending welfare assistance claims at this time.
            </div>`;
    }

    // Attach View details click listeners
    document.querySelectorAll('[data-action="view-claim"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const claimId = btn.dataset.claimid;
            openClaimDetailsModal(claimId, claimsData[claimId]);
        });
    });

    // Attach Claim Payout Approve listeners
    document.querySelectorAll('[data-action="claim-payout-approve"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const row = e.target.closest('.payout-row');
            const input = row.querySelector('.payout-amount-input');
            const amount = input.value;
            const claimId = btn.dataset.claimid;
            const uid = btn.dataset.senioruid;
            const serviceType = btn.dataset.servicetype;
            const seniorName = btn.dataset.seniorname;

            btn.disabled = true;
            btn.innerHTML = 'Processing...';
            
            try {
                const refNum = generateReferenceNumber('CLM');
                const now = Date.now();

                // Update claim status
                await update(ref(db, `claims/${claimId}`), { status: 'Paid', paidAmount: amount, paidAt: now, refNumber: refNum });

                // Send notification to user
                const notifKey = 'notif_' + now;
                await update(ref(db, `users/${uid}/notifications/${notifKey}`), {
                    title: `${serviceType.toUpperCase()} Payout Released`,
                    description: `Your approved claim payout of PHP ${amount} has been released. Reference: ${refNum}. Check your email for claiming instructions.`,
                    createdAt: now
                });
                
                // Add to benefits
                const benefitKey = 'benefit_' + now;
                await update(ref(db, `users/${uid}/benefits/${benefitKey}`), {
                    title: `${serviceType.charAt(0).toUpperCase() + serviceType.slice(1)} Assistance`,
                    amount: `PHP ${amount}`,
                    status: 'Active',
                    refNumber: refNum,
                    approvedAt: now
                });

                // Log transaction to admin
                await logTransaction('Claim Approved', seniorName, uid, amount, refNum);

                // Send email via unified endpoint
                const userSnapshot = await get(ref(db, `users/${uid}`));
                if (userSnapshot.exists() && userSnapshot.val().email) {
                    const userData = userSnapshot.val();
                    fetch('/api/send-status-email', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: userData.email, name: seniorName, amount: amount, type: 'claim_approved', refNumber: refNum, serviceType: serviceType })
                    }).catch(console.error);
                }

                row.style.display = 'none';
                scNotify('success', `Claim payout of PHP ${amount} processed. Ref: ${refNum}`);
            } catch (err) {
                btn.disabled = false;
                btn.innerHTML = 'Approve Payment';
                scNotify('error', 'Error processing claim payout.');
            }
        });
    });

    // Attach Claim Payout Decline listeners
    document.querySelectorAll('[data-action="claim-payout-decline"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const row = e.target.closest('.payout-row');
            const claimId = btn.dataset.claimid;
            const uid = btn.dataset.senioruid;
            const serviceType = btn.dataset.servicetype;
            const seniorName = btn.dataset.seniorname;

            btn.disabled = true;
            btn.innerHTML = 'Declining...';

            try {
                const refNum = generateReferenceNumber('DEC');
                const now = Date.now();

                await update(ref(db, `claims/${claimId}`), { status: 'Rejected', rejectedAt: now, refNumber: refNum });

                const notifKey = 'notif_' + now;
                await update(ref(db, `users/${uid}/notifications/${notifKey}`), {
                    title: `${serviceType.toUpperCase()} Claim Declined`,
                    description: `Your welfare assistance claim payout was declined. Ref: ${refNum}. Please visit OSCA office with your documents.`,
                    createdAt: now
                });

                // Log transaction to admin
                await logTransaction('Claim Declined', seniorName, uid, '0', refNum, 'Documentation review failed or insufficient verification.');

                // Send decline email
                const userSnapshot = await get(ref(db, `users/${uid}`));
                if (userSnapshot.exists() && userSnapshot.val().email) {
                    const userData = userSnapshot.val();
                    fetch('/api/send-status-email', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: userData.email, name: seniorName, type: 'claim_declined', serviceType: serviceType, refNumber: refNum })
                    }).catch(console.error);
                }

                row.style.display = 'none';
                scNotify('warning', `Claim declined. Senior notified. Ref: ${refNum}`);
            } catch (err) {
                btn.disabled = false;
                btn.innerHTML = 'Decline';
                scNotify('error', 'Error declining claim.');
            }
        });
    });
}

// ── Open claim modal details ──────────────────────────────────────────────────
function openClaimDetailsModal(claimId, claim) {
    const modal = document.getElementById('claimDetailsModal');
    const title = document.getElementById('modalClaimTitle');
    const content = document.getElementById('modalClaimContent');
    const approveBtn = document.getElementById('modalApproveBtn');
    const rejectBtn = document.getElementById('modalRejectBtn');

    if (!modal || !title || !content || !approveBtn || !rejectBtn) return;

    title.textContent = `Claim Form Details: ${claim.serviceType.toUpperCase()}`;
    
    // Format form data dynamically based on service
    let detailsHtml = `
        <div style="display:grid; grid-template-columns: 120px 1fr; gap:8px 15px; border-bottom:1px dashed #e2e8f0; padding-bottom:15px;">
            <strong>Senior Name:</strong> <span>${claim.applicantName}</span>
            <strong>Status:</strong> <span style="color:#d97706; font-weight:700;">Pending Verification</span>
            <strong>Date Sent:</strong> <span>${new Date(claim.createdAt).toLocaleString()}</span>
        </div>
        <div style="display:flex; flex-direction:column; gap:12px; margin-top:5px;">
            <h4 style="color:#1e3a8a; font-size:0.95rem; text-transform:uppercase; letter-spacing:0.5px; border-left:3px solid #3b82f6; padding-left:8px;">Form Submissions:</h4>
    `;

    for (const [key, val] of Object.entries(claim.formData)) {
        if (key === 'cashUtilization' && Array.isArray(val)) {
            detailsHtml += `<p style="margin:0;"><strong>Utilization Plans:</strong> ${val.join(', ')}</p>`;
        } else {
            // Humanize keys (e.g. deceasedName -> Deceased Name)
            const humanKey = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
            detailsHtml += `<p style="margin:0;"><strong>${humanKey}:</strong> ${val}</p>`;
        }
    }

    detailsHtml += `</div>`;
    content.innerHTML = detailsHtml;

    // Approve button click handler
    approveBtn.onclick = async () => {
        try {
            await update(ref(db, `claims/${claimId}`), { status: 'Approved_Pending_Payout' });
            
            // Add notification to the senior's user node
            const seniorUid = claim.uid;
            const notifKey = 'notif_' + Date.now();
            await update(ref(db, `users/${seniorUid}/notifications/${notifKey}`), {
                title: `${claim.serviceType.toUpperCase()} Approved`,
                description: `Your welfare claim has been approved! It is now pending final payment processing.`,
                createdAt: Date.now()
            });

            modal.style.display = 'none';
            scNotify('success', 'Claim Verified! Moved to Payout Requests.');

        } catch (e) {
            scNotify('error', 'Approval failed: ' + e.message);
        }
    };

    // Decline button click handler
    rejectBtn.onclick = async () => {
        try {
            const refNum = generateReferenceNumber('DEC');
            const now = Date.now();
            await update(ref(db, `claims/${claimId}`), { status: 'Rejected', rejectedAt: now, refNumber: refNum });
            
            // Generate rejected notification for senior
            const seniorUid = claim.uid;
            const notifKey = 'notif_' + now;
            await update(ref(db, `users/${seniorUid}/notifications/${notifKey}`), {
                title: `${claim.serviceType.toUpperCase()} Request Declined`,
                description: `Your welfare claim request was declined. Ref: ${refNum}. Please visit OSCA office with your documents.`,
                createdAt: now
            });

            // Log to admin
            await logTransaction('Claim Declined', claim.applicantName, seniorUid, '0', refNum, 'Claim verification failed.');

            // Send decline email
            const userSnapshot = await get(ref(db, `users/${seniorUid}`));
            if (userSnapshot.exists() && userSnapshot.val().email) {
                const userData = userSnapshot.val();
                fetch('/api/send-status-email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: userData.email, name: claim.applicantName, type: 'claim_declined', serviceType: claim.serviceType, refNumber: refNum })
                }).catch(console.error);
            }

            modal.style.display = 'none';
            scNotify('warning', `Claim Declined. Senior notified. Ref: ${refNum}`);
        } catch (e) {
            scNotify('error', 'Decline failed: ' + e.message);
        }
    };

    modal.style.display = 'flex';
}

// ── Button wiring ────────────────────────────────────────────────────────────
function attachButtonListeners() {
    // Verify tab — Approve / Reject
    document.querySelectorAll('[data-action="approve"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const uid = btn.dataset.uid;
            try {
                await update(ref(db, 'users/' + uid), { status: 'Active' });
                scNotify('success', 'Senior account approved and activated!');
            } catch (e) {
                scNotify('error', 'Failed to approve: ' + e.message);
            }
        });
    });

    document.querySelectorAll('[data-action="reject"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const uid = btn.dataset.uid;
            try {
                await update(ref(db, 'users/' + uid), { status: 'Rejected' });
                scNotify('error', 'Senior account rejected.');
            } catch (e) {
                scNotify('error', 'Failed to reject: ' + e.message);
            }
        });
    });

    // Process tab — Process button
    document.querySelectorAll('[data-action="process"]').forEach(btn => {
        btn.addEventListener('click', () => {
            scNotify('info', 'Benefits processing initiated for this senior.');
        });
    });

    // Payout tab — Approve Pension
    document.querySelectorAll('[data-action="payout-approve"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const uid = btn.dataset.uid;
            const row = btn.closest('.payout-row');
            const amountInput = row.querySelector('.payout-amount-input');
            const amount = amountInput ? amountInput.value : '1500';
            
            try {
                if (btn.disabled) return;
                btn.disabled = true;
                btn.innerHTML = 'Processing...';

                const refNum = generateReferenceNumber('PEN');
                const currentMonth = new Date().toISOString().substring(0, 7);
                const now = Date.now();
                const benefitKey = 'payout_' + now;
                const notifKey = 'notif_' + now;
                
                const updates = {};
                updates[`users/${uid}/benefits/${benefitKey}`] = {
                    title: 'Monthly Pension Payout',
                    amount: `PHP ${amount}`,
                    status: 'Approved',
                    refNumber: refNum,
                    approvedAt: now
                };
                updates[`users/${uid}/notifications/${notifKey}`] = {
                    title: 'Pension Released',
                    description: `Your pension payout of PHP ${amount} has been approved and released. Ref: ${refNum}. Check your email for claiming details.`,
                    createdAt: now
                };
                updates[`users/${uid}/lastPensionMonth`] = currentMonth;

                await update(ref(db), updates);

                // Fetch user data for email and name
                const userSnapshot = await get(ref(db, `users/${uid}`));
                const seniorName = userSnapshot.exists() ? userSnapshot.val().name : 'Senior Citizen';

                // Log transaction to admin
                await logTransaction('Pension Approved', seniorName, uid, amount, refNum);

                // Send email via unified endpoint
                if (userSnapshot.exists() && userSnapshot.val().email) {
                    const userData = userSnapshot.val();
                    fetch('/api/send-status-email', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: userData.email, name: userData.name, amount: amount, type: 'pension_approved', refNumber: refNum })
                    }).catch(console.error);
                }

                scNotify('success', `Pension of PHP ${amount} approved. Ref: ${refNum}`);
                row.style.display = 'none';
            } catch (e) {
                scNotify('error', 'Failed to approve payout: ' + e.message);
                btn.disabled = false;
                btn.innerHTML = 'Approve';
            }
        });
    });

    // Payout tab — Decline Pension
    document.querySelectorAll('[data-action="payout-decline"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const uid = btn.dataset.uid;
            const row = btn.closest('.payout-row');

            try {
                if (btn.disabled) return;
                btn.disabled = true;
                btn.innerHTML = 'Declining...';

                const refNum = generateReferenceNumber('DEC');
                const now = Date.now();
                const notifKey = 'notif_' + now;

                // Mark month as processed so it won't show again
                const currentMonth = new Date().toISOString().substring(0, 7);
                const updates = {};
                updates[`users/${uid}/lastPensionMonth`] = currentMonth;
                updates[`users/${uid}/notifications/${notifKey}`] = {
                    title: 'Pension Declined',
                    description: `Your monthly pension payout for this period was declined. Ref: ${refNum}. Please visit the OSCA office.`,
                    createdAt: now
                };
                await update(ref(db), updates);

                // Fetch user data
                const userSnapshot = await get(ref(db, `users/${uid}`));
                const seniorName = userSnapshot.exists() ? userSnapshot.val().name : 'Senior Citizen';

                // Log transaction to admin
                await logTransaction('Pension Declined', seniorName, uid, '0', refNum, 'Verification discrepancy or account status mismatch.');

                // Send decline email
                if (userSnapshot.exists() && userSnapshot.val().email) {
                    const userData = userSnapshot.val();
                    fetch('/api/send-status-email', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: userData.email, name: userData.name, type: 'pension_declined', refNumber: refNum })
                    }).catch(console.error);
                }

                scNotify('warning', `Pension declined. Ref: ${refNum}. Senior notified.`);
                row.style.display = 'none';
            } catch (e) {
                scNotify('error', 'Failed to decline payout: ' + e.message);
                btn.disabled = false;
                btn.innerHTML = 'Decline';
            }
        });
    });

    // ── KYC Approve ──────────────────────────────────────────────────────────
    document.querySelectorAll('[data-action="kyc-approve"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const uid = btn.dataset.uid;
            const card = btn.closest('div[style*="border: 1px"]');
            try {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying...';

                const now = Date.now();
                const notifKey = 'notif_' + now;
                const employeeName = window.currentStaffName || 'Staff Member';
                const employeeUid = auth.currentUser ? auth.currentUser.uid : '';
                const employeeEmail = auth.currentUser ? auth.currentUser.email : '';
                await update(ref(db, 'users/' + uid), {
                    kycStatus: 'Verified',
                    kycVerifiedAt: now,
                    verifiedBy: employeeName,
                    verifiedByUid: employeeUid,
                    verifiedByEmail: employeeEmail
                });
                await update(ref(db, `users/${uid}/notifications/${notifKey}`), {
                    title: 'Identity Verified ✓',
                    description: 'Congratulations! Your identity has been verified. You can now apply for pensions, benefits, and welfare assistance.',
                    createdAt: now
                });

                if (card) card.style.display = 'none';
                scNotify('success', 'Senior identity verified successfully!');
            } catch (e) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-check" style="margin-right: 5px;"></i>Verify';
                scNotify('error', 'KYC verification failed: ' + e.message);
            }
        });
    });

    // ── KYC Reject ───────────────────────────────────────────────────────────
    document.querySelectorAll('[data-action="kyc-reject"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const uid = btn.dataset.uid;
            const card = btn.closest('div[style*="border: 1px"]');
            try {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rejecting...';

                const now = Date.now();
                const notifKey = 'notif_' + now;
                await update(ref(db, 'users/' + uid), {
                    kycStatus: 'Rejected',
                    kycRejectedAt: now,
                    kycFaceImage: null
                });
                await update(ref(db, `users/${uid}/notifications/${notifKey}`), {
                    title: 'Verification Rejected',
                    description: 'Your identity verification was rejected. Please re-submit with clear and valid information.',
                    createdAt: now
                });

                if (card) card.style.display = 'none';
                scNotify('warning', 'KYC rejected. Senior notified to re-submit.');
            } catch (e) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-times" style="margin-right: 5px;"></i>Reject';
                scNotify('error', 'KYC rejection failed: ' + e.message);
            }
        });
    });
}

// ── Global function for Send Reminder ──────────────────────────────────────────
window.sendReminderToAll = async function() {
    const msg = document.getElementById('reminderMessage').value.trim();
    if (!msg) {
        scNotify('warning', 'Please enter a message first.');
        return;
    }
    
    try {
        const usersSnap = await get(ref(db, 'users'));
        if (usersSnap.exists()) {
            const updates = {};
            const now = Date.now();
            usersSnap.forEach(childSnap => {
                const uid = childSnap.key;
                const user = childSnap.val();
                if (user.role === 'senior') {
                    const notifKey = 'notif_' + now;
                    updates[`users/${uid}/notifications/${notifKey}`] = {
                        title: 'Important Reminder',
                        description: msg,
                            createdAt: now
                    };
                }
            });
            await update(ref(db), updates);
            scNotify('success', 'Reminder sent to all seniors!');
            document.getElementById('reminderMessage').value = '';
        }
    } catch (e) {
        scNotify('error', 'Failed to send reminders: ' + e.message);
    }
}

window.toggleSelectAllSeniors = function(source) {
    const checkboxes = document.querySelectorAll('.senior-reminder-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = source.checked;
    });
};

window.sendSelectedReminders = async function() {
    const msg = document.getElementById('reminderMessage').value.trim();
    if (!msg) {
        scNotify('warning', 'Please enter a message first.');
        return;
    }

    const checkboxes = document.querySelectorAll('.senior-reminder-checkbox:checked');
    if (checkboxes.length === 0) {
        scNotify('warning', 'Please select at least one senior.');
        return;
    }

    const btn = document.querySelector('#selectUserModal .btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = 'Sending...';
    btn.disabled = true;

    try {
        const updates = {};
        const now = Date.now();
        
        checkboxes.forEach(cb => {
            const uid = cb.value;
            const notifKey = 'notif_' + now + '_' + Math.floor(Math.random()*1000);
            updates[`users/${uid}/notifications/${notifKey}`] = {
                title: 'Important Direct Reminder',
                description: msg,
                createdAt: now
            };
        });

        await update(ref(db), updates);
        
        scNotify('success', `Direct reminder sent successfully to ${checkboxes.length} seniors!`);
        document.getElementById('reminderMessage').value = '';
        document.getElementById('selectUserModal').style.display = 'none';
        
        // Reset checkboxes
        document.querySelectorAll('.senior-reminder-checkbox').forEach(cb => cb.checked = false);
        const selectAllCb = document.getElementById('selectAllSeniorsCheckbox');
        if (selectAllCb) selectAllCb.checked = false;

    } catch (e) {
        scNotify('error', 'Failed to send reminders: ' + e.message);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}
