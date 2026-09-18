require('dotenv').config();
const path = require('path');
const admin = require('firebase-admin');
const fs = require('fs');

// Load service account - use path relative to project root
const rootDir = path.join(__dirname, '..');
let serviceAccount;
if (fs.existsSync(path.join(rootDir, 'serviceAccountKey.json'))) {
    serviceAccount = require(path.join(rootDir, 'serviceAccountKey.json'));
} else if (process.env.SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
} else {
    console.error('No service account credentials found.');
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
});

// ─────────────────────────────────────────────────────────────────────────────
// Unverify ALL senior accounts.
//
// For every user with role === 'senior':
//   - kycStatus            -> 'Not Verified'  (senior must verify again)
//   - kycVerifiedAt        -> removed
//   - verifiedBy           -> removed
//   - verifiedByUid        -> removed
//   - verifiedByEmail      -> removed
//   - seniorCategory       -> removed (re-assigned by the age-based verification flow)
//   - seniorCategoryAssignedAt -> removed
//
// Submitted data (kycFaceImage, kycSubmittedAt, profile info) is kept.
// ─────────────────────────────────────────────────────────────────────────────

async function unverifyAllSeniors() {
    const db = admin.database();
    const usersSnap = await db.ref('users').once('value');

    if (!usersSnap.exists()) {
        console.log('No users found in the database.');
        return 0;
    }

    const updates = {};
    let seniorsFound = 0;

    usersSnap.forEach(child => {
        const user = child.val();
        if (!user || user.role !== 'senior') return;
        seniorsFound++;

        const uid = child.key;
        updates[`users/${uid}/kycStatus`] = 'Not Verified';
        updates[`users/${uid}/kycVerifiedAt`] = null;
        updates[`users/${uid}/verifiedBy`] = null;
        updates[`users/${uid}/verifiedByUid`] = null;
        updates[`users/${uid}/verifiedByEmail`] = null;
        updates[`users/${uid}/seniorCategory`] = null;
        updates[`users/${uid}/seniorCategoryAssignedAt`] = null;

        console.log(`→ Unverified: ${user.name || user.email || uid} (previous status: ${user.kycStatus || 'N/A'})`);
    });

    if (seniorsFound === 0) {
        console.log('No senior accounts found. Nothing to do.');
        return 0;
    }

    await db.ref().update(updates);
    console.log(`\n✅ ${seniorsFound} senior account(s) unverified successfully.`);
    return seniorsFound;
}

unverifyAllSeniors()
    .then(count => {
        console.log('Done.');
        process.exit(0);
    })
    .catch(err => {
        console.error('\n❌ Failed to unverify senior accounts:', err.message);
        process.exit(1);
    });