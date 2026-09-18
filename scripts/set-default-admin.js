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

const DEFAULT_ADMIN = {
    email: 'admin@silvercare.com',
    password: 'admin123',
    role: 'admin',
    name: 'System Administrator',
    status: 'active',
    createdAt: Date.now(),
    emailVerified: true
};

async function createDefaultAdmin() {
    const db = admin.database();
    const auth = admin.auth();

    try {
        // Check if user already exists
        const emailLower = DEFAULT_ADMIN.email.toLowerCase();
        const usersSnap = await db.ref('users').once('value');
        let existingUid = null;
        usersSnap.forEach(child => {
            const user = child.val();
            if (user.email && user.email.toLowerCase() === emailLower) {
                existingUid = child.key;
            }
        });

        if (existingUid) {
            console.log(`User ${DEFAULT_ADMIN.email} already exists with uid: ${existingUid}`);
            
            // Update Firebase Auth: mark verified and reset password to the
            // default so the documented credentials (admin@silvercare.com /
            // admin123) always work when this script runs.
            await auth.updateUser(existingUid, {
                emailVerified: true,
                password: DEFAULT_ADMIN.password
            });
            console.log('Email verified status updated and password reset to default in Firebase Auth');

            // Update role to admin if not already
            const userRef = db.ref(`users/${existingUid}`);
            const userSnap = await userRef.once('value');
            const userData = userSnap.val();
            if (!userData || userData.role !== 'admin') {
                await userRef.set({
                    uid: existingUid,
                    email: DEFAULT_ADMIN.email,
                    name: DEFAULT_ADMIN.name,
                    role: 'admin',
                    status: 'active',
                    createdAt: userData?.createdAt || Date.now(),
                    emailVerified: true
                });
                console.log(`User data updated - role set to admin`);
            } else {
                console.log(`User is already admin`);
            }
            return existingUid;
        }

        // Create new user
        console.log('Creating new admin user...');
        const userRecord = await auth.createUser({
            email: DEFAULT_ADMIN.email,
            password: DEFAULT_ADMIN.password,
            emailVerified: true,
            displayName: DEFAULT_ADMIN.name
        });

        console.log(`Created user with uid: ${userRecord.uid}`);

        // Save user data to Realtime Database
        await db.ref(`users/${userRecord.uid}`).set({
            uid: userRecord.uid,
            email: DEFAULT_ADMIN.email,
            name: DEFAULT_ADMIN.name,
            role: DEFAULT_ADMIN.role,
            status: DEFAULT_ADMIN.status,
            createdAt: Date.now(),
            emailVerified: true
        });

        console.log(`Admin user created successfully!`);
        console.log(`Email: ${DEFAULT_ADMIN.email}`);
        console.log(`Password: ${DEFAULT_ADMIN.password}`);
        console.log(`UID: ${userRecord.uid}`);

        return userRecord.uid;
    } catch (error) {
        console.error('Error creating admin:', error);
        if (error.code === 'auth/email-already-exists') {
            console.log('Email already exists. Please check existing users.');
        }
        throw error;
    }
}

createDefaultAdmin()
    .then(uid => {
        console.log('\n✅ Default admin created successfully!');
        console.log('You can now login with:');
        console.log('  Email: admin@silvercare.com');
        console.log('  Password: admin123');
        process.exit(0);
    })
    .catch(err => {
        console.error('\n❌ Failed to create admin:', err.message);
        process.exit(1);
    });
