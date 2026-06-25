import { auth, db } from './firebase-init.js';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-auth.js";
import { ref, get, set } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-database.js";

document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('loginForm');
    
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const btn = loginForm.querySelector('.btn-primary');
            
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Authenticating...';
            btn.disabled = true;

            try {
                let userCredential;
                // Special Rule: Setup Master Admin Account on first try
                if (email === 'admin@silvercare.com') {
                    try {
                        userCredential = await signInWithEmailAndPassword(auth, email, password);
                    } catch (err) {
                        if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential' || err.code === 'auth/invalid-login-credentials') {
                            userCredential = await createUserWithEmailAndPassword(auth, email, password);
                            await set(ref(db, 'users/' + userCredential.user.uid), {
                                email: email,
                                role: 'admin',
                                status: 'Active',
                                name: 'Master Admin'
                            });
                        } else {
                            throw err;
                        }
                    }
                } else {
                    // Standard Login
                    userCredential = await signInWithEmailAndPassword(auth, email, password);
                }

                const user = userCredential.user;

                // Check Database Role and Status
                const userRef = ref(db, 'users/' + user.uid);
                const snapshot = await get(userRef);
                
                if (snapshot.exists()) {
                    const userData = snapshot.val();

                    if (userData.status === 'Pending') {
                        await auth.signOut();
                        scNotify('warning', 'Your account is still awaiting admin approval. You will be notified once approved.', 'Account Pending');
                        btn.innerHTML = originalText;
                        btn.disabled = false;
                        return;
                    }

                    if (userData.status === 'Rejected') {
                        await auth.signOut();
                        scNotify('error', 'Your account request has been rejected. Please contact an administrator for assistance.', 'Account Rejected');
                        btn.innerHTML = originalText;
                        btn.disabled = false;
                        return;
                    }

                    if (userData.status !== 'Active') {
                        await auth.signOut();
                        scNotify('error', 'Your account is currently inactive. Please contact an administrator.', 'Account Inactive');
                        btn.innerHTML = originalText;
                        btn.disabled = false;
                        return;
                    }

                    localStorage.setItem('userRole', userData.role);
                    
                    // Check maintenance mode for non-admins
                    if (userData.role !== 'admin') {
                        const maintenanceSnap = await get(ref(db, 'system/settings/maintenanceMode'));
                        if (maintenanceSnap.exists() && maintenanceSnap.val() === true) {
                            await auth.signOut();
                            localStorage.removeItem('userRole');
                            scNotify('warning', 'The system is currently under maintenance. Please try again later.', 'System Maintenance');
                            btn.innerHTML = originalText;
                            btn.disabled = false;
                            return;
                        }
                    }

                    // Redirect based on role
                    if (userData.role === 'admin') window.location.href = '/admin';
                    else if (userData.role === 'employee') window.location.href = '/employee';
                    else window.location.href = '/senior';
                } else {
                    scNotify('error', 'Your user profile was not found in the database. Please contact an administrator.', 'Profile Not Found');
                    await auth.signOut();
                    btn.innerHTML = originalText;
                    btn.disabled = false;
                }

            } catch (error) {
                console.error("Login error:", error);
                let friendlyMessage = 'An unexpected error occurred. Please try again. (' + (error.code || error.message || 'Unknown error') + ')';
                
                if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password' || error.code === 'auth/invalid-login-credentials') {
                    friendlyMessage = 'Invalid email or password. Please check your credentials and try again.';
                } else if (error.code === 'auth/user-not-found') {
                    friendlyMessage = 'No account found with this email. Please sign up first.';
                } else if (error.code === 'auth/too-many-requests') {
                    friendlyMessage = 'Too many failed login attempts. Please wait a few minutes before trying again.';
                } else if (error.code === 'auth/network-request-failed') {
                    friendlyMessage = 'Network error. Please check your internet connection.';
                }

                scNotify('error', friendlyMessage, 'Login Failed');
                btn.innerHTML = originalText;
                btn.disabled = false;
            }
        });
    }

    // Handle logout
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                await auth.signOut();
                localStorage.removeItem('userRole');
                window.location.href = '/';
            } catch (err) {
                scNotify('error', 'Failed to log out. Please try again.', 'Logout Error');
            }
        });
    }
});
