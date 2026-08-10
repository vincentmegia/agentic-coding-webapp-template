// Landing page image carousel (components/carousel.html): autoplay timer,
// three independent pause sources (hover/focus, user toggle, offscreen),
// roving-tabindex dot navigation, keyboard arrows, and touch swipe. Moves
// the same opacity/z-index/aria-hidden classes and attributes the server
// renders for the crossfade transition — never restructures the DOM. See
// docs/features/landing-carousel.md's "Implementation Contract (DOM /
// Data)" and "Client-side Behavior (non-HTMX)" sections, which this file
// implements exactly.
//
// External file, no inline <script> — see landing-carousel.md's Security
// Considerations.
(function () {
	'use strict';

	var root = document.getElementById('carousel');
	if (!root) return;

	var track = document.getElementById('carousel-track');
	var slides = Array.prototype.slice.call(root.querySelectorAll('.carousel-slide'));
	if (!slides.length) return;

	var prevBtn = document.getElementById('carousel-prev');
	var nextBtn = document.getElementById('carousel-next');
	var dots = Array.prototype.slice.call(root.querySelectorAll('.carousel-dot'));
	var toggle = document.getElementById('carousel-toggle');

	var total = slides.length;

	// "Image failed to load" state (UI table): hides the broken <img> rather
	// than leaving the browser's broken-image icon visible. #carousel-track
	// already carries a neutral bg-surface-2 background (carousel.html), so
	// hiding the failed image lets that show through underneath — no
	// additional placeholder markup/CSS needed. This can't be an inline
	// onerror="..." attribute: that's still an inline event handler blocked
	// by the same strict CSP that forbids inline <script> tags (see
	// landing-carousel.md's Security Considerations), so it has to be a real
	// addEventListener call from this external file.
	slides.forEach(function (slide) {
		var img = slide.querySelector('img');
		if (!img) return;
		img.addEventListener('error', function () {
			img.style.display = 'none';
		});
	});

	var DEFAULT_INTERVAL_MS = 6000;
	var SWIPE_THRESHOLD_PX = 40;

	// Checked once at init, not reactively — matches the contract's note
	// that this feature doesn't need to react to the preference changing
	// mid-session.
	var reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

	var autoplayInterval = parseInt(root.getAttribute('data-autoplay-interval'), 10);
	if (!autoplayInterval || isNaN(autoplayInterval) || autoplayInterval <= 0) {
		autoplayInterval = DEFAULT_INTERVAL_MS;
	}

	var currentIndex = getInitialIndex();
	var timer = null;

	// Three independent pause flags — the timer only runs when all three
	// are false. hoverPaused itself folds together pointer hover and
	// focus-within (the CSS :hover/:focus-within equivalent), tracked as
	// two booleans so leaving one doesn't clear the other.
	var isHovering = false;
	var isFocusWithin = false;
	var hoverPaused = false;
	var userPaused = false;
	var offscreenPaused = false;

	function getInitialIndex() {
		for (var i = 0; i < slides.length; i++) {
			if (slides[i].classList.contains('opacity-100')) {
				var idx = parseInt(slides[i].getAttribute('data-index'), 10);
				if (!isNaN(idx)) return idx;
			}
		}
		return 1;
	}

	function nextIndexOf(i) {
		return i >= total ? 1 : i + 1;
	}

	function prevIndexOf(i) {
		return i <= 1 ? total : i - 1;
	}

	function setSlideActive(slide, active) {
		if (active) {
			slide.classList.remove('opacity-0', 'z-0', 'pointer-events-none');
			slide.classList.add('opacity-100', 'z-10');
			slide.removeAttribute('aria-hidden');
		} else {
			slide.classList.remove('opacity-100', 'z-10');
			slide.classList.add('opacity-0', 'z-0', 'pointer-events-none');
			slide.setAttribute('aria-hidden', 'true');
		}
	}

	// Mirrors the exact active/inactive utility classes carousel.html
	// renders for dot 1 vs. the rest at initial load — aria-current alone
	// isn't styled by CSS, so without this the dots' active-state size/color
	// would stay stuck on whichever dot the server rendered first.
	function setDotActive(dot, active) {
		if (active) {
			dot.classList.remove('w-2.5', 'bg-line', 'hover:bg-muted');
			dot.classList.add('w-6', 'bg-primary');
			dot.setAttribute('aria-current', 'true');
			dot.setAttribute('tabindex', '0');
		} else {
			dot.classList.remove('w-6', 'bg-primary');
			dot.classList.add('w-2.5', 'bg-line', 'hover:bg-muted');
			dot.removeAttribute('aria-current');
			dot.setAttribute('tabindex', '-1');
		}
	}

	// Moves the same classes/attributes the server renders for the initial
	// state (never restructures the DOM), per the Implementation Contract's
	// crossfade transition mechanism.
	function goToSlide(index) {
		slides.forEach(function (slide) {
			var idx = parseInt(slide.getAttribute('data-index'), 10);
			setSlideActive(slide, idx === index);
		});
		dots.forEach(function (dot) {
			var idx = parseInt(dot.getAttribute('data-index'), 10);
			setDotActive(dot, idx === index);
		});
		currentIndex = index;
	}

	function focusDotAt(index) {
		for (var i = 0; i < dots.length; i++) {
			if (parseInt(dots[i].getAttribute('data-index'), 10) === index) {
				dots[i].focus();
				return;
			}
		}
	}

	function setAriaLive(value) {
		if (track) track.setAttribute('aria-live', value);
	}

	function setToggleState(playing) {
		if (!toggle) return;
		toggle.setAttribute('data-state', playing ? 'playing' : 'paused');
		toggle.setAttribute('aria-label', playing ? 'Pause autoplay' : 'Resume autoplay');
	}

	function computeShouldRun() {
		return total > 1 && !reducedMotion && !hoverPaused && !userPaused && !offscreenPaused;
	}

	// Single source of truth for the actual timer + aria-live + toggle
	// state, called whenever any pause flag changes and after manual
	// navigation. `forceRestart` clears an already-running timer first, so
	// manual navigation resets the interval "from that point" rather than
	// advancing again almost immediately.
	function applyPlayState(forceRestart) {
		var shouldRun = computeShouldRun();
		if (shouldRun) {
			if (timer !== null && forceRestart) {
				window.clearInterval(timer);
				timer = null;
			}
			if (timer === null) {
				timer = window.setInterval(advance, autoplayInterval);
			}
			setAriaLive('off');
			setToggleState(true);
		} else {
			if (timer !== null) {
				window.clearInterval(timer);
				timer = null;
			}
			setAriaLive('polite');
			setToggleState(false);
		}
	}

	function advance() {
		goToSlide(nextIndexOf(currentIndex));
	}

	// Manual navigation (arrow click, dot click, swipe, or keyboard arrows)
	// per the contract: jumps directly to the slide and restarts the
	// autoplay interval if it was running. `focusIndexAfter` is only passed
	// for the roving-tabindex arrow-key-on-a-dot case.
	function manualNavigate(index, focusIndexAfter) {
		goToSlide(index);
		if (typeof focusIndexAfter === 'number') focusDotAt(focusIndexAfter);
		applyPlayState(true);
	}

	if (prevBtn) {
		prevBtn.addEventListener('click', function () {
			manualNavigate(prevIndexOf(currentIndex));
		});
	}

	if (nextBtn) {
		nextBtn.addEventListener('click', function () {
			manualNavigate(nextIndexOf(currentIndex));
		});
	}

	dots.forEach(function (dot) {
		dot.addEventListener('click', function () {
			var idx = parseInt(dot.getAttribute('data-index'), 10);
			if (!isNaN(idx)) manualNavigate(idx);
		});
	});

	// ArrowLeft/ArrowRight navigate whenever focus is anywhere inside
	// #carousel. When focus is specifically on a dot, this doubles as the
	// WAI-ARIA APG roving-tabindex behavior: both the roving tabindex and
	// DOM focus move to the adjacent dot.
	root.addEventListener('keydown', function (e) {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		e.preventDefault();
		var next = e.key === 'ArrowLeft' ? prevIndexOf(currentIndex) : nextIndexOf(currentIndex);
		var onDot = document.activeElement && document.activeElement.classList &&
			document.activeElement.classList.contains('carousel-dot');
		manualNavigate(next, onDot ? next : undefined);
	});

	// Touch swipe: no preventDefault anywhere, and listeners are passive,
	// so a vertical-dominant gesture is left alone to scroll normally.
	var touchStartX = null;
	var touchStartY = null;

	root.addEventListener('touchstart', function (e) {
		if (!e.touches || e.touches.length !== 1) return;
		touchStartX = e.touches[0].clientX;
		touchStartY = e.touches[0].clientY;
	}, { passive: true });

	root.addEventListener('touchend', function (e) {
		if (touchStartX === null || touchStartY === null) return;
		var touch = e.changedTouches && e.changedTouches[0];
		var startX = touchStartX;
		var startY = touchStartY;
		touchStartX = null;
		touchStartY = null;
		if (!touch) return;

		var dx = touch.clientX - startX;
		var dy = touch.clientY - startY;
		if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
		if (Math.abs(dx) <= Math.abs(dy)) return; // vertical-dominant gesture — leave scroll alone

		manualNavigate(dx < 0 ? nextIndexOf(currentIndex) : prevIndexOf(currentIndex));
	}, { passive: true });

	if (reducedMotion) {
		// Skip the crossfade transition entirely, including on manual
		// navigation — inline style rather than guessing/removing whatever
		// exact Tailwind transition-utility classes carousel.html renders,
		// so this doesn't depend on matching class names against the
		// template contract.
		slides.forEach(function (slide) {
			slide.style.transitionDuration = '0s';
		});

		// Autoplay never starts under reduced motion, so there's nothing to
		// toggle — hide the control per the contract rather than wiring any
		// autoplay-related listeners (hover/focus, offscreen, toggle click).
		if (toggle) toggle.classList.add('hidden');
	} else {
		root.addEventListener('mouseenter', function () {
			isHovering = true;
			hoverPaused = isHovering || isFocusWithin;
			applyPlayState();
		});
		root.addEventListener('mouseleave', function () {
			isHovering = false;
			hoverPaused = isHovering || isFocusWithin;
			applyPlayState();
		});
		root.addEventListener('focusin', function () {
			isFocusWithin = true;
			hoverPaused = isHovering || isFocusWithin;
			applyPlayState();
		});
		root.addEventListener('focusout', function (e) {
			if (root.contains(e.relatedTarget)) return;
			isFocusWithin = false;
			hoverPaused = isHovering || isFocusWithin;
			applyPlayState();
		});

		if (window.IntersectionObserver) {
			var observer = new window.IntersectionObserver(function (entries) {
				entries.forEach(function (entry) {
					offscreenPaused = !entry.isIntersecting;
					applyPlayState();
				});
			}, { threshold: 0 });
			observer.observe(root);
		}

		if (toggle) {
			toggle.addEventListener('click', function () {
				userPaused = !userPaused;
				applyPlayState();
			});
		}
	}

	// Reconcile DOM state (dots/aria-hidden) with the detected initial
	// index before wiring up the running/paused state.
	goToSlide(currentIndex);
	applyPlayState();
})();
