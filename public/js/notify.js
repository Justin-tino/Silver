/**
 * SilverCare Notification Modal System
 * Replaces all alert() and confirm() calls with styled modals.
 * Auto-injects modal HTML into the page on load.
 */

(function() {
    // Inject modal HTML into page
    const modalHTML = `
    <style>
        @keyframes scModalIn { 0% { transform: scale(0.85); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
        @keyframes scModalOut { 0% { transform: scale(1); opacity: 1; } 100% { transform: scale(0.85); opacity: 0; } }
        .sc-modal-overlay {
            display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.45); z-index: 9999; justify-content: center; align-items: center;
            backdrop-filter: blur(2px);
        }
        .sc-modal-overlay.active { display: flex; }
        .sc-modal-box {
            background: white; padding: 35px 30px; border-radius: 16px; width: 400px; max-width: 90vw;
            text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.15); animation: scModalIn 0.25s ease-out;
        }
        .sc-modal-icon {
            width: 70px; height: 70px; border-radius: 50%; display: flex;
            justify-content: center; align-items: center; margin: 0 auto 18px;
        }
        .sc-modal-icon i { font-size: 2rem; }
        .sc-modal-icon.success { background: linear-gradient(135deg, #dcfce7, #bbf7d0); }
        .sc-modal-icon.success i { color: #22c55e; }
        .sc-modal-icon.error { background: linear-gradient(135deg, #fee2e2, #fecaca); }
        .sc-modal-icon.error i { color: #ef4444; }
        .sc-modal-icon.warning { background: linear-gradient(135deg, #fef3c7, #fde68a); }
        .sc-modal-icon.warning i { color: #f59e0b; }
        .sc-modal-icon.info { background: linear-gradient(135deg, #dbeafe, #bfdbfe); }
        .sc-modal-icon.info i { color: #3b82f6; }
        .sc-modal-icon.confirm { background: linear-gradient(135deg, #e0e7ff, #c7d2fe); }
        .sc-modal-icon.confirm i { color: #6366f1; }
        .sc-modal-title { margin-bottom: 8px; color: #1e293b; font-size: 1.25rem; font-weight: 600; }
        .sc-modal-msg { color: #64748b; font-size: 0.95rem; margin-bottom: 22px; line-height: 1.5; }
        .sc-modal-btn {
            display: inline-block; padding: 10px 24px; border: none; border-radius: 8px;
            font-size: 0.95rem; font-weight: 600; cursor: pointer; transition: opacity 0.15s;
            font-family: 'Inter', sans-serif;
        }
        .sc-modal-btn:hover { opacity: 0.9; }
        .sc-modal-btn.success { background: #22c55e; color: white; }
        .sc-modal-btn.error { background: #ef4444; color: white; }
        .sc-modal-btn.warning { background: #f59e0b; color: white; }
        .sc-modal-btn.info { background: #3b82f6; color: white; }
        .sc-modal-btn.cancel { background: #e2e8f0; color: #475569; margin-right: 10px; }
        .sc-modal-btn.confirm-yes { background: #6366f1; color: white; }
    </style>
    <div id="scNotifyModal" class="sc-modal-overlay">
        <div class="sc-modal-box">
            <div id="scNotifyIcon" class="sc-modal-icon success"><i class="fas fa-check"></i></div>
            <h3 id="scNotifyTitle" class="sc-modal-title"></h3>
            <p id="scNotifyMsg" class="sc-modal-msg"></p>
            <div id="scNotifyActions"></div>
        </div>
    </div>`;

    document.addEventListener('DOMContentLoaded', () => {
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    });

    const iconMap = {
        success: { icon: 'fa-check', cls: 'success' },
        error: { icon: 'fa-exclamation-triangle', cls: 'error' },
        warning: { icon: 'fa-exclamation', cls: 'warning' },
        info: { icon: 'fa-info-circle', cls: 'info' },
        confirm: { icon: 'fa-question', cls: 'confirm' }
    };

    const titleMap = {
        success: 'Success',
        error: 'Error',
        warning: 'Attention',
        info: 'Information',
        confirm: 'Confirm Action'
    };

    /**
     * Show a notification modal.
     * @param {string} type - 'success' | 'error' | 'warning' | 'info'
     * @param {string} message
     * @param {string} [title]
     * @param {Function} [onClose]
     */
    window.scNotify = function(type, message, title, onClose) {
        const modal = document.getElementById('scNotifyModal');
        const iconDiv = document.getElementById('scNotifyIcon');
        const titleEl = document.getElementById('scNotifyTitle');
        const msgEl = document.getElementById('scNotifyMsg');
        const actionsEl = document.getElementById('scNotifyActions');
        const info = iconMap[type] || iconMap.info;

        iconDiv.className = 'sc-modal-icon ' + info.cls;
        iconDiv.innerHTML = `<i class="fas ${info.icon}"></i>`;
        titleEl.textContent = title || titleMap[type] || 'Notice';
        msgEl.textContent = message;
        actionsEl.innerHTML = `<button class="sc-modal-btn ${info.cls}" id="scNotifyClose">OK</button>`;

        modal.classList.add('active');

        document.getElementById('scNotifyClose').onclick = () => {
            modal.classList.remove('active');
            if (onClose) onClose();
        };
    };

    /**
     * Show a confirmation modal with Yes/No buttons.
     * @param {string} message
     * @param {Function} onYes
     * @param {Function} [onNo]
     * @param {string} [title]
     */
    window.scConfirm = function(message, onYes, onNo, title) {
        const modal = document.getElementById('scNotifyModal');
        const iconDiv = document.getElementById('scNotifyIcon');
        const titleEl = document.getElementById('scNotifyTitle');
        const msgEl = document.getElementById('scNotifyMsg');
        const actionsEl = document.getElementById('scNotifyActions');

        iconDiv.className = 'sc-modal-icon confirm';
        iconDiv.innerHTML = '<i class="fas fa-question"></i>';
        titleEl.textContent = title || 'Confirm Action';
        msgEl.textContent = message;
        actionsEl.innerHTML = `
            <button class="sc-modal-btn cancel" id="scConfirmNo">Cancel</button>
            <button class="sc-modal-btn confirm-yes" id="scConfirmYes">Yes, Proceed</button>
        `;

        modal.classList.add('active');

        document.getElementById('scConfirmYes').onclick = () => {
            modal.classList.remove('active');
            if (onYes) onYes();
        };
        document.getElementById('scConfirmNo').onclick = () => {
            modal.classList.remove('active');
            if (onNo) onNo();
        };
    };
})();
