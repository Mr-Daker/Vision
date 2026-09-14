/* ============================================================
   Sign in — the real demonstration login (roadmap V016).
   Reads the principals the server actually offers and exchanges
   the chosen credential for a session, then hands off to the app.
   It does not invent accounts, and it says on the page that no
   identity is verified.
   ============================================================ */

(function () {
  "use strict";

  var list = document.getElementById("principal-list");
  var error = document.getElementById("form-error");
  if (!list) return;

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  function clearError() {
    error.hidden = true;
    error.textContent = "";
  }

  function readCookie(name) {
    var match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : undefined;
  }

  function signIn(credential, button) {
    clearError();
    button.disabled = true;
    button.classList.add("is-busy");

    // The CSRF cookie is readable by design; the header must match it (V009).
    var csrf = readCookie("vision_csrf");
    var headers = { "content-type": "application/json" };
    if (csrf) headers["x-csrf-token"] = csrf;

    fetch("/v1/auth/demo-login", {
      method: "POST",
      credentials: "same-origin",
      headers: headers,
      body: JSON.stringify({ credential: credential }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error("http_" + response.status);
        return response.json();
      })
      .then(function () {
        window.location.href = "app.html";
      })
      .catch(function () {
        button.disabled = false;
        button.classList.remove("is-busy");
        // No provider text is echoed: an error body can quote the request.
        showError("That account could not be signed in just now. Try again, or choose another.");
      });
  }

  function render(principals) {
    list.setAttribute("aria-busy", "false");
    list.replaceChildren();

    if (!principals.length) {
      var empty = document.createElement("p");
      empty.className = "principal-loading";
      empty.textContent = "No demonstration accounts are configured on this server.";
      list.append(empty);
      return;
    }

    principals.forEach(function (principal) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "principal";

      var label = document.createElement("span");
      label.className = "principal-label";
      label.textContent = principal.label;

      var meta = document.createElement("span");
      meta.className = "principal-meta";
      // The issuer is named rather than hidden: it is the thing that makes
      // the simulation checkable rather than merely asserted.
      meta.textContent = principal.issuer;

      // Without this the accessible name is the two spans concatenated —
      // "Demo citizen 1vision-simulated-demo-issuer" — which is what a screen
      // reader would announce.
      button.setAttribute(
        "aria-label",
        "Continue as " + principal.label + ", issued by " + principal.issuer,
      );
      button.append(label, meta);
      button.addEventListener("click", function () {
        signIn(principal.credential, button);
      });
      list.append(button);
    });
  }

  fetch("/v1/capabilities", { credentials: "same-origin" })
    .then(function (response) {
      if (!response.ok) throw new Error("http_" + response.status);
      return response.json();
    })
    .then(function (payload) {
      var principals = (payload && payload.demo_principals) || [];
      render(
        principals.filter(function (p) {
          // Only offer what can actually be used. A revoked credential in the
          // list is a button that fails after the person has committed to it.
          return p && p.credential && p.credential_state === "active";
        }),
      );
    })
    .catch(function () {
      list.setAttribute("aria-busy", "false");
      list.replaceChildren();
      showError(
        "The demonstration accounts could not be loaded. The API may not be running on this origin.",
      );
    });
})();
