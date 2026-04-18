// Shared navigation builder — included on every page.
// Renders grouped dropdown nav into <nav id="main-nav">.
(function () {
    const nav = document.getElementById('main-nav');
    if (!nav) return;

    const path = window.location.pathname;

    const groups = [
        {
            label: 'Track',
            items: [
                { href: '/history.html',              label: 'History' },
                { href: '/steps-graph.html',          label: 'Steps Graph' },
                { href: '/calendar-view.html',        label: 'Calendar' },
            ]
        },
        {
            label: 'Progress',
            items: [
                { href: '/achievements.html',         label: 'Achievements' },
                { href: '/milestones.html',           label: 'Fun Milestones' },
                { href: '/report.html',               label: 'Progress Report' },
                { href: '/story.html',                label: "Fred's Story" },
                { href: '/exercise-videos.html',      label: 'Exercise Videos' },
            ]
        },
    ];

    function isActive(href) {
        if (href === '/') return path === '/';
        return path === href;
    }

    function aTag(href, label, extraClasses = []) {
        const cls = [...extraClasses, isActive(href) ? 'active-page' : ''].filter(Boolean).join(' ');
        return `<a href="${href}"${cls ? ` class="${cls}"` : ''}>${label}</a>`;
    }

    let html = '';

    // Standalone editor-only entry links (replaces Record dropdown)
    html += aTag('/', 'Enter Data', ['editor-only']);
    html += aTag('/enter-data-tabular.html', 'Tabular Entry', ['editor-only']);

    // Dropdown groups
    for (const g of groups) {
        const activeItem = g.items.find(i => isActive(i.href));
        const hasActive = !!activeItem;
        const btnLabel = g.label;
        html += `<div class="nav-group${hasActive ? ' has-active' : ''}">`;
        html += `<a href="#" class="nav-group-btn">${btnLabel} <span class="nav-chevron">▾</span></a>`;
        html += `<div class="nav-dropdown">`;
        for (const item of g.items) {
            const cls = [isActive(item.href) ? 'active-page' : '', item.editorOnly ? 'editor-only' : ''].filter(Boolean).join(' ');
            html += `<a href="${item.href}"${cls ? ` class="${cls}"` : ''}>${item.label}</a>`;
        }
        html += `</div></div>`;
    }

    // Data Management (editor-only)
    html += aTag('/data-management.html', 'Data Management', ['editor-only']);

    // Spacer pushes Help and Logout to the right
    html += `<div class="nav-spacer"></div>`;

    // Help
    html += aTag('/help.html', 'Help');

    // Divider + footer (Logout + lang toggle)
    html += `<div class="nav-divider"></div>`;
    html += `<div class="nav-footer">`;
    html += `<a href="#" id="logout-btn" onclick="if(typeof logout==='function')logout()">Logout</a>`;
    html += `<button id="lang-toggle" title="Switch language"><img src="https://flagsapi.com/FR/flat/24.png" alt="FR"></button>`;
    html += `</div>`;

    nav.innerHTML = html;

    // Click to open/close groups
    nav.querySelectorAll('.nav-group-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            const grp = btn.parentElement;
            const isOpen = grp.classList.contains('open');
            nav.querySelectorAll('.nav-group').forEach(g => g.classList.remove('open'));
            if (!isOpen) grp.classList.add('open');
        });
    });

    document.addEventListener('click', () => {
        nav.querySelectorAll('.nav-group').forEach(g => g.classList.remove('open'));
    });
})();
