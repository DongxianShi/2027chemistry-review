(function registerSearchModule() {
  function normalize(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function includes(value, query) {
    const q = normalize(query);
    return q ? normalize(value).includes(q) : false;
  }

  window.ChemKBSearch = { normalize, includes };
})();
