// Hamburger trigger + slide-out panel (components/mobile-nav-panel.html):
// aria-expanded toggle, focus trap while open, Escape/outside-tap closes
// and returns focus to the hamburger button. See docs/features/home.md's
// Client-side Behavior.
//
// External file, no inline <script> — see home.md's Security
// Considerations.
(function () {
	'use strict';

	var trigger = document.querySelector('[data-mobile-nav-trigger]');
	var panel = document.querySelector('[data-mobile-nav-panel]');
	if (!trigger || !panel) return;

	var closeBtn = panel.querySelector('[data-mobile-nav-close]');
	var backdrop = panel.querySelector('[data-mobile-nav-backdrop]');
	var content = panel.querySelector('[data-mobile-nav-content]');

	function focusableElements() {
		if (!content) return [];
		return Array.prototype.slice.call(
			content.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')
		);
	}

	function isOpen() {
		return trigger.getAttribute('aria-expanded') === 'true';
	}

	function onKeydown(e) {
		if (e.key === 'Escape') {
			e.preventDefault();
			closePanel();
			return;
		}
		if (e.key === 'Tab') {
			var items = focusableElements();
			if (!items.length) return;
			var first = items[0];
			var last = items[items.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
	}

	// Belt-and-suspenders focus trap: if focus somehow lands outside the
	// panel content while it's open (e.g. a browser extension moving
	// focus), pull it back in.
	function onFocusIn(e) {
		if (content && !content.contains(e.target)) {
			var items = focusableElements();
			if (items.length) items[0].focus();
		}
	}

	function openPanel() {
		trigger.setAttribute('aria-expanded', 'true');
		panel.classList.remove('hidden');
		document.addEventListener('keydown', onKeydown);
		document.addEventListener('focusin', onFocusIn);
		var items = focusableElements();
		if (items.length) items[0].focus();
	}

	function closePanel() {
		trigger.setAttribute('aria-expanded', 'false');
		panel.classList.add('hidden');
		document.removeEventListener('keydown', onKeydown);
		document.removeEventListener('focusin', onFocusIn);
		trigger.focus();
	}

	trigger.addEventListener('click', function () {
		if (isOpen()) {
			closePanel();
		} else {
			openPanel();
		}
	});

	if (closeBtn) closeBtn.addEventListener('click', closePanel);
	if (backdrop) backdrop.addEventListener('click', closePanel);

	// Close automatically once a nav swap completes, so navigating from
	// inside the panel doesn't leave it open over the new page.
	document.body.addEventListener('htmx:afterSwap', function () {
		if (isOpen()) closePanel();
	});
})();
