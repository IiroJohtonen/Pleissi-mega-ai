// Kotisivun kielivalinta ja yhteydenottolomake.
(function () {
  "use strict";

  document.getElementById("year").textContent = String(new Date().getFullYear());

  // Sivun tekstit ovat suomeksi HTML:ssä ja englanniksi data-en-attribuuteissa. Muut tekstit ovat tässä.
  var TEXTS = {
    fi: {
      title: "Kotilo – isännöintitoimiston työkalu asukkaiden yhteydenottoihin",
      description: "Kotilo kokoaa asukkaiden sähköpostit ja portaalin ilmoitukset yhteen jonoon, auttaa vastaamaan niihin ja hoitaa taloyhtiön varaukset, tiedotteet ja ilmoitukset.",
      missing: "Täytä nimi ja sähköpostiosoite.",
      sending: "Lähetetään…",
      sent: "Kiitos! Otamme sinuun yhteyttä.",
      tooMany: "Liian monta lähetystä. Yritä hetken kuluttua uudelleen.",
      failed: "Lähetys epäonnistui. Yritä uudelleen tai lähetä sähköpostia."
    },
    en: {
      title: "Kotilo – a tool for property managers to handle resident requests",
      description: "Kotilo brings resident emails and portal reports into one queue, helps you reply to them and handles the housing company's bookings, announcements and notices.",
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
