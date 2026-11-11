// Language switch for the /ai-omr-agnostic/ pages. Loaded in <head> (blocking) so the page
// never flashes the other language. Elements carry data-l="en" or data-l="zh".
(function () {
  var KEY = "aiomr_lang", root = document.documentElement, lang = "zh";
  try { lang = localStorage.getItem(KEY) || "zh"; } catch (e) {}
  root.setAttribute("data-lang", lang === "en" ? "en" : "zh");
  var css = document.createElement("style");
  css.textContent = 'html[data-lang="zh"] [data-l="en"],html[data-lang="en"] [data-l="zh"]{display:none!important}' +
    '.lang-btn{padding:3px 10px;border:1px solid currentColor;border-radius:999px;cursor:pointer}';
  document.head.appendChild(css);
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".lang-btn");
    if (!b) return;
    e.preventDefault();
    var next = root.getAttribute("data-lang") === "zh" ? "en" : "zh";
    root.setAttribute("data-lang", next);
    try { localStorage.setItem(KEY, next); } catch (err) {}
  });
})();
