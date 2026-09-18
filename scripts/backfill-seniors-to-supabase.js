#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/backfill-seniors-to-supabase.js
//
// ONE-TIME migration: mirrors EVERY senior citizen already stored in
// Firebase RTDB into the Supabase data store (public.seniors table +
// private "seniors" bucket with one folder per senior ID), so existing
// records don't have to wait
// for a KYC re-submission to appear in Supabase.
//
// Firebase RTDB remains the source of truth — this only mirrors.
//
// Prerequisites:
//   1. SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY filled in .env
//   2. scripts/supabase-setup.sql executed once in the Supabase SQL Editor
//
// Usage:
//   node scripts/backfill-seniors-to-supabase.js              # run for real
//   node scripts/backfill-seniors-to-supabase.js --dry-run    # preview only
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const path = require('path');
const admin = require('firebase-admin');
const fs = require('fs');
const seniorStore = require('../lib/supabaseDatabase');

const DRY_RUN = process.argv.includes('--dry-run');

// Load service account - use path relative to project root
const rootDir = path.join(__dirname, '..');
let serviceAccount;
if (fs.existsSync(path.join(rootDir, 'serviceAccountKey.json'))) {
    serviceAccount = require(path.join(rootDir, 'serviceAccountKey.json'));
} else if (process.env.SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
} else {
    console.error('No service account credentials found (serviceAccountKey.json).');
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
});

async function backfillSeniors() {
    console.log(`── SilverCare → Supabase senior backfill ${DRY_RUN ? '(DRY RUN)' : ''} ──`);

    if (!seniorStore.isSyncEnabled()) {
        console.error('✗  Supabase is not configured. Fill SUPABASE_URL and');
        console.error('   SUPABASE_SERVICE_ROLE_KEY in .env, then run scripts/check-supabase.js.');
        process.exit(1);
    }

    const usersSnap = await admin.database().ref('users').orderByChild('role').equalTo('senior').once('value');
    if (!usersSnap.exists()) {
        console.log('No senior citizens found in Firebase. Nothing to backfill.');
        return { synced: 0, failed: 0 };
    }

    let synced = 0, failed = 0, index = 0;
    const total = usersSnap.numChildren();
    const failures = [];

    for (const [uid, user] of Object.entries(usersSnap.val() || {})) {
        index++;
        const label = `${user.name || user.email || uid} (ID: ${user.seniorId || 'n/a'})`;

        if (DRY_RUN) {
            console.log(`→ [${index}/${total}] Would mirror: ${label}`);
            synced++;
            continue;
        }

        try {
            const face = user.kycFaceImage || user.faceImage || null;
            const result = await seniorStore.syncSeniorRecord(uid, user, face);
            synced++;
            console.log(`✓ [${index}/${total}] Mirrored: ${label} → face: ${result.facePath || 'none'}`);
        } catch (err) {
            failed++;
            failures.push({ uid, label, reason: err.message });
            console.error(`✗ [${index}/${total}] FAILED: ${label} → ${err.message}`);
        }
    }

    console.log('─────────────────────────────────────────────');
    console.log(`✅ Done. Mirrored: ${synced}  |  Failed: ${failed}`);
    if (failures.length) {
        console.log('\nFailed records (re-run this script to retry):');
        failures.forEach(f => console.log(`  • ${f.uid} — ${f.label} → ${f.reason}`));
    }
    return { synced, failed };
}

backfillSeniors()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('\n❌ Backfill failed:', err.message);
        process.exit(1);
    });
