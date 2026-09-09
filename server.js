require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');
const idVault = require('./lib/supabaseStorage');
const priorityEngine = require('./public/js/priority-engine');
const queueBackend = require('./_queue_backend');

// Initialize Firebase Admin
const fs = require('fs');
let serviceAccount;
if (fs.existsSync('./serviceAccountKey.json')) {
    serviceAccount = require('./serviceAccountKey.json');
} else if (process.env.SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
} else {
    console.error('No service account credentials found. Set SERVICE_ACCOUNT_JSON env var or place serviceAccountKey.json.');
    process.exit(1);
}
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
});

// Auto-sync security rules to Firebase Realtime Database on startup
if (fs.existsSync('./database.rules.json')) {
    try {
        const rulesStr = fs.readFileSync('./database.rules.json', 'utf8');
        admin.database().setRules(rulesStr)
            .then(() => console.log('Firebase Database Security Rules synced successfully.'))
            .catch(err => console.error('Failed to sync Firebase security rules:', err.message));
    } catch (e) {
        console.error('Error reading database.rules.json:', e.message);
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

// --- Disable caching for HTML responses to prevent BFCache security issues ---
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
});

// --- CORS: Restrict to same origin ---
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (same-origin, Postman, server-to-server)
        if (!origin) return callback(null, true);
        const allowed = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
        if (allowed.includes(origin)) return callback(null, true);
        callback(new Error('Not allowed by CORS'));
    }
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// --- Serve Firebase Config dynamically BEFORE static files ---
// This route takes precedence over the hardcoded public/js/firebase-config.js
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

app.use(express.static(path.join(__dirname, 'public')));

// --- OTP In-Memory Store ---
const otpStore = new Map(); // email -> { pin, expiresAt }
const otpAttempts = new Map(); // email -> { count, lockedUntil }

// --- Nodemailer Transporter ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// --- Security: Auth Middleware ---
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    try {
        const idToken = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(idToken);
        const userSnap = await admin.database().ref(`users/${decoded.uid}`).once('value');
        if (!userSnap.exists()) {
            return res.status(403).json({ success: false, message: 'User profile not found.' });
        }
        req.authUser = { uid: decoded.uid, ...userSnap.val() };
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.authUser || !roles.includes(req.authUser.role)) {
            return res.status(403).json({ success: false, message: 'Insufficient permissions.' });
        }
        next();
    };
}

// --- Security: HTML Sanitizer for email content ---
function sanitizeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

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

        console.log(`OTP sent to ${email}`);
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

    // --- Brute-force protection ---
    const attempts = otpAttempts.get(email);
    if (attempts && attempts.lockedUntil && Date.now() < attempts.lockedUntil) {
        const remainSec = Math.ceil((attempts.lockedUntil - Date.now()) / 1000);
        return res.status(429).json({ success: false, message: `Too many failed attempts. Please wait ${remainSec} seconds.` });
    }

    const stored = otpStore.get(email);

    if (!stored) {
        return res.status(400).json({ success: false, message: 'No verification code found. Please request a new one.' });
    }

    if (Date.now() > stored.expiresAt) {
        otpStore.delete(email);
        return res.status(400).json({ success: false, message: 'Verification code has expired. Please request a new one.' });
    }

    if (stored.pin !== pin) {
        // Track failed attempts
        const current = otpAttempts.get(email) || { count: 0 };
        current.count += 1;
        if (current.count >= 5) {
            current.lockedUntil = Date.now() + 5 * 60 * 1000; // lock for 5 minutes
            current.count = 0;
            otpStore.delete(email);
        }
        otpAttempts.set(email, current);
        return res.status(400).json({ success: false, message: 'Invalid verification code. Please check and try again.' });
    }

    // Valid — clear it
    otpStore.delete(email);
    otpAttempts.delete(email);
    res.json({ success: true, message: 'Email verified successfully.' });
});

// --- API: Change User Password (Admin) ---
app.post('/api/change-user-password', requireAuth, requireRole('admin'), async (req, res) => {
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
app.post('/api/send-status-email', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { email, type } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

    // Sanitize all user-supplied values to prevent HTML injection in emails
    const name = sanitizeHtml(req.body.name);
    const amount = sanitizeHtml(req.body.amount);
    const refNumber = sanitizeHtml(req.body.refNumber);
    const reason = sanitizeHtml(req.body.reason);
    const serviceType = sanitizeHtml(req.body.serviceType);

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

// ============================================================
// Two-Factor Authentication (2FA) for Admin & OSCA Staff ONLY.
// Kind of 2FA used: E-mail One-Time PIN (6-digit, single-use,
// 5-minute expiry, bound to the authenticated uid, with brute-
// force lockout). Senior citizens intentionally use simplified
// login (panel requirement — 2FA must NOT burden seniors).
// ============================================================
const twoFAStore = new Map(); // uid -> { code, expiresAt, attempts, lastSentAt }
const TWOFA_TTL_MS = 5 * 60 * 1000;
const TWOFA_RESEND_MS = 30 * 1000;
const TWOFA_MAX_ATTEMPTS = 5;

function twoFAEmailTemplate(pin) {
    return `
    <div style="font-family: 'Inter', Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
        <div style="background: linear-gradient(135deg, #1e3a8a, #2563eb); padding: 30px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 1.5rem;">SilverCare</h1>
            <p style="color: rgba(255,255,255,0.8); margin: 5px 0 0; font-size: 0.9rem;">OSCA Magalang — Staff Portal</p>
        </div>
        <div style="padding: 30px;">
            <h2 style="color: #1e293b; margin-top: 0;">Two-Factor Authentication</h2>
            <p style="color: #64748b; line-height: 1.6;">Use the security code below to finish signing in to your staff account:</p>
            <div style="background: #f1f5f9; border-radius: 12px; padding: 20px; text-align: center; margin: 25px 0;">
                <span style="font-size: 2.5rem; font-weight: 700; letter-spacing: 8px; color: #1e293b;">${pin}</span>
            </div>
            <p style="color: #94a3b8; font-size: 0.85rem;">This code expires in <strong>5 minutes</strong> and can only be used once. If you did not attempt to sign in, please change your password immediately.</p>
        </div>
        <div style="background: #f8fafc; padding: 15px; text-align: center; border-top: 1px solid #e2e8f0;">
            <p style="color: #94a3b8; font-size: 0.75rem; margin: 0;">© 2026 SilverCare - OSCA Magalang</p>
        </div>
    </div>`;
}

// --- API: Start 2FA challenge (admin/staff, authenticated with a valid Firebase ID token) ---
app.post('/api/2fa/start', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    try {
        const actor = req.authUser;
        const existing = twoFAStore.get(actor.uid);

        // Rate-limit resend attempts
        if (existing && existing.lastSentAt && (Date.now() - existing.lastSentAt) < TWOFA_RESEND_MS) {
            const waitSec = Math.ceil((TWOFA_RESEND_MS - (Date.now() - existing.lastSentAt)) / 1000);
            return res.status(429).json({ success: false, message: `Please wait ${waitSec}s before requesting a new code.` });
        }

        const code = String(Math.floor(100000 + Math.random() * 900000));
        twoFAStore.set(actor.uid, {
            code: code,
            expiresAt: Date.now() + TWOFA_TTL_MS,
            attempts: 0,
            lastSentAt: Date.now()
        });

        await transporter.sendMail({
            from: `"SilverCare OSCA (No-Reply)" <${process.env.EMAIL_USER}>`,
            replyTo: 'noreply@silvercare.com',
            to: actor.email,
            subject: 'SilverCare Staff Sign-In — Security Code',
            html: twoFAEmailTemplate(code)
        });

        const masked = String(actor.email).replace(/^(.).*(@.*)$/, '$1*****$2');
        await writeAuditLog('LOGIN_2FA_STARTED', actor, actor.uid, null, `2FA code e-mailed to ${masked}`);
        res.json({ success: true, message: `A 6-digit security code was sent to ${masked}.` });
    } catch (error) {
        console.error('2FA start error:', error);
        res.status(500).json({ success: false, message: 'Failed to send the security code. Please try again.' });
    }
});

// --- API: Verify 2FA challenge (admin/staff). Single-use, bound to uid. ---
app.post('/api/2fa/verify', requireAuth, requireRole('admin', 'employee'), (req, res) => {
    const actor = req.authUser;
    const code = String(req.body.code || '').trim();
    if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({ success: false, message: 'Enter the 6-digit security code.' });
    }

    const entry = twoFAStore.get(actor.uid);
    if (!entry) {
        return res.status(400).json({ success: false, message: 'No security code requested. Please request a new one.' });
    }
    if (Date.now() > entry.expiresAt) {
        twoFAStore.delete(actor.uid);
        return res.status(400).json({ success: false, message: 'Security code expired. Please request a new one.' });
    }
    if (entry.attempts >= TWOFA_MAX_ATTEMPTS) {
        twoFAStore.delete(actor.uid);
        return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
    }

    if (entry.code !== code) {
        entry.attempts += 1;
        return res.status(400).json({
            success: false,
            message: `Incorrect code. ${TWOFA_MAX_ATTEMPTS - entry.attempts} attempt(s) remaining.`
        });
    }

    // Success — single use
    twoFAStore.delete(actor.uid);
    writeAuditLog('LOGIN_2FA_SUCCESS', actor, actor.uid, null, 'Staff sign-in completed with 2FA');
    res.json({ success: true, message: 'Two-factor authentication verified.' });
});

// ============================================================
// Duplicate Record Detection
// A senior is considered a duplicate when the SAME Senior ID
// already exists, OR the same normalized first+last name AND
// date of birth already exist. Prevents double registration so
// each senior citizen is listed only once in the system.
// ============================================================
function normalizeNameStr(s) {
    return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}

async function findDuplicateSeniorRecord({ seniorId, firstName, lastName, dob }) {
    const normId = String(seniorId || '').trim().toUpperCase();
    const normFirst = normalizeNameStr(firstName);
    const normLast = normalizeNameStr(lastName);
    const normDob = String(dob || '').trim();

    if (!normId && !(normFirst && normLast && normDob)) return null;

    const snap = await admin.database().ref('users').orderByChild('role').equalTo('senior').once('value');
    const users = snap.val() || {};
    for (const [uid, u] of Object.entries(users)) {
        if (normId && String(u.seniorId || '').trim().toUpperCase() === normId) {
            return { uid, matchedBy: 'seniorId', name: u.name || 'Unknown', seniorId: u.seniorId };
        }
        if (normFirst && normLast && normDob &&
            normalizeNameStr(u.firstName) === normFirst &&
            normalizeNameStr(u.lastName) === normLast &&
            String(u.dob || '').trim() === normDob) {
            return { uid, matchedBy: 'name+dob', name: u.name || 'Unknown', seniorId: u.seniorId || '' };
        }
    }
    return null;
}

// --- API: Live duplicate check used by the registration form ---
app.post('/api/check-senior-duplicate', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    try {
        const dup = await findDuplicateSeniorRecord(req.body || {});
        if (dup) {
            return res.json({
                success: true,
                duplicate: true,
                matchedBy: dup.matchedBy,
                existingName: dup.name,
                existingSeniorId: dup.seniorId || ''
            });
        }
        res.json({ success: true, duplicate: false });
    } catch (error) {
        console.error('Duplicate check error:', error);
        res.status(500).json({ success: false, message: 'Failed to run duplicate check.' });
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


// --- Manual Senior Registration (Employee-assisted) ---
app.post('/api/register-senior', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
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

        // Duplicate record detection — each senior may be registered only once.
        const duplicate = await findDuplicateSeniorRecord({ seniorId, firstName, lastName, dob });
        if (duplicate) {
            const reason = duplicate.matchedBy === 'seniorId'
                ? `A senior citizen with Senior ID "${seniorId}" is already registered`
                : `A senior citizen with the same name and date of birth is already registered`;
            return res.json({
                success: false,
                duplicate: true,
                message: `${reason} (${duplicate.name}${duplicate.seniorId ? ', ID ' + duplicate.seniorId : ''}). Duplicate records are not allowed.`
            });
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

        // Accountability: record WHO registered this senior.
        await writeAuditLog('REGISTER_SENIOR_RECORD', req.authUser, userRecord.uid, null,
            `Registered senior "${fullname || `${firstName} ${lastName}`}" (Senior ID: ${seniorId}) via walk-in registration`);

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
// ============================================================
// Health Records (Consent-Gated / RBAC / Audit-Trail)
// Per Data Privacy Act of 2012 (RA 10173):
//   - Health records are highly sensitive personal information.
//   - Access is ONLY granted after the senior (or authorized
//     guardian) has explicitly granted consent via the client.
//   - Only admin/staff may write; seniors may only read their
//     OWN records. Viewing or editing is always logged.
//   - Recovery plan status is tracked per senior for continuity
//     of care across all affiliated Barangay Health Centers.
// Firebase RTDB = single source of truth.
// ============================================================
const DEFAULT_HEALTH_CONSENT_MESSAGE =
    'I hereby give my consent for SilverCare / OSCA Magalang to ' +
    'collect, store, and securely share my personal health records ' +
    'with authorized Barangay Health Center personnel for the purpose ' +
    'of medical assistance, health monitoring, and continuity of care. ' +
    'I understand that I may withdraw this consent at any time.';

// --- API: Get health records (consent-gated; seniors read-only own) ---
app.get('/api/health-records/:uid', requireAuth, async (req, res) => {
    const { uid } = req.params;
    const actor = req.authUser;
    try {
        if (actor.role === 'senior' && actor.uid !== uid) {
            return res.status(403).json({ success: false, message: 'You may only view your own health records.' });
        }
        const actorRole = actor.role;
        if (actorRole !== 'admin' && actorRole !== 'employee' && actorRole !== 'senior') {
            return res.status(403).json({ success: false, message: 'Insufficient permissions.' });
        }

        const userSnap = await admin.database().ref(`users/${uid}`).once('value');
        if (!userSnap.exists()) return res.status(404).json({ success: false, message: 'Senior citizen record not found.' });
        const user = userSnap.val();

        const hasConsent = !!(user.healthConsent && user.healthConsent.granted);
        if (!hasConsent) {
            await writeAuditLog('HEALTH_ACCESS_DENIED_NO_CONSENT', actor, uid, null,
                `Attempted access to health records — consent not granted`);
            return res.status(403).json({
                success: false,
                message: 'Health records are blocked until the senior citizen has granted consent.',
                requiresConsent: true
            });
        }

        await writeAuditLog('HEALTH_RECORDS_VIEWED', actor, uid, null,
            `Health records viewed by ${actorRole} ${actor.name || actor.email || 'Unknown'}`);

        const recordsSnap = await admin.database().ref(`users/${uid}/healthRecords`).once('value');
        const records = recordsSnap.val() || {};

        const out = {
            success: true,
            consent: user.healthConsent || null,
            records: Object.entries(records).map(([key, r]) => ({ id: key, ...r })),
            affiliatedCenters: (user.affiliatedHealthCenters || []),
            recoveryPlan: (user.recoveryPlan || null)
        };
        res.json(out);
    } catch (error) {
        console.error('Health records error:', error);
        res.status(500).json({ success: false, message: 'Failed to load health records.' });
    }
});


// Basic routing for pages

// ============================================================
// --- API: Add a health record (admin/staff only; consent must exist) ---
app.post('/api/health-records/add', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { uid, type, title, description, provider, recordedAt, attachments } = req.body;
    const actor = req.authUser;
    try {
        if (!uid || !type) return res.status(400).json({ success: false, message: 'uid and type are required.' });
        const validTypes = ['checkup', 'diagnosis', 'medication', 'vaccination', 'lab_result', 'referral', 'treatment', 'vitals', 'other'];
        const typeLower = String(type).toLowerCase();
        if (!validTypes.includes(typeLower)) return res.status(400).json({ success: false, message: 'Invalid health record type. Allowed: ' + validTypes.join(', ') });

        const userSnap = await admin.database().ref(`users/${uid}`).once('value');
        if (!userSnap.exists()) return res.status(404).json({ success: false, message: 'Senior citizen record not found.' });
        const user = userSnap.val();

        const hasConsent = !!(user.healthConsent && user.healthConsent.granted);
        if (!hasConsent) {
            return res.status(403).json({ success: false, message: 'Cannot add health records — senior has not granted consent.' });
        }

        const recordRef = admin.database().ref(`users/${uid}/healthRecords`).push();
        const record = {
            id: recordRef.key,
            type: typeLower,
            title: String(title || '').slice(0, 120) || type,
            description: String(description || '').slice(0, 2000) || null,
            provider: String(provider || '').slice(0, 120) || null,
            recordedAt: recordedAt ? Number(recordedAt) : Date.now(),
            attachments: Array.isArray(attachments) ? attachments.slice(0, 10) : [],
            recordedBy: actor.uid,
            recordedByName: actor.name || actor.email || 'OSCA Staff',
            recordedAt: Date.now()
        };
        await recordRef.set(record);
        await writeAuditLog('HEALTH_RECORD_ADDED', actor, uid, recordRef.key,
            `Added ${type} record: ${record.title}`);

        res.json({ success: true, message: 'Health record added.', recordId: recordRef.key });
    } catch (error) {
        console.error('Add health record error:', error);
        res.status(500).json({ success: false, message: 'Failed to add health record.' });
    }
});

// --- API: Update a health record (admin/staff only; audit-logged) ---
app.put('/api/health-records/:uid/:recordId', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { uid, recordId } = req.params;
    const { title, description, provider, recordedAt, status } = req.body;
    const actor = req.authUser;
    try {
        const recordRef = admin.database().ref(`users/${uid}/healthRecords/${recordId}`);
        const snap = await recordRef.once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Health record not found.' });

        const updates = {};
        if (title !== undefined) updates.title = String(title).slice(0, 120);
        if (description !== undefined) updates.description = String(description).slice(0, 2000);
        if (provider !== undefined) updates.provider = String(provider).slice(0, 120);
        if (recordedAt !== undefined) updates.recordUpdatedAt = Number(recordedAt);
        if (status !== undefined) updates.status = String(status).slice(0, 40);

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ success: false, message: 'No fields to update.' });
        }
        updates.editedBy = actor.uid;
        updates.editedByName = actor.name || actor.email || 'OSCA Staff';
        updates.editedAt = Date.now();

        await recordRef.update(updates);
        await writeAuditLog('HEALTH_RECORD_EDITED', actor, uid, recordId,
            `Edited health record: ${updates.title || '(title unchanged)'}`);

        res.json({ success: true, message: 'Health record updated.' });
    } catch (error) {
        console.error('Edit health record error:', error);
        res.status(500).json({ success: false, message: 'Failed to update health record.' });
    }
});

// --- API: Grant / withdraw health consent (senior only, on own account) ---
app.post('/api/health-consent', requireAuth, requireRole('senior'), async (req, res) => {
    const { grant, message } = req.body;
    const actor = req.authUser;
    try {
        const grantBool = grant === true || grant === 'true' || grant === 1;
        const updates = {
            'healthConsent.granted': grantBool,
            'healthConsent.seniorUid': actor.uid,
            'healthConsent.grantedAt': Date.now(),
            'healthConsent.message': String(message || DEFAULT_HEALTH_CONSENT_MESSAGE).slice(0, 2000),
            'healthConsent.withdrawnAt': grantBool ? null : Date.now()
        };
        await admin.database().ref(`users/${actor.uid}`).update(updates);
        const action = grantBool ? 'HEALTH_CONSENT_GRANTED' : 'HEALTH_CONSENT_WITHDRAWN';
        await writeAuditLog(action, actor, actor.uid, null,
            grantBool ? 'Senior granted consent to share health records' : 'Senior withdrew consent for health records');

        res.json({ success: true, message: grantBool ? 'Health consent granted.' : 'Health consent withdrawn.' });
    } catch (error) {
        console.error('Health consent error:', error);
        res.status(500).json({ success: false, message: 'Failed to update health consent.' });
    }
});

// --- API: Get health consent status (any authenticated user; own or staff for any) ---
app.get('/api/health-consent/:uid', requireAuth, async (req, res) => {
    const { uid } = req.params;
    const actor = req.authUser;
    try {
        if (actor.role === 'senior' && actor.uid !== uid) {
            return res.status(403).json({ success: false, message: 'You may only check your own consent status.' });
        }
        const snap = await admin.database().ref(`users/${uid}/healthConsent`).once('value');
        if (!snap.exists()) return res.json({ success: true, granted: false });
        res.json({ success: true, granted: snap.val().granted, ...snap.val() });
    } catch (error) {
        console.error('Health consent status error:', error);
        res.status(500).json({ success: false, message: 'Failed to load consent status.' });
    }
});

// --- Seed default health consent disclaimer (no-op if already present) ---
async function seedHealthConsentDefaults() {
    try {
        const snap = await admin.database().ref('system/healthConsentDefaults').once('value');
        if (snap.exists()) return;
        await admin.database().ref('system/healthConsentDefaults').set({
            message: DEFAULT_HEALTH_CONSENT_MESSAGE,
            version: 1,
            policy: 'Data Privacy Act of 2012 (RA 10173)',
            createdAt: Date.now()
        });
    } catch (e) { /* non-fatal */ }
}
seedHealthConsentDefaults();


// --- API: Delete a health record (admin/staff only; soft-audit-logged) ---
app.delete('/api/health-records/:uid/:recordId', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { uid, recordId } = req.params;
    const actor = req.authUser;
    try {
        const recordRef = admin.database().ref(`users/${uid}/healthRecords/${recordId}`);
        const snap = await recordRef.once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Health record not found.' });
        const record = snap.val();

        await writeAuditLog('HEALTH_RECORD_DELETED', actor, uid, recordId,
            `Deleted health record "${record.title || 'Untitled'}" (type: ${record.type})`);
        await recordRef.remove();

        res.json({ success: true, message: 'Health record removed.' });
    } catch (error) {
        console.error('Delete health record error:', error);
        res.status(500).json({ success: false, message: 'Failed to remove health record.' });
    }
});

// --- API: Get priority score for a senior (decision SUPPORT only)
// Frontend uses the SAME rules as this endpoint for live preview.
// This endpoint is the server-side source of truth for priority.
// NEVER auto-approves or auto-rejects; only computes + explains.
app.get('/api/priority/:uid', requireAuth, async (req, res) => {
    const { uid } = req.params;
    const actor = req.authUser;
    try {
        if (actor.role !== 'admin' && actor.role !== 'employee') {
            return res.status(403).json({ success: false, message: 'Admin or staff only.' });
        }
        const userSnap = await admin.database().ref(`users/${uid}`).once('value');
        if (!userSnap.exists()) return res.status(404).json({ success: false, message: 'Senior not found.' });
        const user = userSnap.val();
        const priority = priorityEngine.computePriority(user);
        await writeAuditLog('PRIORITY_SCORE_VIEWED', actor, uid, null,
            `Priority score ${priority.level} (${priority.score}/${priority.weight}) viewed by ${actor.role}`);
        res.json({ success: true, ...priority });
    } catch (error) {
        console.error('Priority score error:', error);
        res.status(500).json({ success: false, message: 'Failed to compute priority score.' });
    }
});

// Senior Citizen ID Document Vault (Supabase Storage)
// Firebase RTDB = source of truth (metadata + status).
// Supabase = private file storage ONLY, two status folders:
//   pending/{seniorUid}/...  -> awaiting OSCA verification
//   verified/{seniorUid}/... -> approved by OSCA staff
// Every access is permission-checked and written to auditLogs.
// ============================================================

async function writeAuditLog(action, actor, targetUid, docId, detail) {
    try {
        await admin.database().ref('auditLogs').push({
            action: action,
            actorUid: actor.uid,
            actorRole: actor.role,
            actorName: actor.name || actor.email || 'Unknown',
            targetUid: targetUid || null,
            docId: docId || null,
            detail: detail || null,
            timestamp: Date.now()
        });
    } catch (e) {
        console.error('Audit log write failed:', e.message);
    }
}

function vaultDisabled(res) {
    return res.status(503).json({ success: false, message: 'ID document vault is not configured. Ask the administrator to set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });
}

// --- Upload a Senior ID document (senior uploads own; staff may upload on behalf) ---
app.post('/api/senior-id/upload', requireAuth, async (req, res) => {
    if (!idVault.isVaultEnabled()) return vaultDisabled(res);
    try {
        const { targetUid, fileName, mimeType, fileBase64 } = req.body;
        const actor = req.authUser;

        // Determine the owning senior. Seniors may only upload for themselves.
        let ownerUid;
        if (actor.role === 'senior') {
            if (targetUid && targetUid !== actor.uid) {
                return res.status(403).json({ success: false, message: 'You can only upload documents for your own account.' });
            }
            ownerUid = actor.uid;
        } else if (actor.role === 'admin' || actor.role === 'employee') {
            if (!targetUid) return res.status(400).json({ success: false, message: 'targetUid of the senior citizen is required.' });
            ownerUid = targetUid;
        } else {
            return res.status(403).json({ success: false, message: 'Insufficient permissions.' });
        }

        if (!fileName || !mimeType || !fileBase64) {
            return res.status(400).json({ success: false, message: 'fileName, mimeType, and fileBase64 are required.' });
        }

        // The owner must be an existing senior record.
        const ownerSnap = await admin.database().ref(`users/${ownerUid}`).once('value');
        if (!ownerSnap.exists() || ownerSnap.val().role !== 'senior') {
            return res.status(404).json({ success: false, message: 'Senior citizen account not found.' });
        }

        const decoded = idVault.decodeDocumentPayload(mimeType, fileBase64);
        if (decoded.error) return res.status(400).json({ success: false, message: decoded.error });

        const docId = admin.database().ref(`users/${ownerUid}/idDocuments`).push().key;
        const storagePath = idVault.buildStoragePath('pending', ownerUid, docId, fileName);

        // 1) Store the physical file first (Supabase, private bucket, pending folder)
        await idVault.uploadDocument(storagePath, decoded.buffer, mimeType);

        // 2) Mirror the metadata into Firebase (source of truth)
        await admin.database().ref(`users/${ownerUid}/idDocuments/${docId}`).set({
            docId: docId,
            storagePath: storagePath,
            folder: 'pending',
            originalName: String(fileName).slice(0, 120),
            mimeType: mimeType,
            size: decoded.buffer.length,
            status: 'Pending',
            uploadedBy: actor.uid,
            uploadedByName: actor.name || actor.email || 'Unknown',
            uploadedAt: Date.now()
        });

        await writeAuditLog('UPLOAD_ID_DOCUMENT', actor, ownerUid, docId, `File "${fileName}" uploaded to pending/`);

        res.json({ success: true, message: 'ID document uploaded and is now pending verification.', docId: docId });
    } catch (error) {
        console.error('Senior ID upload error:', error);
        res.status(500).json({ success: false, message: 'Failed to upload the ID document: ' + error.message });
    }
});

// --- Review a Senior ID document (approve = move pending/ -> verified/, reject = delete file) ---
app.post('/api/senior-id/review', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    if (!idVault.isVaultEnabled()) return vaultDisabled(res);
    try {
        const { targetUid, docId, decision, notes } = req.body;
        const actor = req.authUser;

        if (!targetUid || !docId || !['Verified', 'Rejected'].includes(decision)) {
            return res.status(400).json({ success: false, message: 'targetUid, docId, and decision (Verified | Rejected) are required.' });
        }

        const docRef = admin.database().ref(`users/${targetUid}/idDocuments/${docId}`);
        const docSnap = await docRef.once('value');
        if (!docSnap.exists()) {
            return res.status(404).json({ success: false, message: 'ID document not found.' });
        }
        const doc = docSnap.val();
        if (doc.status !== 'Pending') {
            return res.status(409).json({ success: false, message: `This document was already reviewed (${doc.status}).` });
        }

        if (decision === 'Verified') {
            // Move the physical file to the verified folder BEFORE touching Firebase.
            const verifiedPath = idVault.buildStoragePath('verified', targetUid, docId, doc.originalName);
            await idVault.moveDocument(doc.storagePath, verifiedPath);
            await docRef.update({
                status: 'Verified',
                folder: 'verified',
                storagePath: verifiedPath,
                reviewedBy: actor.uid,
                reviewedByName: actor.name || actor.email || 'Unknown',
                reviewedAt: Date.now(),
                reviewNotes: notes || null
            });
        } else {
            // Rejected: remove the sensitive file entirely, keep only the audit trail.
            await idVault.deleteDocument(doc.storagePath);
            await docRef.update({
                status: 'Rejected',
                folder: null,
                storagePath: null,
                reviewedBy: actor.uid,
                reviewedByName: actor.name || actor.email || 'Unknown',
                reviewedAt: Date.now(),
                reviewNotes: notes || null
            });
        }

        await writeAuditLog('REVIEW_ID_DOCUMENT', actor, targetUid, docId, `Decision: ${decision}${notes ? ' — ' + notes : ''}`);

        res.json({ success: true, message: `Document ${decision.toLowerCase()} successfully.` });
    } catch (error) {
        console.error('Senior ID review error:', error);
        res.status(500).json({ success: false, message: 'Failed to review the ID document: ' + error.message });
    }
});

// --- View a Senior ID document (owner or staff) via short-lived signed URL ---
app.get('/api/senior-id/view/:uid/:docId', requireAuth, async (req, res) => {
    if (!idVault.isVaultEnabled()) return vaultDisabled(res);
    try {
        const { uid, docId } = req.params;
        const actor = req.authUser;

        const isOwner = actor.uid === uid;
        const isStaff = actor.role === 'admin' || actor.role === 'employee';
        if (!isOwner && !isStaff) {
            return res.status(403).json({ success: false, message: 'You are not allowed to view this document.' });
        }

        const docSnap = await admin.database().ref(`users/${uid}/idDocuments/${docId}`).once('value');
        if (!docSnap.exists() || !docSnap.val().storagePath) {
            return res.status(404).json({ success: false, message: 'ID document not found or no longer stored.' });
        }
        const doc = docSnap.val();

        const signedUrl = await idVault.createViewLink(doc.storagePath);

        // Privacy compliance: record WHO viewed WHICH senior's ID and WHEN.
        await writeAuditLog('VIEW_ID_DOCUMENT', actor, uid, docId, `Viewed "${doc.originalName}" (${doc.status})`);

        res.json({
            success: true,
            signedUrl: signedUrl,
            expiresIn: idVault.SIGNED_URL_TTL_SECONDS,
            document: {
                docId: doc.docId,
                originalName: doc.originalName,
                mimeType: doc.mimeType,
                status: doc.status,
                uploadedAt: doc.uploadedAt,
                verifiedAt: doc.reviewedAt || null
            }
        });
    } catch (error) {
        console.error('Senior ID view error:', error);
        res.status(500).json({ success: false, message: 'Failed to open the ID document: ' + error.message });
    }
});

// ============================================================
// QR-Based Digital ID Verification, Benefits Eligibility
// Engine, Duplicate-Claim Prevention & Budget Management.
//
// Design notes (security first):
//  - Every senior gets a server-generated verification token.
//    The QR code encodes  SC1|<uid>|<token>  and is useless
//    without staff verification against the server.
//  - Claim recording is ONLY possible via this trusted backend:
//    eligibility is evaluated server-side, duplicate claims of
//    the same benefit within the same month are rejected, and
//    every release is checked against the remaining budget.
//  - The system assists staff; it never releases benefits
//    automatically — each claim is recorded by an authenticated
//    staff member and written to the audit trail.
// ============================================================
const crypto = require('crypto');

const BENEFIT_TYPES = [
    'Monthly Social Pension',
    'Death Benefit Assistance',
    'Medical Assistance',
    'Burial Assistance',
    'Financial Assistance',
    'Food / Relief Goods'
];

function currentClaimPeriod() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function generateVerificationToken() {
    return crypto.randomBytes(12).toString('hex'); // 24 hex chars
}

// --- Benefits Eligibility Engine (server-side, single source of truth) ---
function evaluateEligibility(user) {
    const idDocs = user.idDocuments ? Object.values(user.idDocuments) : [];
    const hasPendingDocs = idDocs.some(d => d.status === 'Pending');

    const checks = [
        {
            id: 'lifeStatus',
            label: 'Life status is Active',
            passed: (user.lifeStatus || 'Active') === 'Active',
            detail: user.lifeStatus || 'Active'
        },
        {
            id: 'accountStatus',
            label: 'Account status is Active',
            passed: user.status === 'Active',
            detail: user.status || 'Unknown'
        },
        {
            id: 'kyc',
            label: 'Identity verified (KYC)',
            passed: user.kycStatus === 'Verified' || !!user.kycVerifiedAt,
            detail: user.kycStatus || (user.kycVerifiedAt ? 'Verified' : 'Not verified')
        },
        {
            id: 'seniorId',
            label: 'Valid Senior Citizen ID on record',
            passed: !!String(user.seniorId || '').trim(),
            detail: user.seniorId || 'Missing'
        },
        {
            id: 'documents',
            label: 'No pending ID document requirements',
            passed: !hasPendingDocs,
            detail: hasPendingDocs ? 'Pending document(s) under review' : 'Complete'
        }
    ];

    return { eligible: checks.every(c => c.passed), checks };
}

// --- API: Get or create the senior's own QR verification token ---
app.get('/api/senior/verification-token', requireAuth, requireRole('senior'), async (req, res) => {
    try {
        const actor = req.authUser;
        if (actor.verificationToken) {
            return res.json({ success: true, token: actor.verificationToken });
        }
        const token = generateVerificationToken();
        await admin.database().ref(`users/${actor.uid}/verificationToken`).set(token);
        res.json({ success: true, token: token });
    } catch (error) {
        console.error('Verification token error:', error);
        res.status(500).json({ success: false, message: 'Failed to prepare your QR digital ID.' });
    }
});

// --- API: Staff scans/enters a QR digital ID → identity + eligibility + claim history ---
app.post('/api/verify-qr', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    try {
        const raw = String(req.body.code || '').trim();
        let uid = null, token = null;

        // Accept the exact QR payload SC1|uid|token, or a manual Senior ID lookup.
        if (/^SC1\|/.test(raw)) {
            const parts = raw.split('|');
            if (parts.length !== 3) return res.status(400).json({ success: false, message: 'Malformed QR code payload.' });
            uid = parts[1];
            token = parts[2];
        } else if (raw) {
            const snap = await admin.database().ref('users').orderByChild('role').equalTo('senior').once('value');
            const users = snap.val() || {};
            const target = Object.entries(users).find(([, u]) =>
                String(u.seniorId || '').trim().toUpperCase() === raw.toUpperCase());
            if (!target) return res.status(404).json({ success: false, message: `No senior citizen found with Senior ID "${raw}".` });
            uid = target[0];
        } else {
            return res.status(400).json({ success: false, message: 'Scan a QR code or enter a Senior ID.' });
        }

        const userSnap = await admin.database().ref(`users/${uid}`).once('value');
        if (!userSnap.exists()) return res.status(404).json({ success: false, message: 'Senior citizen record not found.' });
        const user = userSnap.val();

        // Token integrity: a scanned QR must carry the exact server-issued token.
        if (token && user.verificationToken && user.verificationToken !== token) {
            await writeAuditLog('QR_VERIFY_FAILED', req.authUser, uid, null, 'Presented QR token did not match the issued token');
            return res.status(403).json({ success: false, message: 'Invalid QR code — token mismatch. Possible forged or outdated ID.' });
        }

        const eligibility = evaluateEligibility(user);

        // Claim history for the current period (duplicate-claim awareness).
        const period = currentClaimPeriod();
        const claimsSnap = await admin.database().ref('claims').orderByChild('uid').equalTo(uid).once('value');
        const allClaims = claimsSnap.val() || {};
        const periodClaims = Object.values(allClaims).filter(c => c.period === period);
        const recentClaims = Object.values(allClaims)
            .sort((a, b) => (b.releasedAt || 0) - (a.releasedAt || 0)).slice(0, 5)
            .map(c => ({ benefitType: c.benefitType, amount: c.amount, period: c.period, releasedAt: c.releasedAt, releasedByName: c.releasedByName }));

        await writeAuditLog('QR_VERIFY_SUCCESS', req.authUser, uid, null,
            `Verified identity via QR${token ? '' : '/Senior ID'} — eligibility: ${eligibility.eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE'}`);

        res.json({
            success: true,
            senior: {
                uid: uid,
                name: user.name,
                seniorId: user.seniorId || '',
                barangay: user.barangay || '',
                age: computeAgeFromDob(user.dob),
                lifeStatus: user.lifeStatus || 'Active',
                accountStatus: user.status || 'Unknown',
                kycStatus: user.kycStatus || (user.kycVerifiedAt ? 'Verified' : 'Not verified'),
                healthCondition: user.healthCondition || user.condition || user.preExistingConditions || 'None reported'
            },
            eligibility: eligibility,
            period: period,
            claimedThisPeriod: periodClaims.map(c => c.benefitType),
            recentClaims: recentClaims
        });
    } catch (error) {
        console.error('Verify QR error:', error);
        res.status(500).json({ success: false, message: 'Verification failed: ' + error.message });
    }
});

// --- API: Staff records a benefit release/claim (decision-support workflow) ---
app.post('/api/claims/record', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    try {
        const { uid, benefitType, amount, notes } = req.body;
        const actor = req.authUser;

        if (!uid || !benefitType) return res.status(400).json({ success: false, message: 'Senior and benefit type are required.' });
        if (!BENEFIT_TYPES.includes(benefitType)) return res.status(400).json({ success: false, message: 'Unknown benefit type.' });

        const amountNum = Number(amount);
        if (!Number.isFinite(amountNum) || amountNum < 0) return res.status(400).json({ success: false, message: 'Invalid amount.' });

        const userSnap = await admin.database().ref(`users/${uid}`).once('value');
        if (!userSnap.exists()) return res.status(404).json({ success: false, message: 'Senior citizen record not found.' });
        const user = userSnap.val();

        // 1) Eligibility gate — the system only ASSISTS; ineligible seniors are blocked here
        //    and the final release is always performed by the staff member.
        const eligibility = evaluateEligibility(user);
        if (!eligibility.eligible) {
            const failed = eligibility.checks.filter(c => !c.passed).map(c => c.label).join('; ');
            return res.status(409).json({ success: false, message: `Senior is NOT eligible: ${failed}.`, eligibility });
        }

        // 2) Duplicate-claim prevention — one release per benefit type per period.
        const period = currentClaimPeriod();
        const claimsSnap = await admin.database().ref('claims').orderByChild('uid').equalTo(uid).once('value');
        const allClaims = claimsSnap.val() || {};
        const alreadyClaimed = Object.values(allClaims).some(c =>
            c.period === period && c.benefitType === benefitType && c.status !== 'Void');
        if (alreadyClaimed) {
            return res.status(409).json({
                success: false,
                duplicateClaim: true,
                message: `DUPLICATE CLAIM BLOCKED: "${benefitType}" was already released to ${user.name} for ${period}. A senior citizen is only entitled to each benefit once per release period.`
            });
        }

        // 3) Budget gate — releases cannot exceed the allocated budget.
        const budgetSnap = await admin.database().ref('system/budget').once('value');
        const budget = budgetSnap.val() || { totalAllocated: 0 };
        const releasedTotal = Object.values(allClaims).reduce((s, c) => s + (Number(c.amount) || 0), 0);
        const remaining = (Number(budget.totalAllocated) || 0) - releasedTotal;
        if (remaining < amountNum) {
            return res.status(409).json({
                success: false,
                budgetExceeded: true,
                message: `INSUFFICIENT BUDGET: remaining allocation is ₱${remaining.toLocaleString()} but the release needs ₱${amountNum.toLocaleString()}. Ask the administrator to adjust the budget.`
            });
        }

        // 4) Record the claim — human-authorized release with full accountability.
        const claimRef = admin.database().ref('claims').push();
        const claim = {
            uid: uid,
            seniorId: user.seniorId || '',
            name: user.name || 'Unknown',
            barangay: user.barangay || 'Unassigned',
            benefitType: benefitType,
            amount: amountNum,
            notes: String(notes || '').slice(0, 300) || null,
            period: period,
            status: 'Released',
            releasedBy: actor.uid,
            releasedByName: actor.name || actor.email || 'OSCA Staff',
            releasedByRole: actor.role,
            releasedAt: Date.now()
        };
        await claimRef.set(claim);

        await writeAuditLog('RECORD_BENEFIT_CLAIM', actor, uid, claimRef.key,
            `Released "${benefitType}" (₱${amountNum.toLocaleString()}) for period ${period}${notes ? ' — ' + notes : ''}`);

        // Notify the senior citizen
        const notifKey = 'notif_' + Date.now();
        await admin.database().ref(`users/${uid}/notifications/${notifKey}`).set({
            title: `${benefitType} Released ✓`,
            description: `Your ${benefitType} of ₱${amountNum.toLocaleString()} has been officially released by ${claim.releasedByName}. Present your QR Digital ID when claiming. Ref: ${claimRef.key.slice(-8).toUpperCase()}`,
            createdAt: Date.now(),
            type: 'benefit'
        });

        res.json({
            success: true,
            message: `${benefitType} of ₱${amountNum.toLocaleString()} recorded for ${user.name}.`,
            claimId: claimRef.key,
            budgetRemaining: remaining - amountNum
        });
    } catch (error) {
        console.error('Record claim error:', error);
        res.status(500).json({ success: false, message: 'Failed to record the claim: ' + error.message });
    }
});

// --- API: Budget summary (staff) / set allocation (admin) ---
app.get('/api/budget', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    try {
        const budgetSnap = await admin.database().ref('system/budget').once('value');
        const budget = budgetSnap.val() || { totalAllocated: 0 };
        const claimsSnap = await admin.database().ref('claims').once('value');
        const claims = claimsSnap.val() || {};

        let released = 0;
        const byBarangay = {};
        const byBenefit = {};
        for (const c of Object.values(claims)) {
            const amt = Number(c.amount) || 0;
            released += amt;
            const b = c.barangay || 'Unassigned';
            byBarangay[b] = (byBarangay[b] || 0) + amt;
            byBenefit[c.benefitType || 'Unknown'] = (byBenefit[c.benefitType || 'Unknown'] || 0) + amt;
        }

        res.json({
            success: true,
            totalAllocated: Number(budget.totalAllocated) || 0,
            released: released,
            remaining: (Number(budget.totalAllocated) || 0) - released,
            updatedAt: budget.updatedAt || null,
            updatedByName: budget.updatedByName || null,
            byBarangay: byBarangay,
            byBenefit: byBenefit,
            claimCount: Object.keys(claims).length
        });
    } catch (error) {
        console.error('Budget summary error:', error);
        res.status(500).json({ success: false, message: 'Failed to load budget summary.' });
    }
});

app.post('/api/budget/set', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const { totalAllocated } = req.body;
        const value = Number(totalAllocated);
        if (!Number.isFinite(value) || value < 0) {
            return res.status(400).json({ success: false, message: 'Budget must be a non-negative number.' });
        }
        const actor = req.authUser;
        await admin.database().ref('system/budget').set({
            totalAllocated: value,
            updatedAt: Date.now(),
            updatedBy: actor.uid,
            updatedByName: actor.name || actor.email || 'Administrator'
        });
        await writeAuditLog('SET_BUDGET_ALLOCATION', actor, null, null, `Total benefits budget set to ₱${value.toLocaleString()}`);
        res.json({ success: true, message: `Benefits budget set to ₱${value.toLocaleString()}.` });
    } catch (error) {
        console.error('Budget set error:', error);
        res.status(500).json({ success: false, message: 'Failed to update the budget.' });
    }
});

// --- API: Edit logs / audit trail viewer (admin only) ---
app.get('/api/audit-logs', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
        const snap = await admin.database().ref('auditLogs').limitToLast(limit).once('value');
        const logs = snap.val() || {};
        const list = Object.entries(logs)
            .map(([key, log]) => ({ id: key, ...log }))
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        res.json({ success: true, logs: list });
    } catch (error) {
        console.error('Audit logs error:', error);
        res.status(500).json({ success: false, message: 'Failed to load audit logs.' });
    }
});

// --- Affiliated Health Centers directory (seeded on first run; staff-manageable) ---
const DEFAULT_HEALTH_CENTERS = [
    { name: 'OSCA Magalang Main Office Clinic', type: 'OSCA Clinic', barangay: 'Poblacion', contact: '', hours: 'Mon-Fri 8:00 AM - 5:00 PM' },
    { name: 'Magalang Rural Health Unit', type: 'Rural Health Unit', barangay: 'Poblacion', contact: '', hours: 'Mon-Fri 8:00 AM - 5:00 PM' },
    { name: 'Balucuc Barangay Health Center', type: 'Barangay Health Center', barangay: 'Balucuc', contact: '', hours: 'Mon-Fri 8:00 AM - 4:00 PM' },
    { name: 'Camias Barangay Health Center', type: 'Barangay Health Center', barangay: 'Camias', contact: '', hours: 'Mon-Fri 8:00 AM - 4:00 PM' },
    { name: 'San Francisco Barangay Health Center', type: 'Barangay Health Center', barangay: 'San Francisco', contact: '', hours: 'Mon-Fri 8:00 AM - 4:00 PM' },
    { name: 'San Nicolas Barangay Health Center', type: 'Barangay Health Center', barangay: 'San Nicolas', contact: '', hours: 'Mon-Fri 8:00 AM - 4:00 PM' },
    { name: 'San Vicente Barangay Health Center', type: 'Barangay Health Center', barangay: 'San Vicente', contact: '', hours: 'Mon-Fri 8:00 AM - 4:00 PM' },
    { name: 'Santo Domingo Barangay Health Center', type: 'Barangay Health Center', barangay: 'Santo Domingo', contact: '', hours: 'Mon-Fri 8:00 AM - 4:00 PM' },
    { name: 'Santo Niño Barangay Health Center', type: 'Barangay Health Center', barangay: 'Santo Niño', contact: '', hours: 'Mon-Fri 8:00 AM - 4:00 PM' }
];

async function seedHealthCenters() {
    try {
        const snap = await admin.database().ref('healthCenters').once('value');
        if (snap.exists()) return;
        await admin.database().ref('healthCenters').set(DEFAULT_HEALTH_CENTERS);
        console.log('Seeded default affiliated health centers directory.');
    } catch (e) {
        console.warn('Could not seed health centers:', e.message);
    }
}
seedHealthCenters();

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




app.listen(PORT, () => {
    console.log(`SilverCare Server running on http://localhost:${PORT}`);
});

