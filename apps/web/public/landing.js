/* ============================================================
   Intelligence Designed To Evolve — page behaviour
   Vanilla JS. Two jobs: the stat count-up, and the mobile menu.
   ============================================================ */

(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ── Stat count-up ─────────────────────────────────────────
     Runs once, when the stats row is actually on screen. The
     easing is easeOutCubic so the number decelerates into its
     final value rather than stopping dead. */

  function formatValue(value, decimals, suffix) {
    return value.toFixed(decimals) + suffix;
  }

  function countUp(el, index) {
    var target = parseFloat(el.getAttribute("data-target"));
    var decimals = parseInt(el.getAttribute("data-decimals"), 10) || 0;
    var suffix = el.getAttribute("data-suffix") || "";

    if (isNaN(target)) return;

    // Reduced motion gets the answer, not the journey.
    if (reduceMotion) {
      el.textContent = formatValue(target, decimals, suffix);
      return;
    }

    // The markup ships the real figures, so a page whose JS is blocked or
    // broken shows the true numbers instead of a row of zeros presented as
    // metrics. Zeroing here means the animation still starts from nothing,
    // and only ever does so when it is actually about to run.
    el.textContent = formatValue(0, decimals, suffix);

    var duration = 1500 + index * 80;
    var startDelay = 480 + index * 90;

    window.setTimeout(function () {
      var startTime = null;

      function frame(now) {
        if (startTime === null) startTime = now;
        var elapsed = now - startTime;
        var progress = Math.min(elapsed / duration, 1);
        // easeOutCubic
        var eased = 1 - Math.pow(1 - progress, 3);

        el.textContent = formatValue(target * eased, decimals, suffix);

        if (progress < 1) {
          window.requestAnimationFrame(frame);
        } else {
          // Land exactly on the target: the eased value can end a
          // hair short, and "99.98%" instead of "99.99%" is the kind
          // of wrong number nobody notices and everybody quotes.
          el.textContent = formatValue(target, decimals, suffix);
        }
      }

      window.requestAnimationFrame(frame);
    }, startDelay);
  }

  function initStats() {
    var stats = document.getElementById("stats");
    if (!stats) return;

    var values = stats.querySelectorAll(".stat-value");
    if (!values.length) return;

    var started = false;

    function start() {
      if (started) return;
      started = true;
      Array.prototype.forEach.call(values, function (el, index) {
        countUp(el, index);
      });
    }

    if (!("IntersectionObserver" in window)) {
      start();
      return;
    }

    var observer = new IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i += 1) {
          if (entries[i].isIntersecting) {
            start();
            observer.disconnect();
            return;
          }
        }
      },
      { threshold: 0.25 },
    );

    observer.observe(stats);
  }

  /* ── Mobile menu ───────────────────────────────────────────
     The sheet and overlay are `hidden` in the markup, so they are
     out of the accessibility tree until opened rather than merely
     invisible. */

  function initMenu() {
    var burger = document.getElementById("burger");
    var overlay = document.getElementById("menu-overlay");
    var sheet = document.getElementById("mobile-menu");

    if (!burger || !overlay || !sheet) return;

    function setOpen(open) {
      burger.setAttribute("aria-expanded", open ? "true" : "false");
      burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      overlay.hidden = !open;
      sheet.hidden = !open;
      document.body.classList.toggle("menu-open", open);
    }

    function close() {
      setOpen(false);
    }

    burger.addEventListener("click", function () {
      setOpen(burger.getAttribute("aria-expanded") !== "true");
    });

    overlay.addEventListener("click", close);

    // A link that navigates within the page would otherwise leave the
    // sheet covering the thing it scrolled to.
    Array.prototype.forEach.call(sheet.querySelectorAll("a"), function (link) {
      link.addEventListener("click", close);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") close();
    });

    // Crossing back to desktop leaves the sheet stranded over a layout
    // that no longer has a burger to dismiss it with.
    window.addEventListener("resize", function () {
      if (window.innerWidth > 720) close();
    });

    setOpen(false);
  }

  /* ── Background video ──────────────────────────────────────
     `autoplay muted playsinline` covers every browser that allows
     it. Where a policy still blocks playback the poster frame — a
     black background — is the designed fallback, so a rejected
     play() is not an error worth surfacing. */

  function initVideo() {
    var video = document.querySelector(".bg-video");
    if (!video) return;

    if (reduceMotion) {
      video.pause();
      return;
    }

    var attempt = video.play();
    if (attempt && typeof attempt.catch === "function") {
      attempt.catch(function () {
        /* Autoplay declined; the black background stands in. */
      });
    }
  }

  /* ── Scroll reveal ─────────────────────────────────────────
     The class that hides `.reveal` elements is added by this
     script, not by the stylesheet. A browser with no
     IntersectionObserver — or one where this file fails to load —
     therefore shows the sections, rather than a page of invisible
     content that never gets revealed. Hiding first and hoping the
     script arrives is how a landing page ends up blank. */

  function initReveal() {
    var targets = document.querySelectorAll(".reveal");
    if (!targets.length) return;

    if (reduceMotion || !("IntersectionObserver" in window)) return;

    document.documentElement.classList.add("js-reveal");

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          // Once revealed, stay revealed: re-hiding on scroll-up makes the
          // page feel unstable and re-triggers for a reader going back.
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
    );

    Array.prototype.forEach.call(targets, function (el, index) {
      // A short stagger within each group, so a row of cards arrives in
      // sequence rather than all at once.
      // Carried as a class rather than a style property: the Content Security
      // Policy is `style-src 'self'`, and this engine refuses an element style
      // write under it, so every delay set here was blocked and logged while
      // the stagger silently never ran (found by the V045 pass).
      var group = el.closest(".cards, .facts");
      if (group) {
        var position = Array.prototype.indexOf.call(group.children, el);
        if (position > 0 && position <= 6) el.classList.add("rd-" + position);
      }
      void index;
      observer.observe(el);
    });

    // Failsafe. Everything above is hidden by a class this script added, and
    // is revealed only when an observer callback runs. Callbacks do not run in
    // a page the browser is not rendering — a background tab, a hidden frame —
    // and a reader who arrives at such a page finds it blank. After a short
    // wait anything still hidden is shown outright: a missed animation is a
    // cosmetic loss, invisible content is not.
    window.setTimeout(function () {
      Array.prototype.forEach.call(targets, function (el) {
        if (!el.classList.contains("is-visible")) {
          el.classList.add("is-visible");
          observer.unobserve(el);
        }
      });
    }, 2500);
  }

  function init() {
    initStats();
    initMenu();
    initVideo();
    initReveal();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
