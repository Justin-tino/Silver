/**
 * lib/supabaseStorage.js
 * ---------------------------------------------------------------
 * Senior Citizen ID Document Vault (Supabase Storage).
 *
 * Firebase Realtime Database remains the single source of truth for
 * ALL records. Supabase Storage is used ONLY to hold the physical
 * ID document files of senior citizens inside a PRIVATE bucket:
 *
 *     senior-ids/
 *        pending/{seniorUid}/{docId}_{filename}   -> awaiting OSCA review
 *        verified/{seniorUid}/{docId}_{filename}  -> approved by OSCA staff
 *
 * Verification = the object is MOVED from pending/ to verified/
 * (or deleted when rejected). File access is only ever granted via
 * short-lived signed URLs created here on the trusted backend.
 * The service-role key NEVER reaches the browser.
 */

const { createClient } = require('@supabase/supabase-js');

const BUCKET_NAME = 'senior-ids';
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_FILE_BYTES = 7 * 1024 * 1024; // 7 MB raw (~9.4 MB as base64, fits the 10mb JSON limit)
const SIGNED_URL_TTL_SECONDS = 300;     // 5-minute viewing links

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
    console.warn('Supabase credentials missing or placeholders not filled (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env). Senior ID document vault is DISABLED.');
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
        console.error('Supabase bucket initialization failed:', err.message);
    }
    return bucketReady;
}

function isVaultEnabled() {
    return supabase !== null;
}

/** Validates mime type + decodes base64 payload into an uploadable Buffer. */
function decodeDocumentPayload(mimeType, fileBase64) {
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
        return { error: `Unsupported file type "${mimeType}". Allowed: ${ALLOWED_MIME_TYPES.join(', ')}.` };
    }
    const buffer = Buffer.from(fileBase64, 'base64');
    if (!buffer || buffer.length === 0) return { error: 'Empty file payload.' };
    if (buffer.length > MAX_FILE_BYTES) return { error: 'File exceeds the 7 MB limit.' };
    return { buffer };
}

/** Strips path characters from user-supplied file names. */
function sanitizeFileName(name) {
    return String(name || 'document')
        .replace(/[^a-zA-Z0-9._ -]/g, '')
        .replace(/\s+/g, '_')
        .slice(-80) || 'document';
}

/** Storage path for a document given its current review status folder. */
function buildStoragePath(folder, seniorUid, docId, originalName) {
    return `${folder}/${seniorUid}/${docId}_${sanitizeFileName(originalName)}`;
}

async function uploadDocument(storagePath, buffer, mimeType) {
    if (!(await ensureBucket())) throw new Error('Supabase vault unavailable.');
    const { error } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(storagePath, buffer, { contentType: mimeType, upsert: false });
    if (error) throw new Error(error.message);
    return storagePath;
}

/** Moves a document between status folders (pending -> verified). */
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
