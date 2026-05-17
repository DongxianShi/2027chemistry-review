(function registerDocModeModule() {
  let activeId = null;

  function render(options) {
    const {
      nodes,
      edges,
      rootId,
      selectedId,
      centerId,
      elements,
      displayTitle,
      nodePath,
      childrenOf,
      relatedExamples,
      relatedPages,
      pageNodeByPage,
      onSelect,
      onOpenGraph,
      onOpenLeaf
    } = options;
    if (!elements?.panel || !elements.article || !elements.toc || !elements.related) return;

    const selected = nodes.get(selectedId);
    const center = nodes.get(centerId);
    const fallback = nodes.get(rootId);
    const current = selected?.centerable ? selected : center?.centerable ? center : fallback;
    activeId = activeId && nodes.has(activeId) ? activeId : current.id;
    if (current?.id && selected?.centerable) activeId = current.id;

    const active = nodes.get(activeId) || current || fallback;
    renderToc({ nodes, rootId, active, childrenOf, displayTitle, onSelect, toc: elements.toc });
    renderArticle({ nodes, active, childrenOf, displayTitle, nodePath, article: elements.article, onSelect, onOpenGraph });
    renderRelated({
      nodes,
      active,
      displayTitle,
      relatedExamples,
      relatedPages,
      pageNodeByPage,
      onSelect,
      onOpenGraph,
      onOpenLeaf,
      related: elements.related
    });
  }

  function renderToc({ rootId, active, childrenOf, displayTitle, onSelect, toc }) {
    toc.innerHTML = "";
    const chapters = childrenOf(rootId, "chapter");
    chapters.forEach(chapter => {
      const details = document.createElement("details");
      details.className = "doc-mode-toc-section";
      details.open = sameBranch(active, chapter);

      const summary = document.createElement("summary");
      summary.textContent = displayTitle(chapter);
      details.appendChild(summary);

      const chapterBtn = tocButton("章节总览", active.id === chapter.id, () => onSelect(chapter.id));
      details.appendChild(chapterBtn);

      childrenOf(chapter.id, "module").forEach(module => {
        details.appendChild(tocButton(displayTitle(module), active.id === module.id, () => onSelect(module.id)));
        childrenOf(module.id, "section").slice(0, 8).forEach(section => {
          details.appendChild(tocButton(`　${displayTitle(section)}`, active.id === section.id, () => onSelect(section.id)));
        });
      });
      toc.appendChild(details);
    });
  }

  function renderArticle({ active, childrenOf, displayTitle, nodePath, article, onSelect, onOpenGraph }) {
    article.innerHTML = "";

    const path = document.createElement("div");
    path.className = "doc-pathline";
    path.textContent = nodePath(active).join(" / ");
    article.appendChild(path);

    const h = document.createElement("h2");
    h.textContent = displayTitle(active);
    article.appendChild(h);

    const lead = document.createElement("p");
    lead.className = "doc-lead";
    lead.textContent = docLead(active);
    article.appendChild(lead);

    const actions = document.createElement("div");
    actions.className = "doc-actions";
    actions.appendChild(action("在知识图谱中查看", () => onOpenGraph(active.id)));
    article.appendChild(actions);

    if (active.text) {
      article.appendChild(sectionBlock("核心概念", textItems(active.text, 8), true));
    }

    const childSections = childrenOf(active.id, "section");
    const childTypes = childrenOf(active.id, "type");
    const childSummaries = childrenOf(active.id, "summary");
    const childModules = childrenOf(active.id, "module");

    if (childModules.length) {
      article.appendChild(linkBlock("本章模块", childModules, displayTitle, onSelect));
    }
    if (childSections.length) {
      article.appendChild(linkBlock("小节结构", childSections, displayTitle, onSelect));
    }
    if (childTypes.length) {
      article.appendChild(linkBlock("题型与易错点", childTypes, displayTitle, onSelect));
    }
    if (childSummaries.length) {
      article.appendChild(linkBlock("内容提要", childSummaries.slice(0, 18), displayTitle, onSelect));
    }

    article.appendChild(sectionBlock("复习建议", [
      "先用章节模式读清楚概念边界，再切到知识图谱查看跨模块联系。",
      "遇到公式、图示、结构式和实验装置时，优先打开原书页截图核对版面。",
      "题型训练不要只看答案，要把条件、模型、守恒关系和易错点一起整理。"
    ]));
  }

  function renderRelated({ active, displayTitle, relatedExamples, relatedPages, pageNodeByPage, onOpenGraph, onOpenLeaf, related }) {
    related.innerHTML = "";
    const title = document.createElement("div");
    title.className = "doc-related-title";
    title.textContent = "本页相关";
    related.appendChild(title);

    related.appendChild(action("切到图谱中心", () => onOpenGraph(active.id), "wide"));

    const examples = relatedExamples(active.id).slice(0, 10);
    if (examples.length) {
      related.appendChild(relatedList("相关题型/例题", examples.map(id => ({
        label: displayTitle(nodes.get(id) || { title: id }),
        onClick: () => onOpenLeaf(id)
      }))));
    }

    const pages = relatedPages(active).slice(0, 18);
    if (pages.length) {
      related.appendChild(relatedList("对应原书页", pages.map(page => {
        const pageNodeId = pageNodeByPage.get(page);
        return {
          label: `第 ${page} 页高清截图`,
          disabled: !pageNodeId,
          onClick: () => pageNodeId && onOpenLeaf(pageNodeId)
        };
      })));
    }
  }

  function sameBranch(active, chapter) {
    return Array.isArray(active.path) && active.path.includes(chapter.title);
  }

  function tocButton(label, active, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = active ? "active" : "";
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function action(label, onClick, modifier = "") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = modifier ? `doc-action ${modifier}` : "doc-action";
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function linkBlock(title, items, displayTitle, onSelect) {
    const block = document.createElement("section");
    block.className = "doc-section";
    const h = document.createElement("h3");
    h.textContent = title;
    block.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "doc-link-grid";
    items.forEach(item => grid.appendChild(action(displayTitle(item), () => onSelect(item.id))));
    block.appendChild(grid);
    return block;
  }

  function sectionBlock(title, items, collapsible = false) {
    const block = document.createElement("section");
    block.className = "doc-section";
    const h = document.createElement("h3");
    h.textContent = title;
    block.appendChild(h);
    const list = document.createElement("ul");
    list.className = "doc-list";
    const visible = collapsible && items.length > 8 ? items.slice(0, 8) : items;
    visible.forEach(item => {
      const li = document.createElement("li");
      li.textContent = item;
      list.appendChild(li);
    });
    block.appendChild(list);
    if (visible.length < items.length) {
      const details = document.createElement("details");
      details.className = "doc-more";
      const summary = document.createElement("summary");
      summary.textContent = "展开全部内容";
      details.appendChild(summary);
      const more = document.createElement("ul");
      more.className = "doc-list";
      items.slice(visible.length).forEach(item => {
        const li = document.createElement("li");
        li.textContent = item;
        more.appendChild(li);
      });
      details.appendChild(more);
      block.appendChild(details);
    }
    return block;
  }

  function relatedList(title, items) {
    const block = document.createElement("section");
    block.className = "doc-related-section";
    const h = document.createElement("h3");
    h.textContent = title;
    block.appendChild(h);
    items.forEach(item => {
      const btn = action(item.label, item.onClick);
      btn.disabled = Boolean(item.disabled);
      block.appendChild(btn);
    });
    return block;
  }

  function docLead(node) {
    const type = window.ChemKBDetail?.kindLabel(node.kind) || node.kindLabel || node.kind;
    if (node.kind === "chapter") return `${type}。先建立本章主线，再进入模块、题型和原书页核对。`;
    if (node.kind === "module") return `${type}。适合按“概念边界、常考方式、易错点、例题核对”的顺序复习。`;
    if (node.kind === "summary") return `${type}。这是从原书内容提要中抽出的知识单元，适合配合高清原页校对。`;
    if (node.kind === "type") return `${type}。建议先看核心条件，再做对应例题训练。`;
    return `${type}。本页会尽量把正文、关联资源和图谱入口放在同一个阅读上下文中。`;
  }

  function textItems(text, limit) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map(line => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter(line => !/^【书内页\d+】$/.test(line));
    return dedupe(lines).slice(0, Math.max(limit, 1) * 3);
  }

  function dedupe(items) {
    const seen = new Set();
    return items.filter(item => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  }

  function setActive(id) {
    activeId = id;
  }

  window.ChemKBDocMode = { render, setActive };
})();
