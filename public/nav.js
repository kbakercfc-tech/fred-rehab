// Shared navigation builder — included on every page.
// Renders the top bar (brand + menu), the phone slide-out menu and the phone
// bottom tab bar, and applies small page-wide touches (page heading, label
// tidy-up, Yes/No switches).
(function () {
    const nav = document.getElementById('main-nav');
    if (!nav) return;
    const header = nav.closest('header');

    const path = window.location.pathname;
    const BRAND = "Fred's Rehab Tracker";

    // Simple line icons (24×24, drawn with the current text colour).
    const ICON_PATHS = {
        brand:    '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 12 5a5.5 5.5 0 0 0-10 3.5c0 2.3 1.5 4 3 5.5l7 7Z"/><path d="M3.5 12h4l2-3 3 6 2-3h6"/>',
        edit:     '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
        table:    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
        list:     '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01" stroke-width="3"/>',
        chart:    '<path d="M3 3v18h18"/><path d="M8 16v-4M13 16V8M18 16v-7"/>',
        run:      '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
        calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
        chat:     '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12Z"/>',
        trophy:   '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0Z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
        flag:     '<path d="M4 22V4M4 4h13l-2 4 2 4H4"/>',
        report:   '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
        book:     '<path d="M4 19V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2Zm0 0a2 2 0 0 0 2 2h14"/>',
        video:    '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/>',
        database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
        help:     '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7M12 17h.01"/>',
        logout:   '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
        menu:     '<path d="M4 6h16M4 12h16M4 18h16"/>',
        close:    '<path d="M6 6l12 12M18 6 6 18"/>',
        more:     '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
        chevron:  '<path d="m6 9 6 6 6-6"/>',
    };
    const icon = (name, cls = 'nav-icon') =>
        `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;

    const groups = [
        {
            label: 'Track',
            items: [
                { href: '/history.html',              label: 'History',         icon: 'list' },
                { href: '/steps-graph.html',          label: 'Steps Graph',     icon: 'chart' },
                { href: '/runs.html',                 label: '5k Runs',         icon: 'run' },
                { href: '/calendar-view.html',        label: 'Calendar',        icon: 'calendar' },
            ]
        },
        {
            label: 'Progress',
            items: [
                { href: '/ask.html',                  label: 'Ask a Question',  icon: 'chat' },
                { href: '/achievements.html',         label: 'Achievements',    icon: 'trophy' },
                { href: '/milestones.html',           label: 'Fun Milestones',  icon: 'flag' },
                { href: '/report.html',               label: 'Progress Report', icon: 'report' },
                { href: '/story.html',                label: "Fred's Story",    icon: 'book' },
                { href: '/exercise-videos.html',      label: 'Exercise Videos', icon: 'video' },
            ]
        },
    ];

    function isActive(href) {
        if (href === '/') return path === '/';
        return path === href;
    }

    function aTag(href, label, iconName, extraClasses = []) {
        const cls = [...extraClasses, isActive(href) ? 'active-page' : ''].filter(Boolean).join(' ');
        return `<a href="${href}"${cls ? ` class="${cls}"` : ''}>${icon(iconName)}<span>${label}</span></a>`;
    }

    // ── Brand: the app name stays in the top bar on every page ──
    // The page's own title moves into the page as a heading (see below).
    const pageTitle = header && header.querySelector('h1');
    if (header) {
        const brand = document.createElement('a');
        brand.href = '/';
        brand.className = 'brand';
        brand.innerHTML = `${icon('brand', 'brand-icon')}<span data-translate="${BRAND}">${BRAND}</span>`;
        header.insertBefore(brand, header.firstChild);

        const menuBtn = document.createElement('button');
        menuBtn.type = 'button';
        menuBtn.className = 'menu-toggle';
        menuBtn.setAttribute('aria-label', 'Menu');
        menuBtn.setAttribute('aria-expanded', 'false');
        menuBtn.innerHTML = icon('menu');
        header.appendChild(menuBtn);
        menuBtn.addEventListener('click', () => setDrawer(!document.body.classList.contains('nav-open')));
    }

    // ── Menu ──
    let html = '';
    html += `<div class="drawer-head"><span>Menu</span><button type="button" class="drawer-close" aria-label="Close menu">${icon('close')}</button></div>`;
    html += aTag('/', 'Enter Data', 'edit', ['editor-only']);
    html += aTag('/enter-data-tabular.html', 'Tabular Entry', 'table', ['editor-only']);

    for (const g of groups) {
        const hasActive = g.items.some(i => isActive(i.href));
        html += `<div class="nav-group${hasActive ? ' has-active' : ''}">`;
        html += `<a href="#" class="nav-group-btn"><span>${g.label}</span>${icon('chevron', 'nav-chevron')}</a>`;
        html += `<div class="nav-dropdown">`;
        for (const item of g.items) html += aTag(item.href, item.label, item.icon);
        html += `</div></div>`;
    }

    html += aTag('/data-management.html', 'Data Management', 'database', ['editor-only']);
    html += `<div class="nav-spacer"></div>`;
    html += aTag('/help.html', 'Help', 'help');
    html += `<div class="nav-divider"></div>`;
    html += `<div class="nav-footer">`;
    html += `<a href="#" id="logout-btn" onclick="if(typeof logout==='function')logout()">${icon('logout')}<span>Logout</span></a>`;
    html += `<button id="lang-toggle" type="button" title="Switch language / Changer de langue"><img src="/images/flag-fr.svg" alt="FR"></button>`;
    html += `</div>`;
    nav.innerHTML = html;

    // Desktop: click a group to open its dropdown.
    nav.querySelectorAll('.nav-group-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            if (document.body.classList.contains('nav-open')) return; // groups are always open in the phone menu
            const grp = btn.parentElement;
            const isOpen = grp.classList.contains('open');
            nav.querySelectorAll('.nav-group').forEach(g => g.classList.remove('open'));
            if (!isOpen) grp.classList.add('open');
        });
    });
    document.addEventListener('click', () => {
        nav.querySelectorAll('.nav-group').forEach(g => g.classList.remove('open'));
    });

    // ── Phone slide-out menu ──
    const backdrop = document.createElement('div');
    backdrop.className = 'nav-backdrop';
    document.body.appendChild(backdrop);
    function setDrawer(open) {
        document.body.classList.toggle('nav-open', open);
        const btn = header && header.querySelector('.menu-toggle');
        if (btn) btn.setAttribute('aria-expanded', String(open));
    }
    backdrop.addEventListener('click', () => setDrawer(false));
    nav.querySelector('.drawer-close').addEventListener('click', () => setDrawer(false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') setDrawer(false); });

    // ── Phone bottom tab bar ──
    const tabs = [
        { href: '/',                 label: 'Enter',  icon: 'edit',  cls: 'editor-only' },
        { href: '/steps-graph.html', label: 'Steps',  icon: 'chart' },
        { href: '/runs.html',        label: 'Runs',   icon: 'run' },
        { href: '/ask.html',         label: 'Ask',    icon: 'chat' },
    ];
    const tabbar = document.createElement('nav');
    tabbar.className = 'tabbar';
    tabbar.setAttribute('aria-label', 'Quick links');
    tabbar.innerHTML = tabs.map(t =>
        `<a href="${t.href}" class="${[t.cls, isActive(t.href) ? 'active-page' : ''].filter(Boolean).join(' ')}">${icon(t.icon)}<span>${t.label}</span></a>`
    ).join('') + `<a href="#" class="tabbar-more">${icon('more')}<span>More</span></a>`;
    document.body.appendChild(tabbar);
    tabbar.querySelector('.tabbar-more').addEventListener('click', e => { e.preventDefault(); setDrawer(true); });

    // ── Page touches once the page has loaded ──
    document.addEventListener('DOMContentLoaded', () => {
        // Page title becomes a heading at the top of the page.
        const main = document.querySelector('main');
        if (pageTitle && main && pageTitle.textContent.trim() !== BRAND) {
            const wrap = document.createElement('div');
            wrap.className = 'page-heading';
            wrap.appendChild(pageTitle);
            main.insertBefore(wrap, main.firstChild);
        } else if (pageTitle) {
            pageTitle.remove();
        }

        tidyLabels(document.body);
        new MutationObserver(records => {
            for (const r of records) {
                const el = r.target.nodeType === 3 ? r.target.parentElement : r.target;
                if (el && el.closest && el.closest('label')) tidyLabels(el.closest('label'));
            }
        }).observe(document.body, { subtree: true, childList: true, characterData: true });

        document.querySelectorAll('select[data-switch]').forEach(makeSwitch);
    });

    // Form labels read better without a trailing colon ("Date" not "Date:").
    function tidyLabels(root) {
        const labels = root.matches && root.matches('label') ? [root] : root.querySelectorAll('label');
        labels.forEach(label => {
            const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                if (/\s*:\s*$/.test(node.nodeValue) && node.nodeValue.trim() !== ':') {
                    node.nodeValue = node.nodeValue.replace(/\s*:\s*$/, '');
                }
            }
        });
    }

    // Turns a Yes/No <select data-switch> into an on/off switch. The select stays
    // in the page (hidden), so existing code that reads or sets its value keeps working.
    function makeSwitch(select) {
        const yes = [...select.options].find(o => o.value === 'Yes');
        const no = [...select.options].find(o => o.value === 'No');
        if (!yes || !no) return;
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'switch';
        sw.setAttribute('role', 'switch');
        sw.innerHTML = '<span class="switch-track"><span class="switch-thumb"></span></span><span class="switch-text"></span>';
        select.classList.add('switch-source');
        select.insertAdjacentElement('afterend', sw);

        const sync = () => {
            const on = select.value === 'Yes';
            sw.setAttribute('aria-checked', String(on));
            sw.classList.toggle('on', on);
            sw.querySelector('.switch-text').textContent = (on ? yes : no).textContent;
        };
        sw.addEventListener('click', () => {
            select.value = select.value === 'Yes' ? 'No' : 'Yes';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        select.addEventListener('change', sync);
        // Page code sets select.value directly when loading a day's data; keep the switch in step.
        const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        Object.defineProperty(select, 'value', {
            get() { return desc.get.call(this); },
            set(v) { desc.set.call(this, v); sync(); },
        });
        // Option text changes when the language is switched.
        new MutationObserver(sync).observe(select, { subtree: true, childList: true, characterData: true });
        sync();
    }
})();
