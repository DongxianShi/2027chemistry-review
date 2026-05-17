(function registerDetailModule() {
  const sections = {
    core: "核心概念",
    exam: "常考方式",
    traps: "易错点",
    related: "关联知识"
  };

  function kindLabel(kind) {
    const labels = {
      root: "总复习框架",
      chapter: "章节",
      module: "模块",
      section: "小节",
      type: "题型/考点",
      summary: "内容提要",
      example: "例题",
      page: "原书页"
    };
    return labels[kind] || "知识节点";
  }

  window.ChemKBDetail = { sections, kindLabel };
})();
