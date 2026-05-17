(function bootChemistryKnowledgeBase() {
  const scripts = [
    "js/theme.js",
    "js/library.js",
    "js/search.js",
    "js/detail.js",
    "js/doc-mode.js",
    "js/graph.js"
  ];

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.defer = false;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`无法加载脚本：${src}`));
      document.head.appendChild(script);
    });
  }

  scripts
    .reduce((chain, src) => chain.then(() => loadScript(src)), Promise.resolve())
    .catch(error => {
      console.error(error);
      const stats = document.getElementById("statsLine");
      if (stats) stats.textContent = "脚本加载失败，请检查 GitHub Pages 文件路径。";
    });
})();
