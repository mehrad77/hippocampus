// Runs before first paint (external, so the page CSP needs no inline script): apply this browser's
// look, color mode and text size from Setup & health → Personalization. Plain is the default look.
(function () {
  var root = document.documentElement;
  function get(k) {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  }
  var look = get("hippo:look");
  var mode = get("hippo:theme");
  if (mode === "parchment") mode = "light";
  if (mode === "candlelit") mode = "dark";
  if (look === "codex") root.setAttribute("data-style", "codex");
  if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode);
  if (get("hippo:text") === "large") root.setAttribute("data-text", "large");
  var codexTitle = root.getAttribute("data-title-codex");
  if (look === "codex" && codexTitle) document.title = codexTitle;
})();
