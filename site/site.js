// Kotisivun kielivalinta ja yhteydenottolomake.
(function () {
  "use strict";

  document.getElementById("year").textContent = String(new Date().getFullYear());
  document.documentElement.classList.add("js");

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Osiot ilmestyvät pehmeästi, kun ne tulevat näkyviin.
  var revealed = document.querySelectorAll("[data-reveal]");
  if ("IntersectionObserver" in window && !reduceMotion) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          revealObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    revealed.forEach(function (element) { revealObserver.observe(element); });
  } else {
    revealed.forEach(function (element) { element.classList.add("in"); });
  }

  // Avauskuva on aluksi kallellaan ja oikenee vieritettäessä.
  var tilted = document.querySelector("[data-tilt] img");
  if (tilted && !reduceMotion) {
    var tiltFrame = 0;
    var updateTilt = function () {
      tiltFrame = 0;
      var rect = tilted.getBoundingClientRect();
      var height = window.innerHeight;
      var progress = Math.min(1, Math.max(0, (rect.top - height * 0.2) / (height * 0.6)));
      tilted.style.setProperty("--tilt", progress.toFixed(3));
    };
    window.addEventListener("scroll", function () { if (!tiltFrame) tiltFrame = requestAnimationFrame(updateTilt); }, { passive: true });
    window.addEventListener("resize", updateTilt);
    updateTilt();
  }

  // Näkyykö elementti ruudulla; automaattinen vaihto pysähtyy, kun osio ei näy.
  function watchVisibility(element, callback) {
    if (!("IntersectionObserver" in window)) return callback(true);
    new IntersectionObserver(function (entries) { callback(entries[0].isIntersecting); }, { threshold: 0.25 }).observe(element);
  }

  // Tuotekierros: välilehti vaihtaa kuvan, ja välilehdet vaihtuvat itsestään edistymispalkin tahdissa.
  var tour = document.querySelector("[data-tour]");
  if (tour) {
    var tabs = Array.prototype.slice.call(tour.querySelectorAll('[role="tab"]'));
    var TOUR_MS = 6500;
    var current = 0;
    var started = 0;
    var elapsed = 0;
    var paused = false;
    var visible = false;
    var frame = 0;

    var selectTab = function (index, focus) {
      current = (index + tabs.length) % tabs.length;
      tabs.forEach(function (tab, i) {
        var selected = i === current;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        tab.style.setProperty("--progress", "0");
        document.getElementById(tab.getAttribute("aria-controls")).classList.toggle("active", selected);
      });
      if (focus) tabs[current].focus();
      elapsed = 0;
      started = performance.now();
    };

    var tick = function (now) {
      frame = requestAnimationFrame(tick);
      if (paused || !visible) { started = now - elapsed; return; }
      elapsed = now - started;
      tabs[current].style.setProperty("--progress", Math.min(1, elapsed / TOUR_MS).toFixed(4));
      if (elapsed >= TOUR_MS) selectTab(current + 1, false);
    };

    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () { selectTab(i, false); });
      tab.addEventListener("keydown", function (event) {
        if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); selectTab(current + 1, true); }
        if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); selectTab(current - 1, true); }
      });
    });
    tour.addEventListener("mouseenter", function () { paused = true; });
    tour.addEventListener("mouseleave", function () { paused = false; });
    tour.addEventListener("focusin", function () { paused = true; });
    tour.addEventListener("focusout", function () { paused = false; });
    selectTab(0, false);
    if (!reduceMotion) {
      watchVisibility(tour, function (isVisible) { visible = isVisible; });
      frame = requestAnimationFrame(tick);
    }
  }

  // Asukasportaalin näkymät vaihtuvat puhelimessa itsestään; painikkeesta voi valita näkymän.
  var phone = document.querySelector("[data-phone]");
  if (phone) {
    var screens = phone.querySelectorAll(".phone img");
    var pickers = phone.querySelectorAll(".phone-picker button");
    var shown = 0;
    var timer = 0;
    var phoneVisible = false;
    var show = function (index) {
      shown = (index + screens.length) % screens.length;
      screens.forEach(function (img, i) { img.classList.toggle("active", i === shown); });
      pickers.forEach(function (button, i) { button.setAttribute("aria-pressed", String(i === shown)); });
    };
    var restart = function () {
      clearInterval(timer);
      if (!reduceMotion && phoneVisible) timer = setInterval(function () { show(shown + 1); }, 3200);
    };
    pickers.forEach(function (button, i) {
      button.addEventListener("click", function () { show(i); restart(); });
    });
    watchVisibility(phone, function (isVisible) { phoneVisible = isVisible; restart(); });
  }

  // Korttirivi: nuolipainikkeet ja hiirellä vetäminen.
  var rail = document.querySelector("[data-rail]");
  if (rail) {
    var track = rail.querySelector(".rail-track");
    var step = function () {
      var card = track.querySelector(".card");
      return card ? card.getBoundingClientRect().width + 20 : 320;
    };
    rail.querySelector(".rail-prev").addEventListener("click", function () { track.scrollBy({ left: -step(), behavior: "smooth" }); });
    rail.querySelector(".rail-next").addEventListener("click", function () { track.scrollBy({ left: step(), behavior: "smooth" }); });

    var dragStart = 0;
    var scrollStart = 0;
    var dragging = false;
    track.addEventListener("pointerdown", function (event) {
      if (event.pointerType !== "mouse") return;
      dragging = true;
      dragStart = event.clientX;
      scrollStart = track.scrollLeft;
      track.setPointerCapture(event.pointerId);
    });
    track.addEventListener("pointermove", function (event) {
      if (!dragging) return;
      var distance = event.clientX - dragStart;
      if (Math.abs(distance) > 4) track.classList.add("dragging");
      track.scrollLeft = scrollStart - distance;
    });
    var endDrag = function () {
      if (!dragging) return;
      dragging = false;
      track.classList.remove("dragging");
    };
    track.addEventListener("pointerup", endDrag);
    track.addEventListener("pointercancel", endDrag);
  }


  // Sivun tekstit ovat suomeksi HTML:ssä ja englanniksi data-en-attribuuteissa. Muut tekstit ovat tässä.
  var TEXTS = {
    fi: {
      title: "Pleissi – isännöintitoimiston työkalu asukkaiden yhteydenottoihin",
      description: "Pleissi kokoaa asukkaiden sähköpostit ja portaalin ilmoitukset yhteen jonoon. Jokaisella asialla on käsittelijä, määräaika ja historia, ja vastaus lähtee tutusta osoitteesta.",
      missing: "Täytä nimi ja sähköpostiosoite.",
      sending: "Lähetetään…",
      sent: "Kiitos! Otamme sinuun yhteyttä.",
      tooMany: "Liian monta lähetystä. Yritä hetken kuluttua uudelleen.",
      failed: "Lähetys epäonnistui. Yritä uudelleen tai lähetä sähköpostia."
    },
    en: {
      title: "Pleissi – a tool for property managers to handle resident requests",
      description: "Pleissi gathers resident emails and portal reports into one queue. Every matter has an owner, a deadline and a history, and replies go out from a familiar address.",
      missing: "Fill in your name and email address.",
      sending: "Sending…",
      sent: "Thank you! We will be in touch.",
      tooMany: "Too many submissions. Try again in a moment.",
      failed: "Sending failed. Try again or send us an email."
    }
  };

  var STORAGE_KEY = "kotilo.siteLanguage";
  var language = "fi";

  function stored() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return null;
    }
  }

  function swap(element, attribute, read, write) {
    var english = element.getAttribute(attribute);
    var finnishKey = attribute + "-fi";
    if (!element.hasAttribute(finnishKey)) element.setAttribute(finnishKey, read(element));
    write(element, language === "en" ? english : element.getAttribute(finnishKey));
  }

  function setLanguage(next) {
    language = next === "en" ? "en" : "fi";
    document.documentElement.lang = language;
    document.title = TEXTS[language].title;
    document.querySelector('meta[name="description"]').setAttribute("content", TEXTS[language].description);

    document.querySelectorAll("[data-en]").forEach(function (element) {
      swap(element, "data-en", function (el) { return el.innerHTML; }, function (el, value) { el.innerHTML = value; });
    });
    document.querySelectorAll("[data-en-alt]").forEach(function (element) {
      swap(element, "data-en-alt",
        function (el) { return el.getAttribute("alt"); },
        function (el, value) { el.setAttribute("alt", value); });
    });
    document.querySelectorAll("[data-en-aria-label]").forEach(function (element) {
      swap(element, "data-en-aria-label",
        function (el) { return el.getAttribute("aria-label"); },
        function (el, value) { el.setAttribute("aria-label", value); });
    });
    document.querySelectorAll(".lang button").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-lang") === language));
    });

    // Lomakkeen tilaviesti vaihtuu kielen mukana.
    var status = document.getElementById("contact-status");
    if (status.dataset.key) status.textContent = TEXTS[language][status.dataset.key];

    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch (error) {
      // Selaimen tallennustila ei ole käytössä; valinta säilyy vain tämän käynnin ajan.
    }
  }

  // Yläpalkki saa reunaviivan, kun sivua on vieritetty.
  var top = document.querySelector(".top");
  function markScrolled() { top.classList.toggle("scrolled", window.scrollY > 8); }
  window.addEventListener("scroll", markScrolled, { passive: true });
  markScrolled();

  document.querySelectorAll(".lang button").forEach(function (button) {
    button.addEventListener("click", function () { setLanguage(button.getAttribute("data-lang")); });
  });

  // Ensimmäisellä käynnillä kieli valitaan selaimen kielen mukaan: suomenkieliselle suomi, muille englanti.
  var initial = stored() || ((navigator.language || "fi").toLowerCase().indexOf("fi") === 0 ? "fi" : "en");
  if (initial !== "fi") setLanguage(initial);

  // Yhteydenottolomake lähetetään alustan rajapintaan, joka tallentaa yhteystiedot pääkäyttäjän nähtäväksi.
  var form = document.getElementById("contact-form");
  var statusElement = document.getElementById("contact-status");

  function showStatus(key, kind) {
    statusElement.dataset.key = key;
    statusElement.textContent = TEXTS[language][key];
    statusElement.className = "form-status " + kind;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var data = {};
    new FormData(form).forEach(function (value, key) { data[key] = String(value).trim(); });
    if (!data.name || !/^[^\s<>,;@]+@[^\s<>,;@]+$/.test(data.email)) return showStatus("missing", "error");

    var button = form.querySelector("button[type=submit]");
    button.disabled = true;
    showStatus("sending", "");
    fetch("/api/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
      .then(function (response) {
        if (response.ok) {
          form.reset();
          showStatus("sent", "ok");
        } else {
          showStatus(response.status === 429 ? "tooMany" : response.status === 400 ? "missing" : "failed", "error");
        }
      })
      .catch(function () { showStatus("failed", "error"); })
      .then(function () { button.disabled = false; });
  });
})();
