require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');

// Initialize Firebase Admin
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- OTP In-Memory Store ---
const otpStore = new Map(); // email -> { pin, expiresAt }

// --- Nodemailer Transporter ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// --- API: Reset Pending Registration (delete pending Firebase Auth + RTDB if same email re-registers) ---
app.post('/api/reset-pending-email', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

    try {
        let uid = null;
        try {
            const userRecord = await admin.auth().getUserByEmail(email);
            uid = userRecord.uid;
        } catch (err) {
            // Not in Firebase Auth — nothing to reset
            return res.json({ success: true, message: 'OK' });
        }

        const userSnap = await admin.database().ref(`users/${uid}`).once('value');
        if (!userSnap.exists()) {
            await admin.auth().deleteUser(uid);
            return res.json({ success: true });
        }

        const userData = userSnap.val();
        if (userData.status === 'Pending') {
            await admin.database().ref(`users/${uid}`).remove();
            await admin.auth().deleteUser(uid);
            return res.json({ success: true, message: 'Pending registration reset.' });
        }

        return res.json({ success: false, message: 'Email already registered with an active account. Please log in.', canReset: false });
    } catch (error) {
        console.error('Error resetting pending email:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// --- API: Send OTP ---
app.post('/api/send-otp', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

    // Generate 6-digit PIN
    const pin = Math.floor(100000 + Math.random() * 900000).toString();

    // Store with 5-minute expiry
    otpStore.set(email, {
        pin: pin,
        expiresAt: Date.now() + 5 * 60 * 1000
    });

    // Professional HTML Email Template
    const htmlEmail = `
    <div style="font-family: 'Inter', Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
        <div style="background: linear-gradient(135deg, #3b82f6, #2563eb); padding: 30px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 1.5rem;">SilverCare</h1>
            <p style="color: rgba(255,255,255,0.8); margin: 5px 0 0; font-size: 0.9rem;">Senior Citizen Welfare Platform</p>
        </div>
        <div style="padding: 30px;">
            <h2 style="color: #1e293b; margin-top: 0;">Email Verification</h2>
            <p style="color: #64748b; line-height: 1.6;">Hello! You are creating an account on SilverCare. Use the verification code below to complete your registration:</p>
            <div style="background: #f1f5f9; border-radius: 12px; padding: 20px; text-align: center; margin: 25px 0;">
                <span style="font-size: 2.5rem; font-weight: 700; letter-spacing: 8px; color: #1e293b;">${pin}</span>
            </div>
            <p style="color: #94a3b8; font-size: 0.85rem;">This code expires in <strong>5 minutes</strong>. If you did not request this, you can safely ignore this email.</p>
        </div>
        <div style="background: #f8fafc; padding: 15px; text-align: center; border-top: 1px solid #e2e8f0;">
            <p style="color: #94a3b8; font-size: 0.75rem; margin: 0;">© 2026 SilverCare - OSCA Magalang</p>
        </div>
    </div>`;

    try {
        await transporter.sendMail({
            from: `"SilverCare OSCA (No-Reply)" <${process.env.EMAIL_USER}>`,
            replyTo: 'noreply@silvercare.com',
            to: email,
            subject: 'SilverCare - Your Verification Code',
            html: htmlEmail
        });

        console.log(`OTP sent to ${email}: ${pin}`);
        res.json({ success: true, message: 'Verification code sent.' });
    } catch (error) {
        console.error('Email send error:', error);
        res.status(500).json({ success: false, message: 'Failed to send email. Check server email config.' });
    }
});

// --- API: Verify OTP ---
app.post('/api/verify-otp', (req, res) => {
    const { email, pin } = req.body;
    if (!email || !pin) return res.status(400).json({ success: false, message: 'Email and PIN are required.' });

    const stored = otpStore.get(email);

    if (!stored) {
        return res.status(400).json({ success: false, message: 'No verification code found. Please request a new one.' });
    }

    if (Date.now() > stored.expiresAt) {
        otpStore.delete(email);
        return res.status(400).json({ success: false, message: 'Verification code has expired. Please request a new one.' });
    }

    if (stored.pin !== pin) {
        return res.status(400).json({ success: false, message: 'Invalid verification code. Please check and try again.' });
    }

    // Valid — clear it
    otpStore.delete(email);
    res.json({ success: true, message: 'Email verified successfully.' });
});

// --- API: Change User Password (Admin) ---
app.post('/api/change-user-password', async (req, res) => {
    const { uid, newPassword } = req.body;
    if (!uid || !newPassword) {
        return res.status(400).json({ success: false, message: 'UID and new password are required.' });
    }

    try {
        await admin.auth().updateUser(uid, {
            password: newPassword
        });
        res.json({ success: true, message: 'User password updated successfully.' });
    } catch (error) {
        console.error('Error changing user password:', error);
        res.status(500).json({ success: false, message: 'Failed to update user password: ' + error.message });
    }
});

// --- API: Send Unified Status Notification Email ---
app.post('/api/send-status-email', async (req, res) => {
    const { email, name, type, amount, refNumber, reason, serviceType } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

    let title = '';
    let subtitle = '';
    let statusTitle = '';
    let statusText = '';
    let isApproved = type.includes('approved');
    let colorThemeGrad = isApproved ? 'linear-gradient(135deg, #16a34a, #15803d)' : 'linear-gradient(135deg, #ef4444, #dc2626)';
    let sectionHtml = '';

    if (type === 'pension_approved') {
        title = 'Pension Payout Approved';
        subtitle = 'Official Monthly Pension Disbursement Notice';
        statusTitle = 'Payout Status: Approved & Released';
        statusText = `We are pleased to inform you that your monthly pension payout has been officially processed and approved by the OSCA administration.`;
        sectionHtml = `
            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 20px; text-align: center; margin: 25px 0;">
                <p style="color: #166534; font-size: 0.9rem; margin: 0 0 5px 0; font-weight: 600;">Disbursed Amount</p>
                <span style="font-size: 2.2rem; font-weight: 800; color: #15803d; letter-spacing: -1px;">PHP ${amount || '1,500'}</span>
            </div>
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 25px; margin-top: 20px;">
                <h3 style="color: #0f172a; margin-top: 0; font-size: 1.05rem;">Instructions to Claim:</h3>
                <ul style="color: #475569; padding-left: 20px; font-size: 0.95rem; line-height: 1.6; margin-bottom: 0;">
                    <li>Please bring your physical <strong>OSCA Identification Card</strong>.</li>
                    <li>Proceed to the designated OSCA Magalang Distribution Center.</li>
                    <li>Present this email or your online portal notification to the receiving officer.</li>
                    <li>Unclaimed pensions will be forfeited after 30 days of this notice.</li>
                </ul>
            </div>`;
    } else if (type === 'pension_declined') {
        title = 'Pension Payout Declined';
        subtitle = 'Monthly Pension Status Update';
        statusTitle = 'Payout Status: Declined / Suspended';
        statusText = `We regret to inform you that your monthly pension payout for this period was not approved during our verification process.`;
        sectionHtml = `
            <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 12px; padding: 20px; margin: 25px 0;">
                <p style="color: #991b1b; font-size: 0.95rem; margin: 0 0 5px 0; font-weight: 700;">Reason for Decline:</p>
                <p style="color: #ef4444; font-size: 0.95rem; margin: 0; line-height: 1.5;">${reason || 'Document verification discrepancy or account status mismatch. Please visit the local OSCA office.'}</p>
            </div>
            <p style="color: #64748b; font-size: 0.9rem; line-height: 1.6;">If you believe this was an error, please visit the OSCA Magalang center with your physical OSCA ID card and latest proof of residency.</p>`;
    } else if (type === 'claim_approved') {
        const sType = serviceType ? serviceType.toUpperCase() : 'WELFARE ASSISTANCE';
        title = `${sType} Request Approved`;
        subtitle = 'Official Welfare Assistance Payout Notice';
        statusTitle = 'Request Status: Approved & Released';
        statusText = `We are pleased to inform you that your requested welfare assistance claim for <strong>${sType}</strong> has been reviewed and officially approved by the OSCA administration.`;
        sectionHtml = `
            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 20px; text-align: center; margin: 25px 0;">
                <p style="color: #166534; font-size: 0.9rem; margin: 0 0 5px 0; font-weight: 600;">Approved Assistance Amount</p>
                <span style="font-size: 2.2rem; font-weight: 800; color: #15803d; letter-spacing: -1px;">PHP ${amount || '10,000'}</span>
            </div>
            <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 12px; padding: 20px; text-align: center; margin: 20px 0;">
                <p style="color: #1e3a8a; font-size: 0.9rem; margin: 0 0 5px 0; font-weight: 600;">OFFICIAL CLAIM REFERENCE NUMBER</p>
                <span style="font-size: 1.6rem; font-weight: 800; color: #2563eb; letter-spacing: 2px;">${refNumber || 'REF-8263A2'}</span>
            </div>
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 25px; margin-top: 20px;">
                <h3 style="color: #0f172a; margin-top: 0; font-size: 1.05rem;">Instructions to Claim Assistance Payout:</h3>
                <ul style="color: #475569; padding-left: 20px; font-size: 0.95rem; line-height: 1.6; margin-bottom: 0;">
                    <li>Please bring your physical <strong>OSCA Identification Card</strong>.</li>
                    <li>Present your <strong>Official Claim Reference Number (${refNumber || 'REF-8263A2'})</strong>.</li>
                    <li>Proceed to the OSCA Magalang Central Office.</li>
                    <li>Ensure you have the registered claimant's proof of relationship if claiming on behalf of a senior.</li>
                </ul>
            </div>`;
    } else if (type === 'claim_declined') {
        const sType = serviceType ? serviceType.toUpperCase() : 'WELFARE ASSISTANCE';
        title = `${sType} Request Declined`;
        subtitle = 'Welfare Assistance Status Update';
        statusTitle = 'Request Status: Declined / Rejected';
        statusText = `We regret to inform you that your requested welfare assistance claim for <strong>${sType}</strong> was not approved during our verification and review process.`;
        sectionHtml = `
            <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 12px; padding: 20px; margin: 25px 0;">
                <p style="color: #991b1b; font-size: 0.95rem; margin: 0 0 5px 0; font-weight: 700;">Reason for Decline:</p>
                <p style="color: #ef4444; font-size: 0.95rem; margin: 0; line-height: 1.5;">${reason || 'Required documentation was missing or could not be verified by the local OSCA officers.'}</p>
            </div>
            <p style="color: #64748b; font-size: 0.9rem; line-height: 1.6;">If you have further questions or wish to appeal this decision, please bring your physical OSCA ID card along with all relevant documents to the OSCA Magalang office.</p>`;
    }

    const htmlEmail = `
    <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
        <div style="background: ${colorThemeGrad}; padding: 30px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 1.5rem;">SilverCare Welfare Division</h1>
            <p style="color: rgba(255,255,255,0.8); margin: 5px 0 0; font-size: 0.9rem;">Office of the Senior Citizens Affairs (OSCA)</p>
        </div>
        <div style="padding: 30px;">
            <h2 style="color: #1e293b; margin-top: 0; font-size: 1.3rem;">${title}</h2>
            <p style="color: #475569; line-height: 1.6;">Dear <strong>${name || 'Senior Citizen'}</strong>,</p>
            <p style="color: #475569; line-height: 1.6;">${statusText}</p>
            
            ${sectionHtml}
        </div>
        <div style="background: #f1f5f9; padding: 20px; text-align: center; border-top: 1px solid #e2e8f0;">
            <p style="color: #64748b; font-size: 0.8rem; margin: 0; font-weight: 500;">© 2026 SilverCare System - OSCA Magalang Official Communication</p>
            <p style="color: #94a3b8; font-size: 0.75rem; margin: 5px 0 0 0;">This is an automated message. Please do not reply.</p>
        </div>
    </div>`;

    try {
        await transporter.sendMail({
            from: `"SilverCare OSCA (No-Reply)" <${process.env.EMAIL_USER}>`,
            replyTo: 'noreply@silvercare.com',
            to: email,
            subject: `Official Notice: ${title}`,
            html: htmlEmail
        });
        res.json({ success: true, message: 'Status notification email sent successfully.' });
    } catch (error) {
        console.error('Email send error:', error);
        res.status(500).json({ success: false, message: 'Failed to send status email.' });
    }
});

// --- API: Verify Login (server-side user data lookup) ---
app.post('/api/verify-login', async (req, res) => {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ success: false, message: 'ID token is required.' });

    try {
        // Verify the Firebase ID token
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const uid = decodedToken.uid;

        // Read user profile from RTDB using Admin SDK (bypasses security rules)
        const userSnap = await admin.database().ref(`users/${uid}`).once('value');

        if (!userSnap.exists()) {
            return res.json({ success: false, message: 'Your user profile was not found in the database. Please contact an administrator.', code: 'profile-not-found' });
        }

        const userData = userSnap.val();

        // Check maintenance mode for non-admins
        let maintenanceMode = false;
        if (userData.role !== 'admin') {
            const maintenanceSnap = await admin.database().ref('system/settings/maintenanceMode').once('value');
            maintenanceMode = maintenanceSnap.exists() && maintenanceSnap.val() === true;
        }

        res.json({
            success: true,
            user: {
                uid: uid,
                email: userData.email,
                name: userData.name,
                role: userData.role,
                status: userData.status
            },
            maintenanceMode: maintenanceMode
        });
    } catch (error) {
        console.error('Verify login error:', error);
        res.status(401).json({ success: false, message: 'Invalid or expired authentication token.' });
    }
});

// --- Serve Firebase Config as a JS module ---
app.get('/js/firebase-config.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`export const firebaseConfig = {
    apiKey: "${process.env.FIREBASE_API_KEY}",
    authDomain: "${process.env.FIREBASE_AUTH_DOMAIN}",
    projectId: "${process.env.FIREBASE_PROJECT_ID}",
    storageBucket: "${process.env.FIREBASE_STORAGE_BUCKET}",
    messagingSenderId: "${process.env.FIREBASE_MESSAGING_SENDER_ID}",
    appId: "${process.env.FIREBASE_APP_ID}",
    measurementId: "${process.env.FIREBASE_MEASUREMENT_ID}",
    databaseURL: "${process.env.FIREBASE_DATABASE_URL}"
};`);
});

// --- Manual Senior Registration (Employee-assisted) ---
app.post('/api/register-senior', async (req, res) => {
    try {
        const { email, password, fullname, firstName, middleName, lastName, extension, seniorId, address, barangay, city, province, postalCode, citizenship, cpNumber, dob, sex, civilStatus, faceImage, registeredBy } = req.body;

        if (!email || !password || !firstName || !lastName || !seniorId) {
            return res.json({ success: false, message: 'Email, password, first name, last name, and Senior ID are required.' });
        }

        if (!faceImage) {
            return res.json({ success: false, message: 'Face scan image is required.' });
        }

        if (password.length < 6) {
            return res.json({ success: false, message: 'Password must be at least 6 characters.' });
        }

        // Create Firebase Auth account using Admin SDK
        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
            displayName: fullname || `${firstName} ${lastName}`
        });

        // Save to Realtime Database as Active (no approval needed — employee-registered)
        await admin.database().ref('users/' + userRecord.uid).set({
            email: email,
            name: fullname || `${firstName} ${lastName}`,
            firstName: firstName || '',
            middleName: middleName || '',
            lastName: lastName || '',
            extension: extension || '',
            role: 'senior',
            status: 'Active',
            seniorId: seniorId,
            address: address || '',
            barangay: barangay || '',
            city: city || '',
            province: province || '',
            postalCode: postalCode || '',
            citizenship: citizenship || '',
            cpNumber: cpNumber || '',
            dob: dob || '',
            sex: sex || '',
            civilStatus: civilStatus || '',
            kycFaceImage: faceImage,
            kycStatus: 'Verified',
            kycVerifiedAt: Date.now(),
            verifiedBy: registeredBy || 'Employee',
            emailVerified: true,
            registeredBy: registeredBy || 'Employee',
            registrationMethod: 'walk-in',
            createdAt: Date.now()
        });

        res.json({ success: true, message: 'Senior citizen account created successfully.', uid: userRecord.uid });
    } catch (error) {
        console.error('Register senior error:', error);
        let msg = 'Failed to create account.';
        if (error.code === 'auth/email-already-exists') {
            msg = 'This email address is already registered in the system.';
        } else if (error.code === 'auth/invalid-email') {
            msg = 'The email address format is invalid.';
        } else if (error.code === 'auth/weak-password') {
            msg = 'Password is too weak. Use at least 6 characters.';
        }
        res.json({ success: false, message: msg });
    }
});

// Basic routing for pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/signup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'views', 'admin.html'));
});

app.get('/employee', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'views', 'employee.html'));
});

app.get('/senior', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'views', 'senior.html'));
});
// Serve Firebase config dynamically from environment variables
app.get('/js/firebase-config.js', (req, res) => {
    res.type('application/javascript');
    res.send(`
export const firebaseConfig = {
    apiKey: "${process.env.FIREBASE_API_KEY}",
    authDomain: "${process.env.FIREBASE_AUTH_DOMAIN}",
    databaseURL: "${process.env.FIREBASE_DATABASE_URL || `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`}",
    projectId: "${process.env.FIREBASE_PROJECT_ID}",
    storageBucket: "${process.env.FIREBASE_STORAGE_BUCKET}",
    messagingSenderId: "${process.env.FIREBASE_MESSAGING_SENDER_ID}",
    appId: "${process.env.FIREBASE_APP_ID}",
    measurementId: "${process.env.FIREBASE_MEASUREMENT_ID}"
};
    `);
});



app.listen(PORT, () => {
    console.log(`SilverCare Server running on http://localhost:${PORT}`);
});

