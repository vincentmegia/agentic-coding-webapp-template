// Keyboard-operable dropdown menus for the header's Home/Settings nav
// (components/nav-menu.html), plus two small pieces of nav lifecycle
// behavior that don't warrant their own file. See docs/features/home.md.
//
// External file, no inline <script> — see home.md's Security
// Considerations ("No inline <script> tags anywhere in this shell").
(function () {
	'use strict';

	var menus = Array.prototype.slice.call(document.querySelectorAll('[data-nav-menu]'));

	function parts(menu) {
		return {
			trigger: menu.querySelector('[data-nav-trigger]'),
			list: menu.querySelector('[data-nav-list]'),
			items: Array.prototype.slice.call(menu.querySelectorAll('[data-nav-item]')),
		};
	}

	function isOpen(menu) {
		var trigger = menu.querySelector('[data-nav-trigger]');
		return !!trigger && trigger.getAttribute('aria-expanded') === 'true';
	}

	function closeMenu(menu, focusTrigger) {
		var p = parts(menu);
		if (!p.trigger || !p.list) return;
		p.trigger.setAttribute('aria-expanded', 'false');
		p.list.classList.add('hidden');
		if (focusTrigger) p.trigger.focus();
	}

	function closeAllMenus() {
		menus.forEach(function (menu) {
			closeMenu(menu, false);
		});
	}

	function openMenu(menu, focusFirstItem) {
		closeAllMenus();
		var p = parts(menu);
		if (!p.trigger || !p.list) return;
		p.trigger.setAttribute('aria-expanded', 'true');
		p.list.classList.remove('hidden');
		if (focusFirstItem && p.items.length) p.items[0].focus();
	}

	menus.forEach(function (menu) {
		var p = parts(menu);
		if (!p.trigger || !p.list) return;

		// Enter/Space/click opens (docs/features/home.md's Business
		// Rules); arrow keys move between items; Escape closes and
		// returns focus to the trigger.
		p.trigger.addEventListener('click', function () {
			if (isOpen(menu)) {
				closeMenu(menu, false);
			} else {
				openMenu(menu, false);
			}
		});

		p.trigger.addEventListener('keydown', function (e) {
			if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				openMenu(menu, true);
			} else if (e.key === 'Escape' && isOpen(menu)) {
				closeMenu(menu, true);
			}
		});

		p.list.addEventListener('keydown', function (e) {
			var items = parts(menu).items;
			var currentIndex = items.indexOf(document.activeElement);

			if (e.key === 'Escape') {
				e.preventDefault();
				closeMenu(menu, true);
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				var next = items[(currentIndex + 1) % items.length];
				if (next) next.focus();
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				var prev = items[(currentIndex - 1 + items.length) % items.length];
				if (prev) prev.focus();
			} else if (e.key === 'Tab') {
				// Let focus leave naturally; just close so it doesn't
				// linger open once focus has moved elsewhere.
				closeMenu(menu, false);
			}
		});
	});

	// Close on outside click (home.md's Business Rules).
	document.addEventListener('click', function (e) {
		menus.forEach(function (menu) {
			if (isOpen(menu) && !menu.contains(e.target)) {
				closeMenu(menu, false);
			}
		});
	});

	// --- Active nav-link marking -------------------------------------
	//
	// docs/features/home.md's Business Rules: "The nav item matching the
	// current route is visually marked active, determined from
	// location.pathname (not in-memory state), so it stays correct across
	// refresh and browser back/forward." Header/footer are never
	// re-rendered by the content-only HTMX swaps (home.md's HTMX
	// Interactions), so this has to independently re-run after
	// navigation, same contract as header-scroll.js's reset logic.
	function updateActiveNavLinks() {
		var links = document.querySelectorAll('[data-nav-link]');
		var currentPath = window.location.pathname;
		links.forEach(function (link) {
			var linkPath;
			try {
				linkPath = new URL(link.href, window.location.origin).pathname;
			} catch (err) {
				return;
			}
			if (linkPath === currentPath) {
				link.setAttribute('aria-current', 'page');
				link.classList.add('nav-link--active');
			} else {
				link.removeAttribute('aria-current');
				link.classList.remove('nav-link--active');
			}
		});
	}

	updateActiveNavLinks();
	document.body.addEventListener('htmx:afterSwap', updateActiveNavLinks);
	window.addEventListener('popstate', updateActiveNavLinks);

	// --- Identity link no-op while already on `/` ---------------------
	//
	// docs/features/home.md assigns this to header-scroll.js's contract,
	// but header-scroll.js is intentionally left as an empty placeholder
	// this wave (its real job — the transparent-over-hero scroll
	// behavior — belongs to docs/features/landing-page.md, a separate,
	// not-yet-built feature). This piece doesn't depend on any of that
	// scroll/hero logic, so it lives here instead. Cancelling htmx's own
	// "htmx:beforeRequest" event (rather than the click event) is used
	// because it's cancelable regardless of listener attachment order,
	// unlike racing htmx's own click handler.
	document.body.addEventListener('htmx:beforeRequest', function (e) {
		var elt = e.detail && e.detail.elt;
		if (elt && elt.hasAttribute('data-identity-link') && window.location.pathname === '/') {
			e.preventDefault();
		}
	});

	// --- Content error state -------------------------------------------
	//
	// docs/features/home.md's UI states: "Content error: Content area
	// shows a clear 'couldn't load this page' message without breaking
	// the header/footer." None of Wave 1's routes can realistically fail
	// (static placeholder content, no DB), but this keeps the contract
	// true for future pages that swap into #main-content over HTTP.
	document.body.addEventListener('htmx:responseError', function () {
		var target = document.getElementById('main-content');
		if (!target) return;
		target.outerHTML =
			'<main id="main-content" class="mx-auto max-w-5xl px-4 py-8">' +
			'<p class="text-slate-600">Couldn’t load this page. Please try again.</p>' +
			'</main>';
	});
})();
