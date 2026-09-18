/**
 * lib/medicalVault.js
 * ---------------------------------------------------------------
 * Medical Certification Vault (Supabase Storage).
 *
 * Firebase Realtime Database remains the single source of truth for
 * ALL records. Supabase Storage is used ONLY to hold the physical
 * medical certification files (doctor's certificate, medical
 * abstract, laboratory result, prescription, etc.) that a VERIFIED
 * senior citizen uploads when updating their health:
 *
 *     medical-certifications/
 *        pending/{seniorUid}/{reportId}_{filename}   -> awaiting OSCA review
 *        reviewed/{seniorUid}/{reportId}_{filename}  -> accepted by OSCA staff
 *
 * Review = the object is MOVED from pending/ to reviewed/
 * (or deleted when the certification is rejected).
 * File access is only ever granted via short-lived signed URLs created
 * here on the trusted backend, and every access is written to the
 * Firebase audit log. The service-role key NEVER reaches the browser.
 *
 * The MIME/size validation is shared with the Senior ID vault
 * (lib/supabaseStorage.js) so both vaults enforce identical rules.
 * ---------------------------------------------------------------
 */

const { createClient } = require('@supabase/supabase-js');
const { decodeDocumentPayload: validateDocumentPayload } = require('./supabaseStorage');

const BUCKET_NAME = 'medical-certifications';
const SIGNED_URL_TTL_SECONDS = 300; // 5-minute viewing links

let supabase = null;
let bucketReady = false;

const rawUrl = (process.env.SUPABASE_URL || '').trim();
const rawKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const urlLooksValid = /^https?:\/\/.+/i.test(rawUrl) && !/YOUR_SUPABASE/i.test(rawUrl);

if (urlLooksValid && rawKey && !/YOUR_SUPABASE/i.test(rawKey)) {
    try {
        supabase = createClient(rawUrl, rawKey, { auth: { persistSession: false } });
    } catch (err) {
        console.warn('Supabase client could not be created:', err.message);
        supabase = null;
    }
}

if (!supabase) {
    console.warn('Supabase credentials missing or placeholders not filled (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env). Medical certification vault is DISABLED.');
}

/** Creates the private bucket on first use (no-op if it already exists). */
async function ensureBucket() {
    if (!supabase || bucketReady) return bucketReady;
    try {
        const { data, error } = await supabase.storage.getBucket(BUCKET_NAME);
        if (error) {
            const { error: createError } = await supabase.storage.createBucket(BUCKET_NAME, { public: false });
            if (createError) throw createError;
            console.log(`Supabase storage bucket "${BUCKET_NAME}" created (private).`);
        } else if (data && data.public === true) {
            console.warn(`Supabase bucket "${BUCKET_NAME}" is PUBLIC — set it to private in the Supabase dashboard!`);
        }
        bucketReady = true;
    } catch (err) {
        console.error('Supabase "medical-certifications" bucket initialization failed:', err.message);
    }
    return bucketReady;
}

function isVaultEnabled() {
    return supabase !== null;
}

/** Validates mime type + decodes base64 payload into an uploadable Buffer. */
function decodeDocumentPayload(mimeType, fileBase64) {
    return validateDocumentPayload(mimeType, fileBase64);
}

/** Strips path characters from user-supplied file names. */
function sanitizeFileName(name) {
    return String(name || 'certification')
        .replace(/[^a-zA-Z0-9._ -]/g, '')
        .replace(/\s+/g, '_')
        .slice(-80) || 'certification';
}

/** Storage path for a certification given its current review status folder. */
function buildStoragePath(folder, seniorUid, reportId, originalName) {
    return `${folder}/${seniorUid}/${reportId}_${sanitizeFileName(originalName)}`;
}

async function uploadDocument(storagePath, buffer, mimeType) {
    if (!(await ensureBucket())) throw new Error('Supabase medical certification vault unavailable.');
    const { error } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(storagePath, buffer, { contentType: mimeType, upsert: false });
    if (error) throw new Error(error.message);
    return storagePath;
}

/** Moves a certification between status folders (pending -> reviewed). */
async function moveDocument(fromPath, toPath) {
    const { error } = await supabase.storage.from(BUCKET_NAME).move(fromPath, toPath);
    if (error) throw new Error(error.message);
    return toPath;
}

async function deleteDocument(storagePath) {
    const { error } = await supabase.storage.from(BUCKET_NAME).remove([storagePath]);
    if (error) throw new Error(error.message);
}

/** Short-lived private view link; nothing is ever publicly accessible. */
async function createViewLink(storagePath) {
    const { data, error } = await supabase.storage
        .from(BUCKET_NAME)
        .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
    if (error) throw new Error(error.message);
    return data.signedUrl;
}

module.exports = {
    isVaultEnabled,
    ensureBucket,
    decodeDocumentPayload,
    buildStoragePath,
    uploadDocument,
    moveDocument,
    deleteDocument,
    createViewLink,
    BUCKET_NAME,
    SIGNED_URL_TTL_SECONDS
};
