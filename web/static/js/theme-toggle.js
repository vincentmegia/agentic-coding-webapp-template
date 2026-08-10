// Theme toggle click handling + cookie persistence
// (components/nav-theme-toggle.html). The icon swap itself is pure CSS
// (dark:hidden/dark:block in app.css), so this only needs to flip the
// `dark`/`light` class + cookie on click and keep aria-label in sync. See
// docs/features/dark-mode.md.
//
// External file, no inline <script> — see dark-mode.md's Security
// Considerations.
(function () {
	'use strict';

	var COOKIE_NAME = 'theme';
	var ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

	var toggles = Array.prototype.slice.call(document.querySelectorAll('[data-theme-toggle]'));
	if (!toggles.length) return;

	var root = document.documentElement;

	// Effective current theme, whether it came from an explicit .dark/.light
	// class (cookie was set) or the prefers-color-scheme fallback (no
	// cookie yet) — so the first click always flips the theme the user is
	// actually looking at, not just whatever class happens to be present.
	function isDark() {
		if (root.classList.contains('dark')) return true;
		if (root.classList.contains('light')) return false;
		return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
	}

	function updateLabels() {
		var dark = isDark();
		toggles.forEach(function (btn) {
			var label = dark ? btn.getAttribute('data-label-dark') : btn.getAttribute('data-label-light');
			if (label) btn.setAttribute('aria-label', label);
		});
	}

	function setTheme(dark) {
		root.classList.toggle('dark', dark);
		root.classList.toggle('light', !dark);

		var secure = window.location.protocol === 'https:' ? '; Secure' : '';
		document.cookie =
			COOKIE_NAME + '=' + (dark ? 'dark' : 'light') +
			'; path=/; max-age=' + ONE_YEAR_SECONDS + '; SameSite=Lax' + secure;

		updateLabels();
	}

	toggles.forEach(function (btn) {
		btn.addEventListener('click', function () {
			setTheme(!isDark());
		});
	});

	updateLabels();
})();
