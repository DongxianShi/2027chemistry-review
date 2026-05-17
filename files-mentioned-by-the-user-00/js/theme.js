(function registerThemeModule() {
  const storageKey = "chem-review-theme";

  function set(theme, button) {
    const next = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(storageKey, next);
    if (button) button.textContent = next === "light" ? "浅色" : "深色";
  }

  function init(button) {
    const saved = localStorage.getItem(storageKey);
    const preferredLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
    set(saved || (preferredLight ? "light" : "dark"), button);
  }

  window.ChemKBTheme = { init, set };
})();
