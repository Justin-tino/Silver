import { auth, db } from './firebase-init.js';
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signOut, updatePassword, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-auth.js";
import { ref, onValue, update, set, remove } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-database.js";

document.addEventListener('DOMContentLoaded', () => {
    // Check if on Admin page
    if (window.location.pathname !== '/admin') return;

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

    const pendingTable = document.getElementById('pendingUsersTable');
    const adminTable = document.getElementById('adminUsersTable');
    const employeeTable = document.getElementById('employeeUsersTable');
    const seniorTable = document.getElementById('seniorUsersTable');

    if (!pendingTable || !adminTable || !employeeTable || !seniorTable) return;

    const usersRef = ref(db, 'users');
    let allUsersData = {};
    
    function buildStatusBadge(status, role, user) {
        let statusColor = '#94a3b8';
        let statusBg = '#f1f5f9';
        if (status === 'Active') { statusColor = '#166534'; statusBg = '#dcfce7'; }
        else if (status === 'Inactive') { statusColor = '#991b1b'; statusBg = '#fef2f2'; }
        else if (status === 'Deceased') { statusColor = '#1e293b'; statusBg = '#e2e8f0'; }
        const display = (role === 'senior' && user.lifeStatus) ? user.lifeStatus : status;
        return `<span class="status-badge" style="background: ${statusBg}; color: ${statusColor};">${display}</span>`;
    }

    function buildManageBtn(uid) {
        return `<button class="btn manage-btn" data-uid="${uid}" style="background: transparent; color: #3b82f6; border: none; cursor: pointer; font-size: 0.9rem; font-weight: 500;">Manage</button>`;
    }

    onValue(usersRef, (snapshot) => {
        pendingTable.innerHTML = '';
        adminTable.innerHTML = '';
        employeeTable.innerHTML = '';
        seniorTable.innerHTML = '';

        if (!snapshot.exists()) {
            pendingTable.innerHTML = '<tr><td colspan="4" style="text-align:center;">No pending requests.</td></tr>';
            adminTable.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#64748b;">No users found.</td></tr>';
            employeeTable.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#64748b;">No users found.</td></tr>';
            seniorTable.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#64748b;">No users found.</td></tr>';
            return;
        }

        allUsersData = snapshot.val();
        window.allUsersData = allUsersData;
        let pendingCount = 0;
        let adminCount = 0;
        let employeeCount = 0;
        let seniorCount = 0;

        for (const [uid, user] of Object.entries(allUsersData)) {
            const roleBadgeClass = user.role === 'admin' ? 'blue' : (user.role === 'senior' ? 'purple' : 'staff');
            const roleDisplay = user.role.charAt(0).toUpperCase() + user.role.slice(1);

            if (user.status === 'Pending') {
                pendingCount++;
                let details = user.email;
                if (user.role === 'senior') {
                    details += `<br><span style="font-size:0.8rem; color:#64748b;">ID: ${user.seniorId || 'N/A'}</span>`;
                }

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td style="font-weight: 500;">${user.name || 'N/A'}</td>
                    <td><span class="role-badge ${roleBadgeClass}">${roleDisplay}</span></td>
                    <td>${details}</td>
                    <td>
                        <button class="btn approve-btn" data-uid="${uid}" style="background: #22c55e; color: white; padding: 5px 10px; border: none; border-radius: 5px; cursor: pointer; font-size: 0.85rem;"><i class="fas fa-check"></i> Approve</button>
                        <button class="btn reject-btn" data-uid="${uid}" style="background: #ef4444; color: white; padding: 5px 10px; border: none; border-radius: 5px; cursor: pointer; font-size: 0.85rem; margin-left: 5px;"><i class="fas fa-times"></i> Reject</button>
                    </td>
                `;
                pendingTable.appendChild(tr);
                continue;
            }

            const tr = document.createElement('tr');
            const manageBtn = buildManageBtn(uid);
            const statusBadge = buildStatusBadge(user.status, user.role, user);

            if (user.role === 'admin') {
                adminCount++;
                tr.innerHTML = `
                    <td style="font-weight: 500;">${user.name || 'N/A'}</td>
                    <td>${user.email || 'N/A'}</td>
                    <td>${statusBadge}</td>
                    <td>${manageBtn}</td>
                `;
                adminTable.appendChild(tr);
            } else if (user.role === 'employee') {
                employeeCount++;
                tr.innerHTML = `
                    <td style="font-weight: 500;">${user.name || 'N/A'}</td>
                    <td>${user.email || 'N/A'}</td>
                    <td>${statusBadge}</td>
                    <td>${manageBtn}</td>
                `;
                employeeTable.appendChild(tr);
            } else if (user.role === 'senior') {
                seniorCount++;
                const emailOrId = user.seniorId
                    ? `${user.email || ''}<br><span style="font-size:0.8rem; color:#64748b;">ID: ${user.seniorId}</span>`
                    : (user.email || 'N/A');
                tr.innerHTML = `
                    <td style="font-weight: 500;">${user.name || 'N/A'}</td>
                    <td>${emailOrId}</td>
                    <td>${statusBadge}</td>
                    <td>${manageBtn}</td>
                `;
                seniorTable.appendChild(tr);
            }
        }

        if (pendingCount === 0) {
            pendingTable.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#64748b;">No pending requests.</td></tr>';
        }
        if (adminCount === 0) {
            adminTable.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#64748b;">No admin accounts.</td></tr>';
        }
        if (employeeCount === 0) {
            employeeTable.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#64748b;">No employee accounts.</td></tr>';
        }
        if (seniorCount === 0) {
            seniorTable.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#64748b;">No senior citizens.</td></tr>';
        }

        const adminUsersBadge = document.getElementById('adminUsersBadge');
        if (adminUsersBadge) {
            adminUsersBadge.style.display = pendingCount > 0 ? 'block' : 'none';
        }

        // Attach event listeners for Approve/Reject
        document.querySelectorAll('.approve-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const uid = e.target.closest('.approve-btn').getAttribute('data-uid');
                scConfirm('Are you sure you want to approve this user?', async () => {
                    await update(ref(db, 'users/' + uid), { status: 'Active' });
                    scNotify('success', 'User approved successfully.');
                });
            });
        });

        document.querySelectorAll('.reject-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const uid = e.target.closest('.reject-btn').getAttribute('data-uid');
                scConfirm('Are you sure you want to reject this user request?', async () => {
                    await update(ref(db, 'users/' + uid), { status: 'Rejected' });
                    scNotify('info', 'User request rejected.');
                });
            });
        });

        // Attach event listeners for Manage
        document.querySelectorAll('.manage-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const uid = e.target.getAttribute('data-uid');
                openManageModal(uid, allUsersData[uid]);
            });
        });
    });

    // --- Manage User Modal Logic ---
    const manageUserModal = document.getElementById('manageUserModal');
    const closeManageUserModal = document.getElementById('closeManageUserModal');
    const saveManageUserBtn = document.getElementById('saveManageUserBtn');
    const deleteManageUserBtn = document.getElementById('deleteManageUserBtn');
    let currentManageUid = null;

    function openManageModal(uid, userData) {
        currentManageUid = uid;
        const detailsDiv = document.getElementById('manageUserDetails');
        const lifeStatusSelect = document.getElementById('manageLifeStatus');
        const accountStatusSelect = document.getElementById('manageAccountStatus');
        const passwordSection = document.getElementById('managePasswordSection');

        // Clear password fields
        document.getElementById('manageNewPassword').value = '';
        document.getElementById('manageConfirmPassword').value = '';

        if (passwordSection) {
            passwordSection.style.display = userData.role === 'admin' ? 'none' : 'block';
        }

        let detailsHTML = `<strong>Name:</strong> ${userData.name}<br>
                           <strong>Email:</strong> ${userData.email}<br>
                           <strong>Role:</strong> ${userData.role}`;
        if (userData.role === 'senior') {
            detailsHTML += `<br><strong>Senior ID:</strong> ${userData.seniorId || 'N/A'}`;
            lifeStatusSelect.parentElement.style.display = 'block';
            lifeStatusSelect.value = userData.lifeStatus || 'Active';
        } else {
            lifeStatusSelect.parentElement.style.display = 'none';
        }

        detailsDiv.innerHTML = detailsHTML;
        accountStatusSelect.value = userData.status || 'Active';

        manageUserModal.style.display = 'flex';
    }

    if (closeManageUserModal) {
        closeManageUserModal.addEventListener('click', () => {
            manageUserModal.style.display = 'none';
        });
    }

    if (saveManageUserBtn) {
        saveManageUserBtn.addEventListener('click', async () => {
            if (!currentManageUid) return;
            
            const lifeStatus = document.getElementById('manageLifeStatus').value;
            const accountStatus = document.getElementById('manageAccountStatus').value;
            const newPassword = document.getElementById('manageNewPassword').value;
            const confirmPassword = document.getElementById('manageConfirmPassword').value;
            const userData = allUsersData[currentManageUid];
            
            if (newPassword || confirmPassword) {
                if (newPassword !== confirmPassword) {
                    scNotify('error', 'Passwords do not match.');
                    return;
                }
                if (newPassword.length < 6) {
                    scNotify('warning', 'Password must be at least 6 characters long.');
                    return;
                }
                
                try {
                    const response = await fetch('/api/change-user-password', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ uid: currentManageUid, newPassword })
                    });
                    const data = await response.json();
                    if (data.success) {
                        scNotify('success', 'User password successfully updated.');
                    } else {
                        throw new Error(data.message || 'Unknown error occurred.');
                    }
                } catch (err) {
                    scNotify('error', 'Failed to update user password: ' + err.message);
                    return;
                }
            }

            const updates = { status: accountStatus };
            if (userData.role === 'senior') {
                updates.lifeStatus = lifeStatus;
            }

            try {
                await update(ref(db, 'users/' + currentManageUid), updates);
                manageUserModal.style.display = 'none';
                if (!newPassword) {
                    scNotify('success', 'User updated successfully.');
                }
            } catch (err) {
                scNotify('error', 'Failed to update user: ' + err.message);
            }
        });
    }

    if (deleteManageUserBtn) {
        deleteManageUserBtn.addEventListener('click', () => {
            if (!currentManageUid) return;
            const userData = allUsersData[currentManageUid];
            
            // Prevent deleting the Master Admin or yourself if needed (basic protection)
            if (userData.email === 'admin@silvercare.com') {
                scNotify('error', 'The Master Admin account cannot be deleted.');
                return;
            }

            scConfirm(`Are you sure you want to permanently delete the account for ${userData.name}? This action cannot be undone.`, async () => {
                try {
                    await remove(ref(db, 'users/' + currentManageUid));
                    manageUserModal.style.display = 'none';
                    scNotify('success', 'User account has been permanently deleted.');
                } catch (err) {
                    scNotify('error', 'Failed to delete user: ' + err.message);
                }
            });
        });
    }

    // --- Change Password Button (validates match, then calls API) ---
    const changeUserPasswordBtn = document.getElementById('changeUserPasswordBtn');
    if (changeUserPasswordBtn) {
        changeUserPasswordBtn.addEventListener('click', async () => {
            if (!currentManageUid) return;

            const newPassword = document.getElementById('manageNewPassword').value;
            const confirmPassword = document.getElementById('manageConfirmPassword').value;

            if (newPassword !== confirmPassword) {
                scNotify('error', 'Passwords do not match.');
                return;
            }
            if (!newPassword || newPassword.length < 6) {
                scNotify('warning', 'Password must be at least 6 characters long.');
                return;
            }

            const originalText = changeUserPasswordBtn.innerHTML;
            changeUserPasswordBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Updating...';
            changeUserPasswordBtn.disabled = true;

            try {
                const response = await fetch('/api/change-user-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ uid: currentManageUid, newPassword })
                });
                const data = await response.json();
                if (data.success) {
                    scNotify('success', 'User password successfully updated.');
                    document.getElementById('manageNewPassword').value = '';
                    document.getElementById('manageConfirmPassword').value = '';
                } else {
                    throw new Error(data.message || 'Unknown error occurred.');
                }
            } catch (err) {
                scNotify('error', 'Failed to update user password: ' + err.message);
            } finally {
                changeUserPasswordBtn.innerHTML = originalText;
                changeUserPasswordBtn.disabled = false;
            }
        });
    }

    // --- Admin Face Capture Logic ---
    const adminStartCameraBtn = document.getElementById('adminStartCameraBtn');
    const adminCaptureBtn = document.getElementById('adminCaptureBtn');
    const adminRetakeBtn = document.getElementById('adminRetakeBtn');
    const adminWebcam = document.getElementById('adminWebcam');
    const adminCanvas = document.getElementById('adminCanvas');
    const adminPhotoPreview = document.getElementById('adminPhotoPreview');
    const adminRegisterFaceBtn = document.getElementById('adminRegisterFaceBtn');
    
    let adminStream = null;
    let adminCapturedBase64 = null;

    if (adminStartCameraBtn) {
        adminStartCameraBtn.addEventListener('click', async () => {
            try {
                adminStream = await navigator.mediaDevices.getUserMedia({ video: true });
                adminWebcam.srcObject = adminStream;
                adminWebcam.style.display = 'block';
                adminStartCameraBtn.style.display = 'none';
                adminCaptureBtn.style.display = 'inline-block';
                adminPhotoPreview.style.display = 'none';
            } catch (err) {
                scNotify('error', 'Camera access denied or unavailable.', 'Camera Error');
            }
        });
    }

    if (adminCaptureBtn) {
        adminCaptureBtn.addEventListener('click', () => {
            adminCanvas.width = adminWebcam.videoWidth;
            adminCanvas.height = adminWebcam.videoHeight;
            const context = adminCanvas.getContext('2d');
            context.drawImage(adminWebcam, 0, 0, adminCanvas.width, adminCanvas.height);
            
            adminCapturedBase64 = adminCanvas.toDataURL('image/png');
            adminPhotoPreview.src = adminCapturedBase64;
            
            adminWebcam.style.display = 'none';
            adminCaptureBtn.style.display = 'none';
            adminPhotoPreview.style.display = 'block';
            adminRetakeBtn.style.display = 'inline-block';
            
            if (adminStream) {
                adminStream.getTracks().forEach(track => track.stop());
            }
        });
    }

    if (adminRetakeBtn) {
        adminRetakeBtn.addEventListener('click', () => {
            adminRetakeBtn.style.display = 'none';
            adminCapturedBase64 = null;
            adminStartCameraBtn.click();
        });
    }

    if (adminRegisterFaceBtn) {
        adminRegisterFaceBtn.addEventListener('click', async () => {
            const seniorId = document.getElementById('adminSeniorId').value;
            const seniorName = document.getElementById('adminSeniorName').value;
            const seniorEmail = document.getElementById('adminSeniorEmail').value;

            if (!seniorId || !seniorName) {
                scNotify('warning', 'Please fill in the Senior ID and Full Name.');
                return;
            }

            if (!adminCapturedBase64) {
                scNotify('warning', 'Please capture the senior\'s face first.');
                return;
            }

            const originalText = adminRegisterFaceBtn.innerHTML;
            adminRegisterFaceBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
            adminRegisterFaceBtn.disabled = true;

            try {
                const newRecordId = 'SENIOR_' + Date.now();
                
                await update(ref(db, 'users/' + newRecordId), {
                    seniorId: seniorId,
                    name: seniorName,
                    email: seniorEmail || 'N/A',
                    role: 'senior',
                    status: 'Active',
                    lifeStatus: 'Active',
                    faceImage: adminCapturedBase64,
                    createdAt: Date.now()
                });

                scNotify('success', 'Senior successfully registered with Face Capture!');
                
                document.getElementById('adminSeniorId').value = '';
                document.getElementById('adminSeniorName').value = '';
                document.getElementById('adminSeniorEmail').value = '';
                adminCapturedBase64 = null;
                adminPhotoPreview.style.display = 'none';
                adminStartCameraBtn.style.display = 'inline-block';
                adminRetakeBtn.style.display = 'none';
                
            } catch (error) {
                scNotify('error', 'Failed to register senior: ' + error.message);
            } finally {
                adminRegisterFaceBtn.innerHTML = originalText;
                adminRegisterFaceBtn.disabled = false;
            }
        });
    }

    // --- Add User Modal Logic ---
    const btnAddUser = document.getElementById('btnAddUser');
    const addUserModal = document.getElementById('addUserModal');
    const closeAddUserModal = document.getElementById('closeAddUserModal');
    const addUserForm = document.getElementById('addUserForm');

    if (btnAddUser && addUserModal) {
        btnAddUser.addEventListener('click', () => {
            addUserModal.style.display = 'flex';
        });

        closeAddUserModal.addEventListener('click', () => {
            addUserModal.style.display = 'none';
        });

        addUserForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const name = document.getElementById('addUserName').value;
            const email = document.getElementById('addUserEmail').value;
            const password = document.getElementById('addUserPassword').value;
            const role = document.querySelector('input[name="addUserRole"]:checked').value;
            const submitBtn = addUserForm.querySelector('button');

            const originalText = submitBtn.innerHTML;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';
            submitBtn.disabled = true;

            try {
                const secondaryApp = initializeApp(firebaseConfig, "Secondary" + Date.now());
                const secondaryAuth = getAuth(secondaryApp);

                const userCredential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
                const newUser = userCredential.user;

                await set(ref(db, 'users/' + newUser.uid), {
                    email: email,
                    name: name,
                    role: role,
                    status: 'Active',
                    createdAt: Date.now()
                });

                await signOut(secondaryAuth);
                
                scNotify('success', `User ${name} successfully created as ${role}!`);
                
                addUserForm.reset();
                addUserModal.style.display = 'none';

            } catch (error) {
                scNotify('error', 'Failed to create user: ' + error.message);
            } finally {
                submitBtn.innerHTML = originalText;
                submitBtn.disabled = false;
            }
        });
    }

    // --- Settings Tab Logic ---
    const requestOtpBtn = document.getElementById('requestOtpBtn');
    const otpInputGroup = document.getElementById('otpInputGroup');
    const updatePasswordBtn = document.getElementById('updatePasswordBtn');

    if (requestOtpBtn) {
        requestOtpBtn.addEventListener('click', async () => {
            const newPassword = document.getElementById('newAdminPassword').value;
            const confirmPassword = document.getElementById('confirmAdminPassword').value;

            if (!newPassword || newPassword.length < 6) {
                scNotify('warning', 'Password must be at least 6 characters long.');
                return;
            }
            if (newPassword !== confirmPassword) {
                scNotify('error', 'Passwords do not match.');
                return;
            }

            const user = auth.currentUser;
            if (!user) {
                scNotify('error', 'No active user session found.');
                return;
            }

            const originalText = requestOtpBtn.innerHTML;
            requestOtpBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
            requestOtpBtn.disabled = true;

            try {
                const response = await fetch('/api/send-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: user.email })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    scNotify('success', `Verification OTP sent to ${user.email}`);
                    otpInputGroup.style.display = 'flex';
                    updatePasswordBtn.style.opacity = '1';
                    updatePasswordBtn.style.pointerEvents = 'auto';
                    requestOtpBtn.innerHTML = 'Resend OTP';
                } else {
                    scNotify('error', data.message || 'Failed to send OTP.');
                    requestOtpBtn.innerHTML = originalText;
                }
            } catch (err) {
                scNotify('error', 'Network error. Could not request OTP.');
                requestOtpBtn.innerHTML = originalText;
            } finally {
                requestOtpBtn.disabled = false;
            }
        });
    }

    if (updatePasswordBtn) {
        updatePasswordBtn.addEventListener('click', async () => {
            const newPassword = document.getElementById('newAdminPassword').value;
            const confirmPassword = document.getElementById('confirmAdminPassword').value;
            const otp = document.getElementById('adminOtp').value;

            if (newPassword !== confirmPassword) {
                scNotify('error', 'Passwords do not match.');
                return;
            }
            if (!otp || otp.length !== 6) {
                scNotify('warning', 'Please enter the 6-digit OTP sent to your email.');
                return;
            }

            const user = auth.currentUser;
            if (!user) return;

            const originalText = updatePasswordBtn.innerHTML;
            updatePasswordBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Updating...';
            updatePasswordBtn.disabled = true;

            try {
                // 1. Verify OTP
                const response = await fetch('/api/verify-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: user.email, pin: otp })
                });
                const data = await response.json();

                if (!data.success) {
                    scNotify('error', data.message);
                    return;
                }

                // 2. Update Password via Firebase Auth
                await updatePassword(user, newPassword);
                scNotify('success', 'Master Admin password successfully and securely updated!');
                
                // Reset form
                document.getElementById('newAdminPassword').value = '';
                document.getElementById('confirmAdminPassword').value = '';
                document.getElementById('adminOtp').value = '';
                otpInputGroup.style.display = 'none';
                updatePasswordBtn.style.opacity = '0.5';
                updatePasswordBtn.style.pointerEvents = 'none';
                if(requestOtpBtn) requestOtpBtn.innerHTML = 'Request OTP to Email';

            } catch (error) {
                console.error(error);
                if (error.code === 'auth/requires-recent-login') {
                    scNotify('error', 'Security requirement: Please logout and login again before updating your password.');
                } else {
                    scNotify('error', 'Failed to update password: ' + error.message);
                }
            } finally {
                updatePasswordBtn.innerHTML = originalText;
                updatePasswordBtn.disabled = false;
            }
        });
    }

    const backupDataBtn = document.getElementById('backupDataBtn');
    if (backupDataBtn) {
        backupDataBtn.addEventListener('click', () => {
            if (!window.allUsersData) {
                scNotify('error', 'No data available to backup.');
                return;
            }

            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(window.allUsersData, null, 2));
            const downloadAnchorNode = document.createElement('a');
            downloadAnchorNode.setAttribute("href",     dataStr);
            downloadAnchorNode.setAttribute("download", "SilverCare_Backup_" + Date.now() + ".json");
            document.body.appendChild(downloadAnchorNode); // required for firefox
            downloadAnchorNode.click();
            downloadAnchorNode.remove();
            
            scNotify('success', 'Database backup successfully downloaded.');
        });
    }

    const emailNotifToggle = document.getElementById('emailNotifToggle');
    if (emailNotifToggle) {
        onValue(ref(db, 'system/settings/emailNotifications'), (snapshot) => {
            if(snapshot.exists()) emailNotifToggle.checked = snapshot.val();
        });
        emailNotifToggle.addEventListener('change', async (e) => {
            await set(ref(db, 'system/settings/emailNotifications'), e.target.checked);
            scNotify('info', e.target.checked ? 'Automatic email notifications enabled.' : 'Automatic email notifications disabled.');
        });
    }

    const maintenanceToggle = document.getElementById('maintenanceToggle');
    if (maintenanceToggle) {
        onValue(ref(db, 'system/settings/maintenanceMode'), (snapshot) => {
            if(snapshot.exists()) maintenanceToggle.checked = snapshot.val();
        });
        maintenanceToggle.addEventListener('change', async (e) => {
            await set(ref(db, 'system/settings/maintenanceMode'), e.target.checked);
            scNotify(e.target.checked ? 'warning' : 'success', e.target.checked ? 'Maintenance Mode Enabled. Staff logins restricted.' : 'Maintenance Mode Disabled. System operational.');
        });
    }

    // Real-time transactions activity listener
    const activityContainer = document.getElementById('adminRecentActivityContainer');
    if (activityContainer) {
        onValue(ref(db, 'transactions'), (snapshot) => {
            activityContainer.innerHTML = '';
            if (!snapshot.exists()) {
                activityContainer.innerHTML = `
                    <div style="text-align: center; color: #64748b; padding: 30px 0;">
                        <i class="fas fa-hand-holding-heart" style="font-size:2rem;color:#cbd5e1;margin-bottom:10px;display:block;"></i>
                        No transactions recorded yet.
                    </div>`;
                return;
            }

            const transactions = Object.entries(snapshot.val());
            // Sort by createdAt descending
            transactions.sort((a, b) => b[1].createdAt - a[1].createdAt);

            let tableHtml = `
                <div class="modern-table" style="box-shadow: none; border: none; padding: 0; margin-top: 10px;">
                    <table style="width: 100%; border-collapse: collapse; font-family: 'Inter', sans-serif;">
                        <thead>
                            <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                                <th style="text-align: left; padding: 12px; font-size: 0.8rem; text-transform: uppercase; color: #64748b; font-weight: 700;">Status/Type</th>
                                <th style="text-align: left; padding: 12px; font-size: 0.8rem; text-transform: uppercase; color: #64748b; font-weight: 700;">Senior Name</th>
                                <th style="text-align: left; padding: 12px; font-size: 0.8rem; text-transform: uppercase; color: #64748b; font-weight: 700;">Amount & Ref</th>
                                <th style="text-align: left; padding: 12px; font-size: 0.8rem; text-transform: uppercase; color: #64748b; font-weight: 700;">Processed By</th>
                                <th style="text-align: left; padding: 12px; font-size: 0.8rem; text-transform: uppercase; color: #64748b; font-weight: 700;">Date & Time</th>
                            </tr>
                        </thead>
                        <tbody>
            `;

            transactions.slice(0, 10).forEach(([txId, tx]) => {
                const isApproved = tx.type.toLowerCase().includes('approved');
                const badgeBg = isApproved ? '#dcfce7' : '#fef2f2';
                const badgeColor = isApproved ? '#166534' : '#991b1b';
                
                tableHtml += `
                    <tr style="border-bottom: 1px solid #f1f5f9; transition: background 0.2s;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'">
                        <td style="padding: 15px 12px;">
                            <span class="status-badge" style="background: ${badgeBg}; color: ${badgeColor}; font-weight: 700; font-size: 0.75rem; padding: 5px 10px; border-radius: 6px; text-transform: uppercase; display: inline-block;">
                                ${tx.type}
                            </span>
                        </td>
                        <td style="padding: 15px 12px; font-weight: 600; color: #1e293b;">${tx.seniorName}</td>
                        <td style="padding: 15px 12px;">
                            <div style="font-weight: 700; color: #0f172a;">PHP ${tx.amount}</div>
                            ${tx.refNumber ? `<div style="font-size: 0.75rem; color: #3b82f6; font-family: monospace; font-weight: 700; margin-top: 2px;">${tx.refNumber}</div>` : ''}
                        </td>
                        <td style="padding: 15px 12px; color: #475569; font-size: 0.85rem; font-weight: 500;">
                            <i class="fas fa-user-shield" style="color: #94a3b8; margin-right: 5px;"></i>${tx.processedBy || 'Staff'}
                        </td>
                        <td style="padding: 15px 12px; color: #64748b; font-size: 0.85rem;">${new Date(tx.createdAt).toLocaleString()}</td>
                    </tr>
                `;
            });

            tableHtml += `
                        </tbody>
                    </table>
                </div>
            `;
            activityContainer.innerHTML = tableHtml;
        });
    }

    // ── Verified Seniors Registry (Face Tab) ────────────────────────────────
    const verifiedTableBody = document.getElementById('verifiedSeniorsTableBody');
    const verifiedSeniorSearch = document.getElementById('verifiedSeniorSearch');
    const verifiedEmptyState = document.getElementById('verifiedEmptyState');
    let verifiedSeniorsData = [];

    if (verifiedTableBody) {
        onValue(ref(db, 'users'), (snapshot) => {
            verifiedTableBody.innerHTML = '';
            verifiedSeniorsData = [];

            if (!snapshot.exists()) {
                verifiedTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#94a3b8;">No seniors found.</td></tr>';
                return;
            }

            let totalVerified = 0;
            let pendingKyc = 0;
            let notVerified = 0;

            for (const [uid, user] of Object.entries(snapshot.val())) {
                if (user.role !== 'senior') continue;

                const kycStatus = user.kycStatus || 'Not Verified';
                if (kycStatus === 'Verified') totalVerified++;
                else if (kycStatus === 'Pending' || kycStatus === 'Submitted') pendingKyc++;
                else notVerified++;

                if (kycStatus !== 'Verified') continue;

                const kycBadge = '<span class="status-badge" style="background:#dcfce7;color:#166534;font-weight:600;">Verified</span>';
                const verifiedOn = user.kycVerifiedAt
                    ? new Date(user.kycVerifiedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                    : 'N/A';

                const accountStatus = user.lifeStatus || user.status || 'Active';
                let acctColor = '#94a3b8', acctBg = '#f1f5f9';
                if (accountStatus === 'Active') { acctColor = '#166534'; acctBg = '#dcfce7'; }
                else if (accountStatus === 'Inactive') { acctColor = '#991b1b'; acctBg = '#fef2f2'; }
                else if (accountStatus === 'Deceased') { acctColor = '#1e293b'; acctBg = '#e2e8f0'; }
                else if (accountStatus === 'Transferred' || accountStatus === 'Archived') { acctColor = '#92400e'; acctBg = '#fef3c7'; }

                const entry = { uid, name: user.name, email: user.email, seniorId: user.seniorId, verifiedOn: user.kycVerifiedAt, verifiedBy: user.verifiedBy, accountStatus };
                verifiedSeniorsData.push(entry);

                const tr = document.createElement('tr');
                tr.style.borderBottom = '1px solid #f1f5f9';
                tr.style.cursor = 'pointer';
                tr.style.transition = 'background 0.2s';
                tr.setAttribute('data-name', (user.name || '').toLowerCase());
                tr.setAttribute('data-seniorid', (user.seniorId || '').toLowerCase());

                tr.innerHTML = `
                    <td style="padding: 12px 15px; color: #64748b;"><i class="fas fa-chevron-right" style="font-size:0.7rem;transition:transform 0.2s;"></i></td>
                    <td style="padding: 12px 15px; font-family: monospace; font-weight: 600; color: #3b82f6;">${user.seniorId || 'N/A'}</td>
                    <td style="padding: 12px 15px; font-weight: 600; color: #1e293b;">${user.name || 'N/A'}</td>
                    <td style="padding: 12px 15px; color: #64748b;">${user.email || 'N/A'}</td>
                    <td style="padding: 12px 15px;">${kycBadge}</td>
                    <td style="padding: 12px 15px; color: #475569; font-size: 0.85rem;">${verifiedOn}</td>
                    <td style="padding: 12px 15px; color: #475569; font-size: 0.85rem;">${user.verifiedByEmail ? `<i class="fas fa-user-shield" style="color:#94a3b8;margin-right:4px;"></i>${user.verifiedBy} (${user.verifiedByEmail})` : (user.verifiedBy || '<span style="color:#94a3b8;">N/A</span>')}</td>
                    <td style="padding: 12px 15px;"><span class="status-badge" style="background:${acctBg};color:${acctColor};">${accountStatus}</span></td>
                `;

                // Expandable details row
                const detailsRow = document.createElement('tr');
                detailsRow.style.display = 'none';
                detailsRow.innerHTML = `
                    <td colspan="8" style="padding: 0;">
                        <div style="background: #f8fafc; border-bottom: 1px solid #e2e8f0; padding: 24px 32px; display: flex; gap: 28px;">
                            <div style="flex: 1; min-width: 0;">
                                <h5 style="font-size:0.8rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 14px;"><i class="fas fa-id-card" style="margin-right:6px;color:#3b82f6;"></i>Personal Information</h5>
                                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;">
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">First Name</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.firstName || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Middle Name</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.middleName || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Last Name</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.lastName || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Extension</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.extension || 'N/A'}</span></div>
                                    <div style="grid-column:span 2;"><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Address</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.address || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Province</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.province || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Barangay</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.barangay || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">City</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.city || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Citizenship</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.citizenship || 'N/A'}</span></div>
                                    <div style="grid-column:span 2;"><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Cellphone No.</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.cpNumber || 'N/A'}</span></div>
                                </div>
                            </div>
                            <div style="width: 240px; flex-shrink: 0;">
                                <h5 style="font-size:0.8rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 14px;"><i class="fas fa-camera" style="margin-right:6px;color:#3b82f6;"></i>Face Scan</h5>
                                <div style="background: #0f172a; border-radius: 10px; overflow: hidden; border: 2px solid #e2e8f0; aspect-ratio: 4/3; display: flex; align-items: center; justify-content: center;">
                                    ${user.kycFaceImage
                                        ? `<img src="${user.kycFaceImage}" alt="Face" style="width:100%;height:100%;object-fit:cover;">`
                                        : `<span style="color:#64748b;font-size:0.8rem;text-align:center;"><i class="fas fa-user" style="font-size:2rem;display:block;margin-bottom:6px;opacity:0.5;"></i>No Image</span>`
                                    }
                                </div>
                                <p style="font-size:0.75rem;color:#94a3b8;margin:10px 0 0;text-align:center;">Verified by <strong>${user.verifiedBy || 'N/A'}</strong> on ${verifiedOn}</p>
                            </div>
                        </div>
                    </td>
                `;

                tr.addEventListener('click', () => {
                    const isOpen = detailsRow.style.display !== 'none';
                    detailsRow.style.display = isOpen ? 'none' : 'table-row';
                    const icon = tr.querySelector('.fa-chevron-right');
                    if (icon) icon.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
                });

                verifiedTableBody.appendChild(tr);
                verifiedTableBody.appendChild(detailsRow);
            }

            document.getElementById('statTotalVerified').textContent = totalVerified;
            document.getElementById('statPendingKyc').textContent = pendingKyc;
            document.getElementById('statNotVerified').textContent = notVerified;
            document.getElementById('verifiedSeniorCount').textContent = totalVerified;

            if (verifiedSeniorsData.length === 0) {
                verifiedTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#94a3b8;">No KYC-verified seniors yet.</td></tr>';
            }

            // Re-apply search filter if there's a value
            if (verifiedSeniorSearch && verifiedSeniorSearch.value) {
                filterVerifiedSeniors(verifiedSeniorSearch.value);
            }
        });
    }

    // Global search filter for verified seniors
    window.filterVerifiedSeniors = function (query) {
        const q = query.toLowerCase().trim();
        const rows = verifiedTableBody ? verifiedTableBody.querySelectorAll('tr[data-name]') : [];
        let visibleCount = 0;

        rows.forEach(row => {
            const name = row.getAttribute('data-name') || '';
            const seniorId = row.getAttribute('data-seniorid') || '';
            const match = !q || name.includes(q) || seniorId.includes(q);
            row.style.display = match ? '' : 'none';
            if (match) visibleCount++;

            const detailsRow = row.nextElementSibling;
            if (detailsRow && detailsRow.style.display !== 'none' && !detailsRow.hasAttribute('data-name')) {
                detailsRow.style.display = match ? detailsRow.style.display : 'none';
            }
        });

        if (verifiedEmptyState) {
            verifiedEmptyState.style.display = (visibleCount === 0 && q) ? 'block' : 'none';
        }
    };
});

// Global Report Generation Function
window.generateReport = function(type) {
    if (!window.allUsersData) {
        scNotify('warning', 'No data available to generate report. Please ensure users exist.');
        return;
    }
    
    scNotify('info', `Compiling ${type} report...`);
    
    setTimeout(() => {
        let csvContent = "data:text/csv;charset=utf-8,";
        
        if (type === 'population') {
            csvContent += "Name,Email,Role,Account Status,Life Status,Senior ID\n";
            for (const [uid, user] of Object.entries(window.allUsersData)) {
                if (user.role === 'senior') {
                    csvContent += `"${user.name || ''}","${user.email || ''}","${user.role}","${user.status}","${user.lifeStatus || 'Active'}","${user.seniorId || ''}"\n`;
                }
            }
        } else if (type === 'benefits') {
            csvContent += "Senior ID,Name,Benefit Status,Last Disbursed\n";
            for (const [uid, user] of Object.entries(window.allUsersData)) {
                if (user.role === 'senior') {
                    csvContent += `"${user.seniorId || ''}","${user.name || ''}","Active","${new Date().toLocaleDateString()}"\n`;
                }
            }
        } else if (type === 'health') {
            csvContent += "Senior ID,Name,Health Status,Last Checkup\n";
            for (const [uid, user] of Object.entries(window.allUsersData)) {
                if (user.role === 'senior') {
                    csvContent += `"${user.seniorId || ''}","${user.name || ''}","Stable","N/A"\n`;
                }
            }
        }

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `SilverCare_${type.charAt(0).toUpperCase() + type.slice(1)}_Report.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        scNotify('success', `${type.charAt(0).toUpperCase() + type.slice(1)} Report downloaded successfully!`);
    }, 1500);
};
