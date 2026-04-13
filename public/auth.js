// Shared authentication utility for Fred's Rehab Tracker
// Fetches user role, hides editor-only elements for viewers, provides logout()

window.userRole = null;

window.authReady = (async function initAuth() {
    try {
        const res = await fetch('/api/user-status');
        const data = await res.json();

        // Highlight the current page's nav link (always applied)
        const currentPath = window.location.pathname;
        document.querySelectorAll('header nav a').forEach(link => {
            const href = link.getAttribute('href');
            if (href && (href === currentPath || (currentPath === '/' && href === '/'))) {
                link.classList.add('active-page');
            }
        });

        if (!data.authEnabled) {
            // Auth disabled — treat everyone as editor, hide login/logout UI
            window.userRole = 'editor';
            const logoutBtn = document.getElementById('logout-btn');
            if (logoutBtn) logoutBtn.style.display = 'none';
            return;
        }

        window.userRole = data.role;

        if (!window.userRole) {
            window.location.href = '/login.html';
            return;
        }

        if (window.userRole !== 'editor') {
            document.querySelectorAll('.editor-only').forEach(el => {
                el.style.display = 'none';
            });
        }

        // Inject role badge into nav
        const nav = document.querySelector('header nav');
        if (nav) {
            const badge = document.createElement('span');
            badge.id = 'role-badge';
            badge.className = window.userRole === 'editor' ? 'badge-editor' : 'badge-viewer';
            badge.textContent = window.userRole === 'editor' ? 'Editor' : 'Viewer';
            nav.insertBefore(badge, nav.firstChild);
        }

    } catch (err) {
        console.error('Auth check failed:', err);
    }
})();

function logout() {
    fetch('/api/logout', { method: 'POST' }).then(() => {
        window.location.href = '/login.html';
    });
}

// PWA: inject manifest link and register service worker on every page
(function initPWA() {
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = '/manifest.json';
    document.head.appendChild(link);

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(err =>
            console.warn('SW registration failed:', err)
        );
    }
}());
