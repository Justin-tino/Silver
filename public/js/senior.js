import { auth, db } from './firebase-init.js';
import { ref, get, set, push, update, onValue } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-database.js";

document.addEventListener('DOMContentLoaded', () => {
    // If not on the senior page, abort
    if (window.location.pathname !== '/senior') return;

    let currentUserData = null;
    let activeServiceType = '';

    function getRelativeTime(timestamp) {
        if (!timestamp) return 'Just now';
        const now = Date.now();
        const diff = now - timestamp;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        const weeks = Math.floor(days / 7);
        const months = Math.floor(days / 30);

        if (seconds < 60) return 'Just now';
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        if (days < 7) return `${days}d ago`;
        if (weeks < 4) return `${weeks}w ago`;
        return `${months}mo ago`;
    }

    function isValidPhone(val) {
        const cleaned = val.replace(/[\s\-\(\)]/g, '');
        return cleaned.length >= 10 && /^\+?\d+$/.test(cleaned);
    }

    // --- Tab Switching Logic ---
    const navPills = document.querySelectorAll('.nav-pill');
    const tabPanels = document.querySelectorAll('.tab-panel');

    function switchTab(tabId) {
        // Hide all panels
        tabPanels.forEach(panel => panel.classList.remove('active'));
        // Remove active class from pills
        navPills.forEach(pill => pill.classList.remove('active'));

        // Show target panel
        const targetPanel = document.getElementById(`panel-${tabId}`);
        if (targetPanel) {
            targetPanel.classList.add('active');
        }

        // Highlight target pill (if it exists)
        const targetPill = document.querySelector(`.nav-pill[data-tab="${tabId}"]`);
        if (targetPill) {
            targetPill.classList.add('active');
        }

        // Hide notification badge when notifications tab is viewed
        if (tabId === 'notifications') {
            const notifBadge = document.getElementById('notifBadge');
            if (notifBadge) notifBadge.style.display = 'none';
            localStorage.setItem('lastNotifView_' + (currentUserData ? currentUserData.uid : 'guest'), Date.now());
        }
    }

    navPills.forEach(pill => {
        pill.addEventListener('click', () => {
            const tabId = pill.getAttribute('data-tab');
            switchTab(tabId);
        });
    });

    // --- Sidebar Link Clicking -> Opens Soft-Filling Form ---
    const sidebarLinks = document.querySelectorAll('.sidebar-link');
    sidebarLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();

            // ── ACCESS GUARD: Block unverified seniors ──
            if (currentUserData && currentUserData.kycStatus !== 'Verified') {
                showToast('⚠️ You must get verified first before applying for services.');
                // Flash the Get Verified nav pill
                const verifyPill = document.getElementById('navPillVerification');
                if (verifyPill) {
                    verifyPill.style.animation = 'none';
                    void verifyPill.offsetWidth; // trigger reflow
                    verifyPill.style.animation = 'pulse-glow 0.6s ease 3';
                }
                return;
            }
            
            // Remove active classes
            sidebarLinks.forEach(l => l.classList.remove('active'));
            // Highlight clicked
            link.classList.add('active');

            const service = link.getAttribute('data-service');
            activeServiceType = service;
            openServiceForm(service);
        });
    });

    // Back to Dashboard Link
    const formBackBtn = document.getElementById('formBackBtn');
    if (formBackBtn) {
        formBackBtn.addEventListener('click', (e) => {
            e.preventDefault();
            sidebarLinks.forEach(l => l.classList.remove('active'));
            switchTab('dashboard');
        });
    }

    // --- Auth State Observer ---
    auth.onAuthStateChanged(async (user) => {
        if (!user) {
            window.location.href = '/';
            return;
        }

        // Real-time listener for current logged-in user details
        onValue(ref(db, 'users/' + user.uid), (snapshot) => {
            if (snapshot.exists()) {
                currentUserData = snapshot.val();
                currentUserData.uid = user.uid;
                populatePortalData(currentUserData);
                populateProfileInputs(currentUserData);
                renderBenefitsAndNotifications(currentUserData);
                renderKycVerificationStatus(currentUserData);
            } else {
                // If profile not found, populate with Auth details
                currentUserData = {
                    name: user.displayName || 'Senior Citizen',
                    email: user.email,
                    seniorId: 'OSCA-PENDING',
                    status: 'Active'
                };
                populatePortalData(currentUserData);
                populateProfileInputs(currentUserData);
            }
        });
    });

    // Mobile Sidebar Toggle
    const mobileMenuToggle = document.getElementById('mobileMenuToggle');
    const sidebar = document.querySelector('.sidebar');
    const sidebarOverlay = document.getElementById('mobileSidebarOverlay');

    window.toggleMobileSidebar = function () {
        const isOpen = sidebar && sidebar.classList.contains('open');
        if (sidebar) sidebar.classList.toggle('open');
        if (sidebarOverlay) sidebarOverlay.classList.toggle('visible');
        if (mobileMenuToggle) {
            mobileMenuToggle.innerHTML = isOpen ? '<i class="fas fa-bars"></i>' : '<i class="fas fa-times"></i>';
        }
    };

    if (mobileMenuToggle) {
        mobileMenuToggle.addEventListener('click', toggleMobileSidebar);
    }
    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', toggleMobileSidebar);
    }

    // Auto-close sidebar on link click (mobile)
    document.querySelectorAll('.sidebar-link').forEach(link => {
        link.addEventListener('click', () => {
            if (window.innerWidth <= 900) {
                if (sidebar) sidebar.classList.remove('open');
                if (sidebarOverlay) sidebarOverlay.classList.remove('visible');
                if (mobileMenuToggle) mobileMenuToggle.innerHTML = '<i class="fas fa-bars"></i>';
            }
        });
    });

    // Logout Action
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            try {
                await auth.signOut();
                localStorage.removeItem('userRole');
                window.location.href = '/';
            } catch (err) {
                console.error("Logout error:", err);
            }
        });
    }

    // --- Populate Dashboard Greeting & Stats ---
    function populatePortalData(data) {
        document.getElementById('portalGreeting').textContent = `Welcome, ${data.name}!`;
        
        const dashAccountStatus = document.getElementById('dashAccountStatus');
        if (dashAccountStatus) {
            const kycStatus = data.kycStatus || 'Not Verified';
            if (kycStatus === 'Verified') {
                dashAccountStatus.textContent = 'Verified ✓';
                dashAccountStatus.style.color = '#22c55e';
            } else if (kycStatus === 'Pending') {
                dashAccountStatus.textContent = 'Pending Review';
                dashAccountStatus.style.color = '#f59e0b';
            } else {
                dashAccountStatus.textContent = 'Not Verified';
                dashAccountStatus.style.color = '#ef4444';
            }
        }

        const dashSeniorId = document.getElementById('dashSeniorId');
        if (dashSeniorId) dashSeniorId.textContent = data.seniorId || 'OSCA-PENDING';

        const dashKycBadge = document.getElementById('dashKycBadge');
        const dashKycMessage = document.getElementById('dashKycMessage');
        const kycStatus = data.kycStatus || 'Not Verified';
        if (dashKycBadge) {
            dashKycBadge.textContent = kycStatus === 'Verified' ? 'Verified ✓' : kycStatus === 'Pending' ? 'Pending Review' : 'Not Verified';
            dashKycBadge.style.background = kycStatus === 'Verified' ? 'rgba(34,197,94,0.3)' : kycStatus === 'Pending' ? 'rgba(245,158,11,0.3)' : 'rgba(255,255,255,0.2)';
        }
        if (dashKycMessage) {
            if (kycStatus === 'Verified') dashKycMessage.textContent = 'You can now access all benefits and services.';
            else if (kycStatus === 'Pending') dashKycMessage.textContent = 'Your verification is being reviewed. You will be notified once approved.';
            else dashKycMessage.textContent = 'Get verified to access all benefits and services.';
        }

        const dashMemberSince = document.getElementById('dashMemberSince');
        if (dashMemberSince) {
            const date = data.createdAt ? new Date(data.createdAt) : null;
            dashMemberSince.textContent = date ? date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '—';
        }

        const today = new Date();
        const monthName = today.toLocaleDateString('en-US', { month: 'long' });
        const year = today.getFullYear();
        const firstDay = new Date(year, today.getMonth(), 1);
        const lastDay = new Date(year, today.getMonth() + 1, 0);
        const pensionDateStr = `${monthName} ${firstDay.getDate()} - ${monthName} ${lastDay.getDate()}`;
        const dashPensionDate = document.getElementById('pensionDate');
        const dashPensionAmount = document.getElementById('pensionAmount');
        if (dashPensionDate) dashPensionDate.textContent = pensionDateStr;
    }

    // --- Populate Profile Input Fields ---
    function populateProfileInputs(data) {
        const editName = document.getElementById('editName');
        const editOscaId = document.getElementById('editOscaId');
        const editEmail = document.getElementById('editEmail');
        const editSex = document.getElementById('editSex');
        const editDob = document.getElementById('editDob');
        const editCivil = document.getElementById('editCivil');
        const editAddress = document.getElementById('editAddress');

        if (editName) editName.value = data.name || '';
        if (editOscaId) editOscaId.value = data.seniorId || 'OSCA-PENDING';
        if (editEmail) editEmail.value = data.email || '';
        if (editSex) editSex.value = data.sex || 'Female';
        if (editDob) editDob.value = data.dob || '';
        if (editCivil) editCivil.value = data.civilStatus || 'Married';
        if (editAddress) editAddress.value = data.address || '';
    }

    // --- Profile Form Submit (Save Profile Update) ---
    const profileEditForm = document.getElementById('profileEditForm');
    if (profileEditForm) {
        profileEditForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const saveBtn = profileEditForm.querySelector('.form-submit-btn');
            const originalText = saveBtn.innerHTML;
            saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
            saveBtn.disabled = true;

            const name = document.getElementById('editName').value.trim();
            const email = document.getElementById('editEmail').value.trim();
            const sex = document.getElementById('editSex').value;
            const dob = document.getElementById('editDob').value;
            const civilStatus = document.getElementById('editCivil').value;
            const address = document.getElementById('editAddress').value.trim();

            try {
                // Update profile in database (DO NOT update seniorId)
                await update(ref(db, 'users/' + currentUserData.uid), {
                    name: name,
                    email: email,
                    sex: sex,
                    dob: dob,
                    civilStatus: civilStatus,
                    address: address
                });

                showToast("Profile details updated successfully!");
            } catch (err) {
                console.error("Profile update failed:", err);
                alert("Failed to update profile: " + err.message);
            } finally {
                saveBtn.innerHTML = originalText;
                saveBtn.disabled = false;
            }
        });
    }

    // --- Dynamic Rendering of Benefits and Notifications from Database ---
    function renderBenefitsAndNotifications(userData) {
        const today = new Date();
        const monthName = today.toLocaleDateString('en-US', { month: 'long' });
        const year = today.getFullYear();
        const firstDay = new Date(year, today.getMonth(), 1);
        const lastDay = new Date(year, today.getMonth() + 1, 0);
        const pensionDateStr = `${monthName} ${firstDay.getDate()} - ${monthName} ${lastDay.getDate()}`;

        const benefitsContainer = document.getElementById('benefitsContainer');
        const dashActiveBenefits = document.getElementById('dashActiveBenefits');
        
        // 1. Load dynamic approved benefits
        let activeBenefitsCount = 2; // base count (pension + health)
        
        if (benefitsContainer) {
            // Keep the default static monthly pension and health assistance, but append dynamically approved claims!
            benefitsContainer.innerHTML = `
                <!-- Monthly Pension -->
                <div class="benefit-card">
                    <div class="benefit-card-left">
                        <div class="benefit-gift-icon">
                            <i class="fas fa-gift"></i>
                        </div>
                        <div>
                            <div class="benefit-title">Monthly Pension <span class="benefit-badge">Approved</span></div>
                            <div class="benefit-sub-grid">
                                <div class="benefit-sub-item">
                                    <span class="benefit-sub-label">Benefit amount</span>
                                    <span class="benefit-sub-val">₱1,500</span>
                                </div>
                                <div class="benefit-sub-item">
                                    <span class="benefit-sub-label">Next Release</span>
                                    <span class="benefit-sub-val">₱1,500</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Healthcare Assistance -->
                <div class="benefit-card">
                    <div class="benefit-card-left">
                        <div class="benefit-gift-icon">
                            <i class="fas fa-gift"></i>
                        </div>
                        <div>
                            <div class="benefit-title">Healthcare Assistance <span class="benefit-badge">Approved</span></div>
                            <div class="benefit-sub-grid">
                                <div class="benefit-sub-item">
                                    <span class="benefit-sub-label">Benefit amount</span>
                                    <span class="benefit-sub-val">₱5,000</span>
                                </div>
                                <div class="benefit-sub-item">
                                    <span class="benefit-sub-label">Next Release</span>
                                    <span class="benefit-sub-val">₱5,000</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            // Append approved claims from database
            if (userData.benefits) {
                for (const [key, benefit] of Object.entries(userData.benefits)) {
                    activeBenefitsCount++;
                    benefitsContainer.innerHTML += `
                        <div class="benefit-card" style="border-left: 4px solid #10b981;">
                            <div class="benefit-card-left">
                                <div class="benefit-gift-icon" style="background:#dcfce7; color:#10b981;">
                                    <i class="fas fa-hand-holding-heart"></i>
                                </div>
                                <div>
                                    <div class="benefit-title">${benefit.title} <span class="benefit-badge" style="background:#dcfce7; color:#15803d;">Approved</span></div>
                                    <div class="benefit-sub-grid">
                                        <div class="benefit-sub-item">
                                            <span class="benefit-sub-label">Type</span>
                                            <span class="benefit-sub-val" style="font-size:1.15rem;">${benefit.amount}</span>
                                        </div>
                                        <div class="benefit-sub-item">
                                            <span class="benefit-sub-label">Approved Date</span>
                                            <span class="benefit-sub-val" style="font-size:1.15rem;">${new Date(benefit.approvedAt).toLocaleDateString()}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `;
                }
            }
        }

        if (dashActiveBenefits) {
            dashActiveBenefits.textContent = activeBenefitsCount;
        }

        // 2. Load dynamic notifications
        const dashNotificationsList = document.getElementById('dashNotificationsList');
        const allNotificationsList = document.getElementById('allNotificationsList');

        if (userData.notifications) {
            let notifHtml = '';
            
            // Loop through notifications reversed (latest first)
            const sortedNotifs = Object.entries(userData.notifications).sort((a, b) => b[1].createdAt - a[1].createdAt);
            
            // Check for new notifications
            if (sortedNotifs.length > 0) {
                const latestNotifTime = sortedNotifs[0][1].createdAt;
                const lastViewTime = localStorage.getItem('lastNotifView_' + userData.uid) || 0;
                if (latestNotifTime > lastViewTime) {
                    const notifBadge = document.getElementById('notifBadge');
                    if (notifBadge) notifBadge.style.display = 'block';
                }
            }
            
            sortedNotifs.forEach(([key, notif]) => {
                const iconColor = notif.title.includes('Approved') ? 'background:#e6f4ea; color:#137333;' : 'background:#fce8e6; color:#c5221f;';
                const icon = notif.title.includes('Approved') ? 'fa-check' : 'fa-bell';
                
                notifHtml += `
                    <div class="notif-item">
                        <div class="notif-left">
                            <div class="notif-icon-circle" style="${iconColor}"><i class="fas ${icon}"></i></div>
                            <div>
                                <div class="notif-title">${notif.title}</div>
                                <div class="notif-desc">${notif.description}</div>
                            </div>
                        </div>
                        <span class="notif-time">${getRelativeTime(notif.createdAt)}</span>
                    </div>
                `;
            });

            // Append default static ones
            const staticNotifs = `
                <div class="notif-item">
                    <div class="notif-left">
                        <div class="notif-icon-circle" style="background:#e6f4ea; color:#137333;"><i class="fas fa-dollar-sign"></i></div>
                        <div>
                            <div class="notif-title">Pension Release</div>
                            <div class="notif-desc">Your ${monthName} pension will be released on ${pensionDateStr}</div>
                        </div>
                    </div>
                    <span class="notif-time">2 hours ago</span>
                </div>
                <div class="notif-item">
                    <div class="notif-left">
                        <div class="notif-icon-circle" style="background:#fce8e6; color:#c5221f;"><i class="fas fa-heartbeat"></i></div>
                        <div>
                            <div class="notif-title">Health Reminder</div>
                            <div class="notif-desc">Schedule your quarterly check-up</div>
                        </div>
                    </div>
                    <span class="notif-time">1 day ago</span>
                </div>
            `;

            if (dashNotificationsList) dashNotificationsList.innerHTML = notifHtml + staticNotifs;
            if (allNotificationsList) allNotificationsList.innerHTML = notifHtml + staticNotifs;
        }
    }

    // --- Dynamic Form Rendering & Templates ---
    const dynamicFormFields = document.getElementById('dynamicFormFields');
    const formTitle = document.getElementById('formTitle');
    const formSubtitle = document.getElementById('formSubtitle');

    function openServiceForm(service) {
        // Switch to service form tab panel
        switchTab('service-form');

        // Reset dynamic fields
        dynamicFormFields.innerHTML = '';

        // Add official form header with logos
        const formLogoHeader = `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 15px 20px; margin-bottom: 20px; border-bottom: 3px solid #1e40af; background: linear-gradient(135deg, #f8fafc, #eef2ff); border-radius: 10px;">
                <img src="/images/form1.jpg" alt="NCSC Logo" style="height: 70px; width: 70px; object-fit: contain; border-radius: 50%;">
                <div style="text-align: center; flex: 1; padding: 0 15px;">
                    <div style="font-size: 0.7rem; color: #475569; font-weight: 600; letter-spacing: 1px; text-transform: uppercase;">Republic of the Philippines</div>
                    <div style="font-size: 0.95rem; color: #1e293b; font-weight: 800; margin: 3px 0; letter-spacing: 0.5px;">NATIONAL COMMISSION OF SENIOR CITIZENS</div>
                    <div style="font-size: 0.7rem; color: #475569; font-weight: 600; letter-spacing: 0.5px;">Office of the Senior Citizens Affairs (OSCA) — Magalang, Pampanga</div>
                </div>
                <img src="/images/form2.jpg" alt="Bagong Pilipinas Logo" style="height: 70px; width: 70px; object-fit: contain;">
            </div>
        `;

        // Safe Fallbacks
        const defaultName = currentUserData ? currentUserData.name : '';
        const defaultId = currentUserData ? (currentUserData.seniorId || '') : '';
        const defaultEmail = currentUserData ? currentUserData.email : '';
        const defaultAddress = currentUserData ? (currentUserData.address || '') : '';
        const defaultDob = currentUserData ? (currentUserData.dob || '') : '';
        const defaultSex = currentUserData ? (currentUserData.sex || 'Female') : 'Female';
        const defaultCivil = currentUserData ? (currentUserData.civilStatus || 'Married') : 'Married';

        if (service === 'burial') {
            formTitle.textContent = 'Burial Assistance Claim Form';
            formSubtitle.textContent = 'Submit a soft copy application for Burial Assistance. OSCA Magalang will generate an endorsement letter for DSWD.';
            
            dynamicFormFields.innerHTML = formLogoHeader + `
                <div class="form-section-title">A. Deceased Senior Citizen Information</div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="deceasedName">Name of Deceased Senior Citizen *</label>
                        <input type="text" id="deceasedName" placeholder="Full Name (Last, Given, Middle)" required>
                    </div>
                    <div class="form-group">
                        <label for="deceasedOscaId">OSCA ID Number *</label>
                        <input type="text" id="deceasedOscaId" placeholder="OSCA ID of Deceased" required>
                    </div>
                </div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="dateOfDeath">Date of Death *</label>
                        <input type="date" id="dateOfDeath" required>
                    </div>
                    <div class="form-group">
                        <label for="causeOfDeath">Cause of Death *</label>
                        <input type="text" id="causeOfDeath" placeholder="Cause of Death" required>
                    </div>
                </div>

                <div class="form-section-title">B. Claimant / Beneficiary Information</div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="claimantName">Full Name of Claimant *</label>
                        <input type="text" id="claimantName" value="${defaultName}" required>
                    </div>
                    <div class="form-group">
                        <label for="claimantRelationship">Relationship to Deceased *</label>
                        <select id="claimantRelationship" required>
                            <option value="Spouse">Spouse</option>
                            <option value="Child">Child / Daughter / Son</option>
                            <option value="Sibling">Sibling</option>
                            <option value="Relative">Other Relative</option>
                            <option value="Authorized Representative">Authorized Representative</option>
                        </select>
                    </div>
                </div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="claimantIdType">Claimant ID Submitted *</label>
                        <input type="text" id="claimantIdType" placeholder="e.g. Driver's License, SSS, OSCA ID" required>
                    </div>
                    <div class="form-group">
                        <label for="claimantContact">Contact Number *</label>
                        <input type="tel" id="claimantContact" placeholder="+63 9xx xxx xxxx" pattern="[0-9\+]+" inputmode="numeric" required>
                    </div>
                </div>

                <div class="form-requirements-checklist">
                    <div class="requirement-checklist-title"><i class="fas fa-file-invoice"></i> Requirements to bring to OSCA Office:</div>
                    <ul class="requirement-list-ul">
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Original Death Certificate</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Barangay Certificate of Indigency (for Burial Assistance)</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Original Senior Citizen ID card of deceased</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Valid Government ID of Claimant</li>
                    </ul>
                </div>
            `;
        } 
        else if (service === 'bedridden') {
            formTitle.textContent = 'Bedridden Senior Assistance & Assessment Form';
            formSubtitle.textContent = 'Submit requests for on-site assessment and care packages for bedridden seniors.';

            dynamicFormFields.innerHTML = formLogoHeader + `
                <div class="form-section-title">A. Bedridden Senior Information</div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="bedriddenName">Name of Bedridden Senior *</label>
                        <input type="text" id="bedriddenName" value="${defaultName}" required>
                    </div>
                    <div class="form-group">
                        <label for="bedriddenOscaId">OSCA ID Number *</label>
                        <input type="text" id="bedriddenOscaId" value="${defaultId}" required>
                    </div>
                </div>
                <div class="form-grid-3">
                    <div class="form-group">
                        <label for="bedriddenDob">Date of Birth</label>
                        <input type="date" id="bedriddenDob" value="${defaultDob}">
                    </div>
                    <div class="form-group">
                        <label for="bedriddenSex">Sex</label>
                        <select id="bedriddenSex">
                            <option value="Male" ${defaultSex === 'Male' ? 'selected' : ''}>Male</option>
                            <option value="Female" ${defaultSex === 'Female' ? 'selected' : ''}>Female</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="bedriddenCivil">Civil Status</label>
                        <select id="bedriddenCivil">
                            <option value="Single" ${defaultCivil === 'Single' ? 'selected' : ''}>Single</option>
                            <option value="Married" ${defaultCivil === 'Married' ? 'selected' : ''}>Married</option>
                            <option value="Widowed" ${defaultCivil === 'Widowed' ? 'selected' : ''}>Widowed</option>
                        </select>
                    </div>
                </div>
                <div class="form-group">
                    <label for="bedriddenAddress">Complete Home Address *</label>
                    <input type="text" id="bedriddenAddress" value="${defaultAddress}" required>
                </div>
                <div class="form-group">
                    <label for="bedriddenCondition">Medical Condition / Reason for Bedridden State *</label>
                    <textarea id="bedriddenCondition" rows="3" placeholder="Briefly describe the senior's current condition (e.g. stroke, severe arthritis, paralysis)..." required></textarea>
                </div>

                <div class="form-section-title">B. Primary Caregiver / Claimant Information</div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="caregiverName">Name of Caregiver / Claimant *</label>
                        <input type="text" id="caregiverName" placeholder="Full Name" required>
                    </div>
                    <div class="form-group">
                        <label for="caregiverRelationship">Relationship to Senior *</label>
                        <select id="caregiverRelationship" required>
                            <option value="Spouse">Spouse</option>
                            <option value="Child">Child (Daughter/Son)</option>
                            <option value="Grandchild">Grandchild</option>
                            <option value="Relative">Relative</option>
                            <option value="Caregiver">Professional Caregiver</option>
                        </select>
                    </div>
                </div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="caregiverContact">Contact Number *</label>
                        <input type="tel" id="caregiverContact" placeholder="Contact number of caregiver" pattern="[0-9\+]+" inputmode="numeric" required>
                    </div>
                    <div class="form-group">
                        <label for="caregiverId">Caregiver ID details *</label>
                        <input type="text" id="caregiverId" placeholder="e.g. SSS, UMID, Voters ID" required>
                    </div>
                </div>

                <div class="form-requirements-checklist">
                    <div class="requirement-checklist-title"><i class="fas fa-images"></i> Requirements to prepare for on-site visit:</div>
                    <ul class="requirement-list-ul">
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Printed picture of the senior showing they are bedridden (proving inability to walk)</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Photocopy of Senior Citizen ID</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Photocopy of Caregiver's Government ID</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> OSCA Personnel on-site medical assessment (filled up during office visit)</li>
                    </ul>
                </div>
            `;
        } 
        else if (service === 'octogenarian' || service === 'centarian') {
            formTitle.textContent = 'Octogenarian, Nonagenarian and Centenarian Benefit Program';
            formSubtitle.textContent = 'Application Form — Republic Act (R.A.) No. 11982 (NCSC Annex "A")';

            dynamicFormFields.innerHTML = formLogoHeader + `
                <div class="form-section-title">A. PERSONAL INFORMATION</div>
                <div class="form-grid-3">
                    <div class="form-group">
                        <label for="ncscRrn">NCSC Registration Reference Number (RRN) <span style="color:#94a3b8;font-weight:400;">(Optional)</span></label>
                        <input type="text" id="ncscRrn" placeholder="Optional">
                    </div>
                    <div class="form-group">
                        <label for="oscaIdNum">OSCA ID Number *</label>
                        <input type="text" id="oscaIdNum" value="${defaultId}" required>
                    </div>
                    <div class="form-group">
                        <label for="milestoneAge">Applicant Milestone Age *</label>
                        <select id="milestoneAge" required>
                            <option value="80" ${service === 'octogenarian' ? 'selected' : ''}>80</option>
                            <option value="85">85</option>
                            <option value="90">90</option>
                            <option value="95">95</option>
                            <option value="100" ${service === 'centarian' ? 'selected' : ''}>100</option>
                        </select>
                    </div>
                </div>
                <div class="form-grid-3">
                    <div class="form-group">
                        <label for="lastName">A.1 Last Name *</label>
                        <input type="text" id="lastName" placeholder="Last Name" required>
                    </div>
                    <div class="form-group">
                        <label for="givenName">A.2 Given Name *</label>
                        <input type="text" id="givenName" value="${defaultName}" required>
                    </div>
                    <div class="form-group">
                        <label for="middleName">A.3 Middle Name</label>
                        <input type="text" id="middleName" placeholder="Middle Name">
                    </div>
                </div>
                <div class="form-grid-3">
                    <div class="form-group">
                        <label for="dateOfBirth">A.4 Date of Birth (Month/Day/Year) *</label>
                        <input type="date" id="dateOfBirth" value="${defaultDob}" required>
                    </div>
                    <div class="form-group">
                        <label for="age">A.5 Age *</label>
                        <input type="number" id="age" placeholder="Age" min="60" required>
                    </div>
                    <div class="form-group">
                        <label for="sex">A.8 Sex *</label>
                        <select id="sex" required>
                            <option value="Male" ${defaultSex === 'Male' ? 'selected' : ''}>Male</option>
                            <option value="Female" ${defaultSex === 'Female' ? 'selected' : ''}>Female</option>
                        </select>
                    </div>
                </div>

                <div class="form-group" style="margin-top:8px;">
                    <label style="font-weight:700;">A.6 Residential Address / Address Abroad *</label>
                </div>
                <div class="form-grid-3">
                    <div class="form-group">
                        <label for="resHouseNum">House Number</label>
                        <input type="text" id="resHouseNum" placeholder="House No." required>
                    </div>
                    <div class="form-group">
                        <label for="resStreet">Street</label>
                        <input type="text" id="resStreet" placeholder="Street" required>
                    </div>
                    <div class="form-group">
                        <label for="resBarangay">Barangay</label>
                        <input type="text" id="resBarangay" placeholder="Barangay" required>
                    </div>
                    <div class="form-group">
                        <label for="resCityMunicipality">City/Municipality</label>
                        <input type="text" id="resCityMunicipality" placeholder="City/Municipality" required>
                    </div>
                    <div class="form-group">
                        <label for="resProvince">Province</label>
                        <input type="text" id="resProvince" placeholder="Province" required>
                    </div>
                    <div class="form-group">
                        <label for="resZipCode">Zip Code</label>
                        <input type="text" id="resZipCode" placeholder="Zip Code" required>
                    </div>
                </div>

                <div class="form-group" style="margin-top:8px;">
                    <label style="font-weight:700;">A.7 Permanent Address in the Philippines *</label>
                </div>
                <div class="form-grid-3">
                    <div class="form-group">
                        <label for="permHouseNum">House Number</label>
                        <input type="text" id="permHouseNum" placeholder="House No." required>
                    </div>
                    <div class="form-group">
                        <label for="permStreet">Street</label>
                        <input type="text" id="permStreet" placeholder="Street" required>
                    </div>
                    <div class="form-group">
                        <label for="permBarangay">Barangay</label>
                        <input type="text" id="permBarangay" placeholder="Barangay" required>
                    </div>
                    <div class="form-group">
                        <label for="permCityMunicipality">City/Municipality</label>
                        <input type="text" id="permCityMunicipality" placeholder="City/Municipality" required>
                    </div>
                    <div class="form-group">
                        <label for="permProvince">Province</label>
                        <input type="text" id="permProvince" placeholder="Province" required>
                    </div>
                    <div class="form-group">
                        <label for="permZipCode">Zip Code</label>
                        <input type="text" id="permZipCode" placeholder="Zip Code" required>
                    </div>
                </div>

                <div class="form-grid-3">
                    <div class="form-group">
                        <label for="civilStatus">A.9 Civil Status *</label>
                        <select id="civilStatus" required>
                            <option value="Single" ${defaultCivil === 'Single' ? 'selected' : ''}>Single</option>
                            <option value="Married" ${defaultCivil === 'Married' ? 'selected' : ''}>Married</option>
                            <option value="Widowed" ${defaultCivil === 'Widowed' ? 'selected' : ''}>Widowed</option>
                            <option value="Others">Others</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="citizenship">A.10 Citizenship *</label>
                        <select id="citizenship" required>
                            <option value="Filipino">Filipino</option>
                            <option value="Dual Citizen">Dual Citizen</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="dualCitizenDetails">If Dual Citizen, kindly indicate details:</label>
                        <input type="text" id="dualCitizenDetails" placeholder="Specify details">
                    </div>
                </div>

                <div class="form-section-title">B. FAMILY INFORMATION</div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="spouseName">B.1 Name of Spouse (Last Name, Given Name, Middle Name, Ext.)</label>
                        <input type="text" id="spouseName" placeholder="Spouse Full Name">
                    </div>
                    <div class="form-group">
                        <label for="spouseCitizenship">B.2 Citizenship</label>
                        <input type="text" id="spouseCitizenship" placeholder="e.g. Filipino">
                    </div>
                </div>
                <div class="form-group" style="margin-top:8px;">
                    <label style="font-weight:700;">B.3 Name of Children (Last Name, Given Name, Middle Name, Ext.)</label>
                </div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="child1">1.</label>
                        <input type="text" id="child1" placeholder="Child 1 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child6">6.</label>
                        <input type="text" id="child6" placeholder="Child 6 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child2">2.</label>
                        <input type="text" id="child2" placeholder="Child 2 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child7">7.</label>
                        <input type="text" id="child7" placeholder="Child 7 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child3">3.</label>
                        <input type="text" id="child3" placeholder="Child 3 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child8">8.</label>
                        <input type="text" id="child8" placeholder="Child 8 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child4">4.</label>
                        <input type="text" id="child4" placeholder="Child 4 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child9">9.</label>
                        <input type="text" id="child9" placeholder="Child 9 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child5">5.</label>
                        <input type="text" id="child5" placeholder="Child 5 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child10">10.</label>
                        <input type="text" id="child10" placeholder="Child 10 Full Name">
                    </div>
                </div>

                <div class="form-group" style="margin-top:8px;">
                    <label style="font-weight:700;">B.4 Authorized Representatives (Last Name, Given Name, Middle Name, Ext.)</label>
                </div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="rep1Name">B.4.1 Name of Representative *</label>
                        <input type="text" id="rep1Name" placeholder="Representative 1 Full Name" required>
                    </div>
                    <div class="form-group">
                        <label for="rep1Relationship">Relationship *</label>
                        <input type="text" id="rep1Relationship" placeholder="e.g. Son, Daughter" required>
                    </div>
                    <div class="form-group">
                        <label for="rep2Name">B.4.2 Name of Representative</label>
                        <input type="text" id="rep2Name" placeholder="Representative 2 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="rep2Relationship">Relationship</label>
                        <input type="text" id="rep2Relationship" placeholder="Relationship">
                    </div>
                    <div class="form-group">
                        <label for="rep3Name">B.4.3 Name of Representative</label>
                        <input type="text" id="rep3Name" placeholder="Representative 3 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="rep3Relationship">Relationship</label>
                        <input type="text" id="rep3Relationship" placeholder="Relationship">
                    </div>
                </div>

                <div class="form-section-title">C. CONTACT INFORMATION</div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="contactNums">C.1 Contact Numbers (Telephone and Mobile Numbers) *</label>
                        <input type="tel" id="contactNums" placeholder="e.g. 09171234567" required>
                    </div>
                    <div class="form-group">
                        <label for="emailAddr">C.2 Email Address</label>
                        <input type="email" id="emailAddr" value="${defaultEmail}">
                    </div>
                </div>

                <div class="form-section-title">D. DESIGNATED BENEFICIARY</div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="primaryBeneficiary">D.1 Primary *</label>
                        <input type="text" id="primaryBeneficiary" placeholder="Full Name" required>
                    </div>
                    <div class="form-group">
                        <label for="primaryBeneficiaryRelationship">D.1.1 Relationship *</label>
                        <input type="text" id="primaryBeneficiaryRelationship" placeholder="e.g. Son, Daughter" required>
                    </div>
                    <div class="form-group">
                        <label for="contingentBeneficiary">D.2 Contingent</label>
                        <input type="text" id="contingentBeneficiary" placeholder="Full Name">
                    </div>
                    <div class="form-group">
                        <label for="contingentBeneficiaryRelationship">D.2.2 Relationship</label>
                        <input type="text" id="contingentBeneficiaryRelationship" placeholder="Relationship">
                    </div>
                </div>

                <div class="form-section-title">E. UTILIZATION OF CASH GIFTS (Select all that apply)</div>
                <div class="form-row-checkboxes">
                    <label class="checkbox-label-wrapper">
                        <input type="checkbox" name="cashUtilization" value="Food" checked> Food
                    </label>
                    <label class="checkbox-label-wrapper">
                        <input type="checkbox" name="cashUtilization" value="Medical check-up"> Medical check-up
                    </label>
                    <label class="checkbox-label-wrapper">
                        <input type="checkbox" name="cashUtilization" value="Medicines/Vitamins" checked> Medicines/Vitamins
                    </label>
                    <label class="checkbox-label-wrapper">
                        <input type="checkbox" name="cashUtilization" value="Livelihood / Entrepreneurial Activities"> Livelihood / Entrepreneurial Activities
                    </label>
                    <label class="checkbox-label-wrapper">
                        <input type="checkbox" name="cashUtilization" value="Others"> Others
                    </label>
                </div>
                <div class="form-group" style="margin-top:6px;">
                    <label for="cashUtilOthersSpecify">If Others, kindly specify:</label>
                    <input type="text" id="cashUtilOthersSpecify" placeholder="Specify other utilization">
                </div>

                <div class="form-requirements-checklist">
                    <div class="requirement-checklist-title"><i class="fas fa-file-signature"></i> G. Documentary Requirements (NCSC Annex A):</div>
                    <ul class="requirement-list-ul">
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Duly accomplished Annex A Application Form</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Certificate of Live Birth duly issued or authenticated by the Philippine Statistics Authority (PSA)</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Photocopy of Philippine Identification System ID card / Philippine ID card / National ID card (original copy must be presented)</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Recent 5.08 cm x 5.08 cm (2" x 2") ID picture</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Full body picture of the applicant printed on an A4 size bond/photo paper</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Applicant's inclusion to the endorsed list for validation issued by the Local Chief Executive</li>
                    </ul>
                </div>
            `;
        }
    }

    // --- Interactive Form Submit Handler ---
    const interactiveServiceForm = document.getElementById('interactiveServiceForm');
    if (interactiveServiceForm) {
        interactiveServiceForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const submitBtn = interactiveServiceForm.querySelector('.form-submit-btn');
            const originalText = submitBtn.innerHTML;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing Request...';
            submitBtn.disabled = true;

            try {
                // Collect all form inputs
                const formData = {};
                const inputs = interactiveServiceForm.querySelectorAll('input, select, textarea');
                inputs.forEach(input => {
                    if (input.type === 'checkbox') {
                        if (input.checked) {
                            if (!formData[input.name]) formData[input.name] = [];
                            formData[input.name].push(input.value);
                        }
                    } else {
                        formData[input.id] = input.value;
                    }
                });

                const phoneFields = ['claimantContact', 'caregiverContact', 'contactNums'];
                for (const fieldId of phoneFields) {
                    const el = document.getElementById(fieldId);
                    if (el && el.value && !isValidPhone(el.value)) {
                        showToast(`⚠️ Please enter a valid contact number in the ${el.closest('.form-group')?.querySelector('label')?.textContent || fieldId} field.`);
                        el.focus();
                        submitBtn.innerHTML = originalText;
                        submitBtn.disabled = false;
                        return;
                    }
                }

                // Prepare claim structure for Firebase
                const newClaim = {
                    uid: currentUserData ? currentUserData.uid : 'GUEST_UID',
                    applicantName: currentUserData ? currentUserData.name : 'Unknown Applicant',
                    serviceType: activeServiceType,
                    formData: formData,
                    status: 'Pending',
                    createdAt: Date.now()
                };

                // Push claim to firebase real-time database
                await push(ref(db, 'claims'), newClaim);

                // Show Success Notification Toast
                showToast(`Assistance request for ${activeServiceType.toUpperCase()} submitted successfully!`);

                // Auto-download the DOCX copy for client's record!
                triggerDocxDownload();

                // Go back to dashboard after 2 seconds
                setTimeout(() => {
                    sidebarLinks.forEach(l => l.classList.remove('active'));
                    switchTab('dashboard');
                    submitBtn.innerHTML = originalText;
                    submitBtn.disabled = false;
                }, 2000);

            } catch (err) {
                console.error("Submission failed:", err);
                alert("Failed to submit request: " + err.message);
                submitBtn.innerHTML = originalText;
                submitBtn.disabled = false;
            }
        });
    }

    // --- Download .docx Button Click ---
    const formDownloadBtn = document.getElementById('formDownloadBtn');
    if (formDownloadBtn) {
        formDownloadBtn.addEventListener('click', (e) => {
            e.preventDefault();
            triggerDocxDownload();
        });
    }

    // --- Word Document Template Generator & Download ---
    function triggerDocxDownload() {
        const service = activeServiceType;
        let filename = 'SilverCare_Application.doc';
        let docTitle = 'SilverCare Application Form';
        let bodyHtml = '';

        if (service === 'burial') {
            filename = 'SilverCare_Burial_Assistance_Form.doc';
            docTitle = 'Burial Assistance Claim Form';

            const decName = document.getElementById('deceasedName')?.value || '_______________________';
            const decId = document.getElementById('deceasedOscaId')?.value || '_______________________';
            const deathDate = document.getElementById('dateOfDeath')?.value || '_______________________';
            const causeD = document.getElementById('causeOfDeath')?.value || '_______________________';
            const claimN = document.getElementById('claimantName')?.value || '_______________________';
            const rel = document.getElementById('claimantRelationship')?.value || '_______________________';
            const claimId = document.getElementById('claimantIdType')?.value || '_______________________';
            const contact = document.getElementById('claimantContact')?.value || '_______________________';

            bodyHtml = `
                <div class="title-block">
                    <h2>OFFICE OF THE SENIOR CITIZENS AFFAIRS (OSCA)</h2>
                    <h3>Magalang, Pampanga, Philippines</h3>
                    <h1>BURIAL ASSISTANCE CLAIM APPLICATION</h1>
                </div>

                <div class="section-title">A. DECEASED SENIOR CITIZEN DATA</div>
                <table>
                    <tr>
                        <th width="30%">Deceased Senior Citizen Name</th>
                        <td><strong>${decName.toUpperCase()}</strong></td>
                    </tr>
                    <tr>
                        <th>OSCA Senior Citizen ID Number</th>
                        <td>${decId}</td>
                    </tr>
                    <tr>
                        <th>Date of Death</th>
                        <td>${deathDate}</td>
                    </tr>
                    <tr>
                        <th>Declared Cause of Death</th>
                        <td>${causeD}</td>
                    </tr>
                </table>

                <div class="section-title">B. CLAIMANT & BENEFICIARY INFORMATION</div>
                <table>
                    <tr>
                        <th width="30%">Claimant Full Name</th>
                        <td>${claimN}</td>
                    </tr>
                    <tr>
                        <th>Relationship to Deceased</th>
                        <td>${rel}</td>
                    </tr>
                    <tr>
                        <th>Type of Valid ID Submitted</th>
                        <td>${claimId}</td>
                    </tr>
                    <tr>
                        <th>Contact Number</th>
                        <td>${contact}</td>
                    </tr>
                </table>

                <div class="section-title">C. ELIGIBILITY CHECKS & OSCA ENDORSEMENT</div>
                <p>The claimant certifies under oath that the declared information is completely true and correct. Upon receipt of this form and validation of the original documents listed below, OSCA Magalang will issue a formal <strong>DSWD Endorsement Letter</strong> for social relief disbursement.</p>
                
                <h3>Requirements Submitted:</h3>
                <ul>
                    <li>[ ] Original Certified Death Certificate</li>
                    <li>[ ] Barangay Indigency Certificate of Claimant</li>
                    <li>[ ] Original Senior Citizen ID Card of Deceased</li>
                    <li>[ ] Photocopy of Claimant's Valid ID</li>
                </ul>

                <br><br><br>
                <table style="border:none;">
                    <tr style="border:none;">
                        <td style="border:none; text-align:center;" width="50%">
                            _____________________________________<br>
                            <strong>Signature of Applicant Claimant</strong>
                        </td>
                        <td style="border:none; text-align:center;">
                            _____________________________________<br>
                            <strong>OSCA Officer Validation Signature</strong>
                        </td>
                    </tr>
                </table>
            `;
        }
        else if (service === 'bedridden') {
            filename = 'SilverCare_Bedridden_Assistance_Form.doc';
            docTitle = 'Bedridden Senior Assessment Form';

            const name = document.getElementById('bedriddenName')?.value || '_______________________';
            const osca = document.getElementById('bedriddenOscaId')?.value || '_______________________';
            const dob = document.getElementById('bedriddenDob')?.value || '_______________________';
            const sex = document.getElementById('bedriddenSex')?.value || '_______________________';
            const civil = document.getElementById('bedriddenCivil')?.value || '_______________________';
            const addr = document.getElementById('bedriddenAddress')?.value || '_______________________';
            const cond = document.getElementById('bedriddenCondition')?.value || '_______________________';
            const cgName = document.getElementById('caregiverName')?.value || '_______________________';
            const cgRel = document.getElementById('caregiverRelationship')?.value || '_______________________';
            const cgCont = document.getElementById('caregiverContact')?.value || '_______________________';
            const cgId = document.getElementById('caregiverId')?.value || '_______________________';

            bodyHtml = `
                <div class="title-block">
                    <h2>OFFICE OF THE SENIOR CITIZENS AFFAIRS (OSCA)</h2>
                    <h3>Magalang, Pampanga, Philippines</h3>
                    <h1>BEDRIDDEN CITIZEN WELFARE ASSESSMENT & AID REQUEST</h1>
                </div>

                <div class="section-title">A. SENIOR PROFILE</div>
                <table>
                    <tr>
                        <th width="30%">Bedridden Senior Name</th>
                        <td><strong>${name.toUpperCase()}</strong></td>
                        <th width="20%">OSCA ID</th>
                        <td>${osca}</td>
                    </tr>
                    <tr>
                        <th>Date of Birth</th>
                        <td>${dob}</td>
                        <th>Sex / Status</th>
                        <td>${sex} / ${civil}</td>
                    </tr>
                    <tr>
                        <th>Complete Address</th>
                        <td colspan="3">${addr}</td>
                    </tr>
                </table>

                <div class="section-title">B. MEDICAL REASONS & DISABILITY DETAILS</div>
                <table>
                    <tr>
                        <th width="30%">Detailed Condition Description</th>
                        <td>${cond}</td>
                    </tr>
                </table>

                <div class="section-title">C. PRIMARY CAREGIVER / REPRESENTATIVE DETAILS</div>
                <table>
                    <tr>
                        <th width="30%">Caregiver Full Name</th>
                        <td>${cgName}</td>
                        <th width="20%">Relationship</th>
                        <td>${cgRel}</td>
                    </tr>
                    <tr>
                        <th>Contact Number</th>
                        <td>${cgCont}</td>
                        <th>Representative ID</th>
                        <td>${cgId}</td>
                    </tr>
                </table>

                <div class="section-title">D. INTERNAL OFFICE ASSESSMENT (FILLED UP BY NCSC STAFF)</div>
                <p>This section is reserved for the OSCA Magalang social assessment and home visit review team.</p>
                <table>
                    <tr>
                        <th width="30%">Date of On-site Visit</th>
                        <td>[ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; / &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; / 2026 ]</td>
                    </tr>
                    <tr>
                        <th>Recommended Action</th>
                        <td>[ &nbsp;&nbsp; ] Approved Care Packages &nbsp;&nbsp;&nbsp;&nbsp; [ &nbsp;&nbsp; ] Secondary Medical Aid &nbsp;&nbsp;&nbsp;&nbsp; [ &nbsp;&nbsp; ] Ineligible</td>
                    </tr>
                    <tr>
                        <th>Assessment Officer Notes</th>
                        <td style="height: 60px;"></td>
                    </tr>
                </table>

                <br><br><br>
                <table style="border:none;">
                    <tr style="border:none;">
                        <td style="border:none; text-align:center;" width="50%">
                            _____________________________________<br>
                            <strong>Signature of Family Representative</strong>
                        </td>
                        <td style="border:none; text-align:center;">
                            _____________________________________<br>
                            <strong>NCSC Magalang Home Visit Inspector</strong>
                        </td>
                    </tr>
                </table>
            `;
        }
        else if (service === 'octogenarian' || service === 'centarian') {
            filename = `SilverCare_${service.toUpperCase()}_Benefit_AnnexA.doc`;
            docTitle = 'NCSC Annex A Benefit Claim Form';

            const rrn = document.getElementById('ncscRrn')?.value || 'N/A';
            const osca = document.getElementById('oscaIdNum')?.value || '_______________________';
            const milestone = document.getElementById('milestoneAge')?.value || '80';
            const ln = document.getElementById('lastName')?.value || '_______________________';
            const gn = document.getElementById('givenName')?.value || '_______________________';
            const mn = document.getElementById('middleName')?.value || '_______________________';
            const dob = document.getElementById('dateOfBirth')?.value || '_______________________';
            const age = document.getElementById('age')?.value || '____';
            const sex = document.getElementById('sex')?.value || '_______________________';
            const civil = document.getElementById('civilStatus')?.value || '_______________________';
            const citizen = document.getElementById('citizenship')?.value || 'Filipino';
            const rAddr = document.getElementById('residentialAddress')?.value || '_______________________';
            const pAddr = document.getElementById('permanentAddress')?.value || '_______________________';
            const spouse = document.getElementById('spouseName')?.value || 'N/A';
            const spouseCit = document.getElementById('spouseCitizenship')?.value || 'N/A';
            const children = document.getElementById('childrenNames')?.value || 'N/A';
            const rep = document.getElementById('repName')?.value || '_______________________';
            const contacts = document.getElementById('contactNums')?.value || '_______________________';
            const email = document.getElementById('emailAddr')?.value || 'N/A';
            const primBen = document.getElementById('primaryBeneficiary')?.value || '_______________________';
            const contBen = document.getElementById('contingentBeneficiary')?.value || 'N/A';

            // Check checkboxes
            const cbChecked = [];
            document.querySelectorAll('input[name="cashUtilization"]:checked').forEach(cb => {
                cbChecked.push(cb.value);
            });
            const utilizationStr = cbChecked.join(', ') || 'Food, Medicines/Vitamins';

            bodyHtml = `
                <div class="title-block">
                    <h2>Republic of the Philippines<br>Office of the President</h2>
                    <h3>NATIONAL COMMISSION OF SENIOR CITIZENS</h3>
                    <h1>APPLICATION FORM (ANNEX A)</h1>
                    <h3>OCTOGENARIAN, NONAGENARIAN AND CENTENARIAN BENEFIT PROGRAM</h3>
                </div>

                <div class="section-title">ADMINISTRATIVE CLASSIFICATION</div>
                <table>
                    <tr>
                        <th width="35%">NCSC Registration Ref Number (RRN)</th>
                        <td>${rrn}</td>
                        <th width="20%">OSCA ID Number</th>
                        <td><strong>${osca}</strong></td>
                    </tr>
                    <tr>
                        <th>Milestone Claiming Age</th>
                        <td colspan="3"><strong>[ X ] ${milestone} Years Old Milestone</strong></td>
                    </tr>
                </table>

                <div class="section-title">A. PERSONAL INFORMATION</div>
                <table>
                    <tr>
                        <th width="25%">Last Name</th>
                        <td width="25%">${ln.toUpperCase()}</td>
                        <th width="25%">Given Name</th>
                        <td width="25%">${gn.toUpperCase()}</td>
                    </tr>
                    <tr>
                        <th>Middle Name</th>
                        <td>${mn}</td>
                        <th>Date of Birth / Age</th>
                        <td>${dob} / ${age} yrs</td>
                    </tr>
                    <tr>
                        <th>Sex</th>
                        <td>${sex}</td>
                        <th>Civil Status</th>
                        <td>${civil}</td>
                    </tr>
                    <tr>
                        <th>Citizenship</th>
                        <td colspan="3">${citizen}</td>
                    </tr>
                    <tr>
                        <th>Residential Address</th>
                        <td colspan="3">${rAddr}</td>
                    </tr>
                    <tr>
                        <th>Permanent Address</th>
                        <td colspan="3">${pAddr}</td>
                    </tr>
                </table>

                <div class="section-title">B. FAMILY INFORMATION</div>
                <table>
                    <tr>
                        <th width="25%">Spouse Full Name</th>
                        <td>${spouse}</td>
                        <th width="25%">Spouse Citizenship</th>
                        <td>${spouseCit}</td>
                    </tr>
                    <tr>
                        <th>Names of Children</th>
                        <td colspan="3">${children}</td>
                    </tr>
                    <tr>
                        <th>Authorized Representative</th>
                        <td colspan="3">${rep}</td>
                    </tr>
                </table>

                <div class="section-title">C. CONTACT & DESIGNATED BENEFICIARY</div>
                <table>
                    <tr>
                        <th width="25%">Contact Numbers</th>
                        <td>${contacts}</td>
                        <th width="25%">Email Address</th>
                        <td>${email}</td>
                    </tr>
                    <tr>
                        <th>Primary Beneficiary</th>
                        <td colspan="3">${primBen}</td>
                    </tr>
                    <tr>
                        <th>Contingent Beneficiary</th>
                        <td colspan="3">${contBen}</td>
                    </tr>
                </table>

                <div class="section-title">D. UTILIZATION OF CASH GIFTS</div>
                <p>The applicant intends to utilize the cash gifts for: <strong>${utilizationStr}</strong></p>

                <div class="section-title">E. VALIDATION REPORT & OATH STATEMENT</div>
                <p>By signing this application, the applicant or authorized representative swears under penalty of perjury that the foregoing facts are fully true. This document serves as proof of online soft-filling registration under R.A. No. 11982.</p>
                
                <br><br><br>
                <table style="border:none;">
                    <tr style="border:none;">
                        <td style="border:none; text-align:center;" width="50%">
                            _____________________________________<br>
                            <strong>Signature of Senior Applicant</strong>
                        </td>
                        <td style="border:none; text-align:center;">
                            _____________________________________<br>
                            <strong>NCSC Validator Official Signature</strong>
                        </td>
                    </tr>
                </table>
            `;
        }

        // Call helper
        downloadWordDoc(filename, docTitle, bodyHtml);
    }

    // --- Helper function for word file generation ---
    function downloadWordDoc(filename, title, htmlBody) {
        const header = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
        <head><title>${title}</title>
        <!--[if gte mso 9]><xml>
        <w:WordDocument>
        <w:View>Print</w:View>
        <w:Zoom>100</w:Zoom>
        <w:DoNotOptimizeForBrowser/>
        </w:WordDocument>
        </xml><![endif]-->
        <style>
            body { font-family: 'Arial', sans-serif; font-size: 11pt; color: #333333; line-height: 1.5; padding: 40px; }
            h1, h2, h3 { color: #1e3a8a; margin-top: 5px; margin-bottom: 5px; }
            h1 { font-size: 16pt; }
            h2 { font-size: 13pt; }
            h3 { font-size: 11pt; }
            table { border-collapse: collapse; width: 100%; margin: 15px 0; }
            th, td { border: 1px solid #cbd5e1; padding: 10px; text-align: left; font-size: 10pt; }
            th { background-color: #f1f5f9; font-weight: bold; color: #1e293b; }
            .title-block { text-align: center; border-bottom: 2px solid #1e3a8a; padding-bottom: 12px; margin-bottom: 25px; }
            .section-title { background-color: #3b82f6; color: white; padding: 8px 12px; font-weight: bold; margin-top: 25px; font-size: 11pt; }
            ul { margin-top: 5px; margin-bottom: 5px; padding-left: 20px; }
            li { font-size: 10pt; line-height: 1.4; margin-bottom: 4px; }
            p { font-size: 10pt; margin-top: 5px; margin-bottom: 10px; }
        </style>
        </head>
        <body>
            ${htmlBody}
        </body>
        </html>`;
        
        const blob = new Blob(['\ufeff' + header], { type: 'application/msword' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // --- Toast Handler ---
    function showToast(message) {
        const toast = document.getElementById('successToast');
        const toastMsg = document.getElementById('toastMessage');
        if (toast && toastMsg) {
            toastMsg.textContent = message;
            toast.classList.add('active');
            setTimeout(() => {
                toast.classList.remove('active');
            }, 3000);
        }
    }
    // --- Custom Health Modals Handlers ---
    window.openAppointmentModal = function() {
        const modal = document.getElementById('appointmentModal');
        if (modal) modal.style.display = 'flex';
    };

    window.openMedicationModal = function() {
        const modal = document.getElementById('medicationsModal');
        if (modal) modal.style.display = 'flex';
    };

    const closeApptModalBtn = document.getElementById('closeAppointmentModal');
    if (closeApptModalBtn) {
        closeApptModalBtn.addEventListener('click', () => {
            document.getElementById('appointmentModal').style.display = 'none';
        });
    }

    const closeMedModalBtn = document.getElementById('closeMedicationsModal');
    if (closeMedModalBtn) {
        closeMedModalBtn.addEventListener('click', () => {
            document.getElementById('medicationsModal').style.display = 'none';
        });
    }

    const apptForm = document.getElementById('appointmentForm');
    if (apptForm) {
        apptForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const doctor = document.getElementById('apptDoctor').value;
            const date = document.getElementById('apptDate').value;
            const time = document.getElementById('apptTime').value;
            
            showToast(`Check-up with ${doctor} on ${date} at ${time} scheduled successfully!`);
            document.getElementById('appointmentModal').style.display = 'none';
            apptForm.reset();
        });
    }

    // Guard for restricted links
    document.querySelectorAll('.restricted-link').forEach(link => {
        link.addEventListener('click', (e) => {
            if (currentUserData && currentUserData.kycStatus !== 'Verified') {
                e.preventDefault();
                showToast('⚠️ Please complete KYC verification first to access this feature.');
            }
        });
    });

    // ══════════════════════════════════════════════════════════════════════════
    // ── KYC VERIFICATION SYSTEM (GCash/Bybit Style) ─────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    let kycStream = null;
    let capturedFaceData = null;

    function renderKycVerificationStatus(userData) {
        const statusContainer = document.getElementById('verificationStatusContainer');
        const formFlow = document.getElementById('verificationFormFlow');
        const verifyPill = document.getElementById('navPillVerification');
        if (!statusContainer) return;

        const kycStatus = userData.kycStatus || 'Not Submitted';

        if (kycStatus === 'Verified') {
            statusContainer.innerHTML = `
                <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 16px; padding: 35px; text-align: center;">
                    <div style="width: 80px; height: 80px; background: #dcfce7; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 18px; font-size: 2.5rem; color: #22c55e;"><i class="fas fa-check-circle"></i></div>
                    <h3 style="color: #166534; font-size: 1.3rem; font-weight: 700; margin-bottom: 10px;">Identity Verified ✓</h3>
                    <p style="color: #15803d; font-size: 0.95rem;">Your identity has been verified. You can now access all services and apply for benefits.</p>
                </div>`;
            if (formFlow) formFlow.style.display = 'none';
            if (verifyPill) {
                verifyPill.style.color = '#22c55e';
                verifyPill.innerHTML = '<i class="fas fa-check-circle" style="margin-right: 5px;"></i>Verified';
            }
        } else if (kycStatus === 'Pending') {
            statusContainer.innerHTML = `
                <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 16px; padding: 35px; text-align: center;">
                    <div style="width: 80px; height: 80px; background: #fef3c7; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 18px; font-size: 2.5rem; color: #f59e0b;"><i class="fas fa-clock"></i></div>
                    <h3 style="color: #92400e; font-size: 1.3rem; font-weight: 700; margin-bottom: 10px;">Verification Pending</h3>
                    <p style="color: #a16207; font-size: 0.95rem;">Your details have been submitted and are being reviewed by an employee. You will be notified once verified.</p>
                </div>`;
            if (formFlow) formFlow.style.display = 'none';
            if (verifyPill) {
                verifyPill.style.color = '#f59e0b';
                verifyPill.innerHTML = '<i class="fas fa-clock" style="margin-right: 5px;"></i>Pending';
            }
        } else if (kycStatus === 'Rejected') {
            statusContainer.innerHTML = `
                <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 16px; padding: 35px; text-align: center; margin-bottom: 20px;">
                    <div style="width: 80px; height: 80px; background: #fee2e2; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 18px; font-size: 2.5rem; color: #ef4444;"><i class="fas fa-times-circle"></i></div>
                    <h3 style="color: #991b1b; font-size: 1.3rem; font-weight: 700; margin-bottom: 10px;">Verification Rejected</h3>
                    <p style="color: #b91c1c; font-size: 0.95rem;">Your verification was declined. Please re-submit with clear and valid information.</p>
                </div>`;
            if (formFlow) formFlow.style.display = 'block';
        } else {
            statusContainer.innerHTML = '';
            if (formFlow) formFlow.style.display = 'block';
        }
    }

    function goToKycStep(step) {
        const step1Content = document.getElementById('kycStep1Content');
        const step2Content = document.getElementById('kycStep2Content');
        const step1Dot = document.getElementById('kycStep1');
        const step2Dot = document.getElementById('kycStep2');
        const connector = document.querySelector('.kyc-step-connector');
        if (!step1Content || !step2Content) return;

        if (step === 2) {
            step1Content.style.display = 'none';
            step2Content.style.display = 'block';
            step1Dot.classList.remove('active');
            step1Dot.classList.add('done');
            step2Dot.classList.add('active');
            if (connector) connector.classList.add('done');
        } else {
            step1Content.style.display = 'block';
            step2Content.style.display = 'none';
            step1Dot.classList.remove('done');
            step1Dot.classList.add('active');
            step2Dot.classList.remove('active');
            if (connector) connector.classList.remove('done');
        }
    }

    // Step navigation: Next
    const kycNextBtn = document.getElementById('kycNextBtn');
    if (kycNextBtn) {
        kycNextBtn.addEventListener('click', () => {
            const firstName = document.getElementById('kycFirstName').value.trim();
            const lastName = document.getElementById('kycLastName').value.trim();
            const address = document.getElementById('kycAddress').value.trim();
            const province = document.getElementById('kycProvince').value.trim();
            const barangay = document.getElementById('kycBarangay').value.trim();
            const citizenship = document.getElementById('kycCitizenship').value.trim();
            const cpNumber = document.getElementById('kycCpNumber').value.trim();

            if (!firstName) { showToast('⚠️ Please enter your first name.'); document.getElementById('kycFirstName').focus(); return; }
            if (!lastName) { showToast('⚠️ Please enter your last name.'); document.getElementById('kycLastName').focus(); return; }
            if (!address) { showToast('⚠️ Please enter your address.'); document.getElementById('kycAddress').focus(); return; }
            if (!province) { showToast('⚠️ Please enter your province.'); document.getElementById('kycProvince').focus(); return; }
            if (!barangay) { showToast('⚠️ Please enter your barangay.'); document.getElementById('kycBarangay').focus(); return; }
            if (!citizenship) { showToast('⚠️ Please enter your citizenship.'); document.getElementById('kycCitizenship').focus(); return; }
            if (!cpNumber) { showToast('⚠️ Please enter your cellphone number.'); document.getElementById('kycCpNumber').focus(); return; }
            if (!isValidPhone(cpNumber)) { showToast('⚠️ Please enter a valid cellphone number (digits only, e.g. 09123456789).'); document.getElementById('kycCpNumber').focus(); return; }

            goToKycStep(2);
        });
    }

    // Step navigation: Back
    const kycBackBtn = document.getElementById('kycBackBtn');
    if (kycBackBtn) {
        kycBackBtn.addEventListener('click', () => {
            goToKycStep(1);
        });
    }

    // Scan Your Face button
    const kycScanFaceBtn = document.getElementById('kycScanFaceBtn');
    const kycVideo = document.getElementById('kycVideo');
    const kycCanvas = document.getElementById('kycCanvas');
    const kycPlaceholder = document.getElementById('kycCameraPlaceholder');
    const kycFaceGuide = document.getElementById('kycFaceGuide');
    const kycCaptureFlash = document.getElementById('kycCaptureFlash');
    const kycCapturedPreview = document.getElementById('kycCapturedPreview');

    if (kycScanFaceBtn) {
        kycScanFaceBtn.addEventListener('click', async () => {
            // If face already captured, re-submit with same data
            if (capturedFaceData) {
                await submitKyc();
                return;
            }

            // If camera is already streaming, capture the frame
            if (kycStream) {
                captureFaceAndSubmit();
                return;
            }

            // Start camera
            kycScanFaceBtn.disabled = true;
            kycScanFaceBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting Camera...';

            try {
                kycStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 } });
                kycVideo.srcObject = kycStream;
                kycPlaceholder.style.display = 'none';
                kycFaceGuide.classList.add('visible');

                kycScanFaceBtn.disabled = false;
                kycScanFaceBtn.innerHTML = '<i class="fas fa-camera"></i> Tap to Capture';
                kycScanFaceBtn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
                kycScanFaceBtn.style.boxShadow = '0 6px 14px rgba(245, 158, 11, 0.3)';
            } catch (err) {
                showToast('⚠️ Camera access denied. Please allow camera permissions.');
                console.error('Camera error:', err);
                kycScanFaceBtn.disabled = false;
                kycScanFaceBtn.innerHTML = '<i class="fas fa-user-check"></i> Scan Your Face';
            }
        });
    }

    async function captureFaceAndSubmit() {
        if (!kycStream || !kycVideo || !kycCanvas) return;

        // Capture frame
        kycCanvas.width = kycVideo.videoWidth;
        kycCanvas.height = kycVideo.videoHeight;
        const ctx = kycCanvas.getContext('2d');
        ctx.drawImage(kycVideo, 0, 0);

        // Flash effect
        if (kycCaptureFlash) {
            kycCaptureFlash.classList.remove('flash');
            void kycCaptureFlash.offsetWidth;
            kycCaptureFlash.classList.add('flash');
        }

        // ── Face Detection Validation ──────────────────────────────────
        kycScanFaceBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Detecting face...';
        kycScanFaceBtn.disabled = true;

        let faceDetected = false;

        try {
            // Try browser-native FaceDetector API (Chrome/Edge)
            if ('FaceDetector' in window) {
                const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 5 });
                const faces = await detector.detect(kycCanvas);
                if (faces.length === 1) {
                    // Validate face size — must be at least 10% of image area
                    const faceArea = faces[0].boundingBox.width * faces[0].boundingBox.height;
                    const imageArea = kycCanvas.width * kycCanvas.height;
                    faceDetected = (faceArea / imageArea) > 0.04;
                    if (faces.length > 1) {
                        showToast('⚠️ Multiple faces detected. Please ensure only your face is in the frame.');
                        resetScanButton();
                        return;
                    }
                } else if (faces.length > 1) {
                    showToast('⚠️ Multiple faces detected. Please ensure only your face is in the frame.');
                    resetScanButton();
                    return;
                }
            }

            // Fallback: Canvas skin-tone pixel analysis
            if (!faceDetected) {
                const imageData = ctx.getImageData(0, 0, kycCanvas.width, kycCanvas.height);
                const data = imageData.data;
                let skinPixels = 0;
                const totalPixels = data.length / 4;

                // Sample center 60% of image (where face should be)
                const startX = Math.floor(kycCanvas.width * 0.2);
                const endX = Math.floor(kycCanvas.width * 0.8);
                const startY = Math.floor(kycCanvas.height * 0.1);
                const endY = Math.floor(kycCanvas.height * 0.7);
                let sampledPixels = 0;

                for (let y = startY; y < endY; y += 2) {
                    for (let x = startX; x < endX; x += 2) {
                        const idx = (y * kycCanvas.width + x) * 4;
                        const r = data[idx], g = data[idx + 1], b = data[idx + 2];

                        // Skin tone detection (works across skin colors)
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
                // A real face in the oval should have 15-75% skin-tone pixels
                faceDetected = skinRatio > 0.12 && skinRatio < 0.80;
            }
        } catch (detectionErr) {
            console.warn('Face detection fallback used:', detectionErr);
            // If detection APIs fail completely, do basic brightness check
            const imageData = ctx.getImageData(0, 0, kycCanvas.width, kycCanvas.height);
            const data = imageData.data;
            let totalBrightness = 0;
            const pixelCount = data.length / 4;
            for (let i = 0; i < data.length; i += 16) {
                totalBrightness += (data[i] + data[i+1] + data[i+2]) / 3;
            }
            const avgBrightness = totalBrightness / (pixelCount / 4);
            // Reject pure black/white images (no camera or blank wall)
            faceDetected = avgBrightness > 30 && avgBrightness < 240;
        }

        if (!faceDetected) {
            showToast('⚠️ No face detected! Please position your face clearly within the oval frame and try again.');
            resetScanButton();
            return;
        }

        // ── Face validated — proceed ───────────────────────────────────
        capturedFaceData = kycCanvas.toDataURL('image/jpeg', 0.7);

        // Stop camera
        kycStream.getTracks().forEach(t => t.stop());
        kycStream = null;
        kycVideo.srcObject = null;
        kycFaceGuide.classList.remove('visible');

        // Show preview
        if (kycCapturedPreview) {
            kycCapturedPreview.src = capturedFaceData;
            kycCapturedPreview.style.display = 'block';
        }

        // Update button
        kycScanFaceBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';
        kycScanFaceBtn.disabled = true;

        // Submit
        submitKyc();
    }

    function resetScanButton() {
        if (kycScanFaceBtn) {
            kycScanFaceBtn.disabled = false;
            kycScanFaceBtn.innerHTML = '<i class="fas fa-camera"></i> Tap to Capture';
            kycScanFaceBtn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
            kycScanFaceBtn.style.boxShadow = '0 6px 14px rgba(245, 158, 11, 0.3)';
        }
    }

    async function submitKyc() {
        if (!capturedFaceData || !currentUserData) return;

        const firstName = document.getElementById('kycFirstName').value.trim();
        const middleName = document.getElementById('kycMiddleName').value.trim();
        const lastName = document.getElementById('kycLastName').value.trim();
        const extension = document.getElementById('kycExtension').value.trim();
        const address = document.getElementById('kycAddress').value.trim();
        const province = document.getElementById('kycProvince').value.trim();
        const barangay = document.getElementById('kycBarangay').value.trim();
        const city = document.getElementById('kycCity').value.trim();
        const citizenship = document.getElementById('kycCitizenship').value.trim();
        const cpNumber = document.getElementById('kycCpNumber').value.trim();

        const fullName = [firstName, middleName, lastName]
            .filter(Boolean)
            .join(' ') + (extension ? ` ${extension}` : '');

        try {
            await update(ref(db, 'users/' + currentUserData.uid), {
                name: fullName,
                firstName: firstName,
                middleName: middleName,
                lastName: lastName,
                extension: extension,
                address: address,
                province: province,
                barangay: barangay,
                city: city,
                citizenship: citizenship,
                cpNumber: cpNumber,
                kycStatus: 'Pending',
                kycFaceImage: capturedFaceData,
                kycSubmittedAt: Date.now()
            });

            showToast('✅ Verification submitted! An employee will review your information.');
        } catch (err) {
            console.error('KYC submit error:', err);
            showToast('⚠️ Failed to submit verification. Please try again.');

            // Reset button
            if (kycScanFaceBtn) {
                kycScanFaceBtn.disabled = false;
                kycScanFaceBtn.innerHTML = '<i class="fas fa-user-check"></i> Scan Your Face';
                kycScanFaceBtn.style.background = 'linear-gradient(135deg, #22c55e, #16a34a)';
                kycScanFaceBtn.style.boxShadow = '0 6px 14px rgba(34, 197, 94, 0.3)';
            }
        }
    }
});
