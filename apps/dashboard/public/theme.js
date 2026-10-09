// Runs before first paint (external, so the page CSP needs no inline script): apply the saved theme.
(function () {
  try {
    var t = localStorage.getItem("hippo:theme");
    if (t === "parchment" || t === "candlelit") document.documentElement.setAttribute("data-theme", t);
  } catch (e) {}
})();
