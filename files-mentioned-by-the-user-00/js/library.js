(function registerLibraryModule() {
  function card({ title, meta, body, actions }) {
    const article = document.createElement("article");
    article.className = "resource-card";

    const h = document.createElement("h3");
    h.textContent = title;
    article.appendChild(h);

    const info = document.createElement("div");
    info.className = "resource-card-meta";
    info.textContent = meta;
    article.appendChild(info);

    const p = document.createElement("p");
    p.textContent = body;
    article.appendChild(p);

    const actionWrap = document.createElement("div");
    actionWrap.className = "resource-card-actions";
    actions.forEach(action => actionWrap.appendChild(action));
    article.appendChild(actionWrap);
    return article;
  }

  function actionButton(label, onClick, options = {}) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.disabled = Boolean(options.disabled);
    if (options.title) btn.title = options.title;
    if (!btn.disabled && onClick) btn.addEventListener("click", onClick);
    return btn;
  }

  function actionLink(label, href, options = {}) {
    const link = document.createElement("a");
    link.textContent = label;
    link.href = href;
    if (options.target) link.target = options.target;
    if (options.rel) link.rel = options.rel;
    if (options.download) link.download = options.download;
    return link;
  }

  window.ChemKBLibrary = { card, actionButton, actionLink };
})();
