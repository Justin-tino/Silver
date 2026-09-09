// ============================================================
// Queue / Appointment / Attendance system (Phase 1 - Server)
// Per thesis:
//  - Seniors book appointments -> get queue number
//  - Frontend shows queue position
//  - Attendance: Pending / Attended / Missed / Rescheduled
//  - All operations RBAC-guarded + audit logged
// Firebase RTDB = single source of truth
// ============================================================

// --- API: List queues (admin/staff only; optional filter) ---
app.get('/api/queues', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { status, date } = req.query;
    const actor = req.authUser;
    try {
        const ref = admin.database().ref('queue');
        const snap = await ref.once('value');
        const all = snap.val() || {};
        const result = [];
        Object.values(all).forEach(q => {
            if (status && q.status !== status) return;
            if (date && new Date(q.scheduledAt).toDateString() !== new Date(date).toDateString()) return;
            result.push(q);
        });
        result.sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
        res.json({ success: true, queues: result });
    } catch (error) {
        console.error('List queues error:', error);
        res.status(500).json({ success: false, message: 'Failed to load queues.' });
    }
});

// --- API: Get my queue slots (senior: own; staff: all) ---
app.get('/api/queues/:uid', requireAuth, async (req, res) => {
    const { uid } = req.params;
    const actor = req.authUser;
    try {
        if (actor.role === 'senior' && actor.uid !== uid) {
            return res.status(403).json({ success: false, message: 'You may only view your own queue slots.' });
        }
        const ref = admin.database().ref('queue');
        const snap = await ref.orderByChild('uid').equalTo(uid).once('value');
        const items = snap.val() || {};
        const result = Object.values(items)
            .map(q => ({ id: q.id, ...q }))
            .sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
        res.json({ success: true, queues: result });
    } catch (error) {
        console.error('My queues error:', error);

// --- API: Book a queue appointment (senior only; own) ---
app.post('/api/queue/book', requireAuth, requireRole('senior'), async (req, res) => {
    const { date, time, service, note } = req.body;
    const actor = req.authUser;
    try {
        if (!date || !time) return res.status(400).json({ success: false, message: 'date and time are required.' });
        const scheduledAt = new Date(`${date}T${time}`).getTime();
        if (isNaN(scheduledAt)) return res.status(400).json({ success: false, message: 'Invalid date/time format.' });
        if (scheduledAt < Date.now()) return res.status(400).json({ success: false, message: 'Cannot book a past appointment.' });

        const dayStart = new Date(date).setHours(0,0,0,0);
        const dayEnd = dayStart + 86400000;
        const existingSnap = await admin.database().ref('queue')
            .orderByChild('uid').equalTo(actor.uid)
            .once('value');
        if (existingSnap.exists()) {
            const existing = existingSnap.val();
            const conflict = Object.values(existing).some(q => {
                const ts = q.scheduledAt || 0;
                return ts >= dayStart && ts < dayEnd;
            });
            if (conflict) {
                return res.status(409).json({ success: false, message: 'You already have a booking on this date. Please reschedule or cancel the existing one first.' });
            }
        }

        const id = admin.database().ref('queue').push().key;
        const queueRef = admin.database().ref(`queue/${id}`);
        const queueData = {
            id,
            uid: actor.uid,
            name: actor.name || actor.email || '',
            date,
            time,
            scheduledAt,
            service: String(service || 'General Consultation').slice(0, 80),
            note: String(note || '').slice(0, 300),
            status: 'Pending',
            createdAt: Date.now(),
            createdBy: actor.uid
        };
        await queueRef.set(queueData);
        await writeAuditLog('QUEUE_APPOINTMENT_BOOKED', actor, actor.uid, id,
            `Booked ${service || 'General Consultation'} on ${date} at ${time}`);

// --- API: Cancel my queue appointment (senior only; own; pending only) ---
app.delete('/api/queue/:queueId', requireAuth, requireRole('senior'), async (req, res) => {
    const { queueId } = req.params;
    const actor = req.authUser;
    try {
        const queueRef = admin.database().ref(`queue/${queueId}`);
        const snap = await queueRef.once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Queue appointment not found.' });
        const q = snap.val();
        if (q.uid !== actor.uid) return res.status(403).json({ success: false, message: 'You may only cancel your own appointments.' });
        if (q.status !== 'Pending') return res.status(400).json({ success: false, message: 'Only pending appointments can be cancelled.' });

        await writeAuditLog('QUEUE_APPOINTMENT_CANCELLED', actor, actor.uid, queueId,
            `Cancelled appointment on ${q.date} at ${q.time}`);
        await queueRef.remove();

        res.json({ success: true, message: 'Appointment cancelled.' });
    } catch (error) {
        console.error('Cancel queue error:', error);
        res.status(500).json({ success: false, message: 'Failed to cancel appointment.' });
    }
});

// --- API: Update queue status (admin/staff only) ---
app.put('/api/queue/:queueId/status', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { queueId } = req.params;
    const { status, attendedAt, note } = req.body;
    const actor = req.authUser;
    try {
        const validStatuses = ['Pending', 'Attended', 'Missed', 'Rescheduled'];
        if (!validStatuses.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status. Allowed: ' + validStatuses.join(', ') });

        const queueRef = admin.database().ref(`queue/${queueId}`);
        const snap = await queueRef.once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Queue appointment not found.' });
        const q = snap.val();

        const updates = { status };
        if (status === 'Attended') updates.attendedAt = attendedAt ? Number(attendedAt) : Date.now();
        if (note) updates.note = String(note).slice(0, 300);
        updates.updatedBy = actor.uid;
        updates.updatedByName = actor.name || actor.email || '';
        updates.updatedAt = Date.now();


// --- API: Log attendance (admin/staff only) ---
app.post('/api/attendance/log', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { queueId, status, attendedAt, note } = req.body;
    const actor = req.authUser;
    try {
        if (!queueId) return res.status(400).json({ success: false, message: 'queueId is required.' });
        const validStatuses = ['Attended', 'Missed', 'Rescheduled'];
        if (!validStatuses.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status. Allowed: ' + validStatuses.join(', ') });

        const queueRef = admin.database().ref(`queue/${queueId}`);
        const snap = await queueRef.once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Queue appointment not found.' });
        const q = snap.val();

        const attRef = admin.database().ref('attendance').push();
        const attData = {
            id: attRef.key,
            queueId,
            uid: q.uid,
            name: q.name || '',
            date: q.date,
            time: q.time,
            service: q.service || '',
            status,
            attendedAt: attendedAt ? Number(attendedAt) : Date.now(),
            note: String(note || '').slice(0, 300),
            recordedBy: actor.uid,
            recordedByName: actor.name || actor.email || '',
            recordedAt: Date.now()
        };
        await attRef.set(attData);

        const queueUpdates = { status };
        if (status === 'Attended') queueUpdates.attendedAt = Date.now();
        queueUpdates.updatedBy = actor.uid;
        queueUpdates.updatedByName = actor.name || actor.email || '';
        queueUpdates.updatedAt = Date.now();
        await queueRef.update(queueUpdates);

        await writeAuditLog('ATTENDANCE_LOGGED', actor, q.uid, attRef.key,
            `Attendance logged: ${status} for ${q.service || 'appointment'} on ${q.date}`);

        res.json({ success: true, message: 'Attendance logged.', attendanceId: attRef.key });

// --- API: Get announcements (all authenticated; read-only) ---
app.get('/api/announcements', requireAuth, async (req, res) => {
    const actor = req.authUser;
    try {
        const snap = await admin.database().ref('announcements').once('value');
        const items = snap.val() || {};
        const result = Object.values(items)
            .sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0))
            .slice(0, 50);
        await writeAuditLog('ANNOUNCEMENTS_VIEWED', actor, null, null,
            `Viewed announcements (${result.length} items)`);
        res.json({ success: true, announcements: result });
    } catch (error) {
        console.error('Announcements error:', error);
        res.status(500).json({ success: false, message: 'Failed to load announcements.' });
    }
});

// --- API: Create announcement (admin only) ---
app.post('/api/announcements', requireAuth, requireRole('admin'), async (req, res) => {
    const { title, message, priority, target } = req.body;
    const actor = req.authUser;
    try {
        if (!title || !message) return res.status(400).json({ success: false, message: 'title and message are required.' });
        const id = admin.database().ref('announcements').push().key;
        const data = {
            id,
            title: String(title).slice(0, 120),
            message: String(message).slice(0, 2000),
            priority: ['high', 'normal', 'low'].includes(priority) ? priority : 'normal',
            target: target || 'all',
            postedBy: actor.uid,
            postedByName: actor.name || actor.email || '',
            postedAt: Date.now()
        };
        await admin.database().ref(`announcements/${id}`).set(data);
        await writeAuditLog('ANNOUNCEMENT_POSTED', actor, null, id,
            `Posted announcement: ${data.title}`);

        try {
            await admin.database().ref(`notifications/ann_${id}`).set({
                type: 'announcement',
                title: data.title,
                message: data.message,
                priority: data.priority,
                target: data.target,
                createdAt: Date.now()
            });
        } catch (e) { /* non-fatal */ }

        res.json({ success: true, message: 'Announcement posted.', announcementId: id });
    } catch (error) {
        console.error('Create announcement error:', error);
        res.status(500).json({ success: false, message: 'Failed to post announcement.' });
    }
});

    } catch (error) {
        console.error('Log attendance error:', error);
        res.status(500).json({ success: false, message: 'Failed to log attendance.' });
    }
});

// --- API: Get attendance log (admin/staff only) ---
app.get('/api/attendance', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { status, date } = req.query;
    const actor = req.authUser;
    try {
        const ref = admin.database().ref('attendance');
        const snap = await ref.once('value');
        const all = snap.val() || {};
        const result = [];
        Object.values(all).forEach(a => {
            if (status && a.status !== status) return;
            if (date && new Date(a.attendedAt).toDateString() !== new Date(date).toDateString()) return;
            result.push(a);
        });
        result.sort((a, b) => (b.attendedAt || 0) - (a.attendedAt || 0));
        res.json({ success: true, attendance: result });
    } catch (error) {
        console.error('Attendance list error:', error);
        res.status(500).json({ success: false, message: 'Failed to load attendance.' });
    }
});

        await queueRef.update(updates);
        await writeAuditLog('QUEUE_APPOINTMENT_STATUS_UPDATED', actor, q.uid, queueId,
            `Marked as ${status} (service: ${q.service || 'N/A'})`);

        res.json({ success: true, message: `Appointment marked as ${status}.` });
    } catch (error) {
        console.error('Update queue status error:', error);
        res.status(500).json({ success: false, message: 'Failed to update appointment status.' });
    }
});


        res.json({ success: true, message: 'Appointment booked.', queueId: id, queueNumber: id.slice(-6).toUpperCase() });
    } catch (error) {
        console.error('Book queue error:', error);
        res.status(500).json({ success: false, message: 'Failed to book appointment.' });
    }
});

        res.status(500).json({ success: false, message: 'Failed to load your queue slots.' });
    }
});
