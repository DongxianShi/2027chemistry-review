const GRAPH = window.NETWORK_DATA;

const nodes = new Map(GRAPH.nodes.map(node => [node.id, node]));
const edges = GRAPH.edges;
const adjacency = new Map();
const historyStack = [];
const pageNodeByPage = new Map();
const pathNodeByKey = new Map();

const CENTERABLE = new Set(["root", "chapter", "module", "section", "type", "summary"]);
const LEAF = new Set(["example", "page"]);
const EXPANDABLE = new Set(["example", "page"]);
const RELATION_ORDER = ["包含", "内容提要", "对应例题", "原页", "原页截图", "相关"];
const COLORS = {
  root: "#4863ff",
  chapter: "#e8eef7",
  module: "#dff7f3",
  section: "#fff2d4",
  type: "#e9f8ef",
  summary: "#eef5ff",
  example: "#ffeef2",
  page: "#f2f4f7"
};

let centerId = GRAPH.rootId;
let selectedId = GRAPH.rootId;
let activeRelation = "all";
let searchQuery = "";
const view = {
  scale: 1,
  tx: 0,
  ty: 0,
  dragging: false,
  dragMoved: false,
  startX: 0,
  startY: 0,
  startTx: 0,
  startTy: 0,
  needsFit: true
};

for (const edge of edges) {
  addAdj(edge.source, edge);
  addAdj(edge.target, edge);
}

for (const node of nodes.values()) {
  if (node.kind === "page" && node.page) pageNodeByPage.set(node.page, node.id);
  if (node.centerable && CENTERABLE.has(node.kind) && node.path && node.path.length) {
    pathNodeByKey.set(pathKey(node.path), node.id);
  }
}

const canvas = document.getElementById("networkCanvas");
const detailPanel = document.getElementById("detailPanel");
const sidePanel = document.getElementById("sidePanel");
const searchPanel = document.getElementById("searchPanel");
const statsLine = document.getElementById("statsLine");
const breadcrumb = document.getElementById("breadcrumb");
const searchInput = document.getElementById("searchInput");
const clearSearch = document.getElementById("clearSearch");
const relationFilters = document.getElementById("relationFilters");
const searchResults = document.getElementById("searchResults");
const pathPanel = document.getElementById("pathPanel");
const togglePathPanel = document.getElementById("togglePathPanel");
let resizeTimer = null;
let stageEl = null;
let lastLayout = null;
let focusedEdgeKey = null;
let expandedNodeId = null;

init();

function init() {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const hashCenter = hash.get("center");
  if (hashCenter && nodes.has(hashCenter) && nodes.get(hashCenter).centerable) {
    centerId = hashCenter;
    selectedId = hashCenter;
  }
  statsLine.textContent = `节点 ${GRAPH.stats.nodes} 个 · 关系 ${GRAPH.stats.edges} 条 · 层级单元 ${GRAPH.stats.hierarchy} 个 · 原页缓存 ${GRAPH.stats.pages} 页`;
  initViewportControls();
  initPanelToggles();
  renderRelationFilters();
  render();

  document.getElementById("homeButton").addEventListener("click", () => focusNode(GRAPH.rootId, false));
  document.getElementById("backButton").addEventListener("click", () => {
    const previous = historyStack.pop();
    if (previous) {
      focusedEdgeKey = null;
      expandedNodeId = null;
      centerId = previous;
      selectedId = previous;
      resetView();
      renderRelationFilters();
      render();
    }
  });
  updatePanelToggleLabels();
  searchInput.addEventListener("input", event => {
    searchQuery = event.target.value.trim();
    renderSearch();
  });
  clearSearch.addEventListener("click", () => {
    searchQuery = "";
    searchInput.value = "";
    renderSearch();
  });
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(render, 120);
  });
}

function addAdj(id, edge) {
  if (!adjacency.has(id)) adjacency.set(id, []);
  adjacency.get(id).push(edge);
}

function renderRelationFilters() {
  const relationCounts = new Map();
  const currentEdges = currentNetworkEdges(centerId);
  for (const edge of currentEdges) {
    const group = relationGroup(edge.relation);
    relationCounts.set(group, (relationCounts.get(group) || 0) + 1);
  }
  if (activeRelation !== "all" && !relationCounts.has(activeRelation)) activeRelation = "all";
  const relations = ["all", "包含", "内容提要", "对应例题", "原页", "相关主线"]
    .filter(relation => relation === "all" || relationCounts.has(relation));
  relationFilters.innerHTML = "";
  relations.forEach(relation => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "filter-button";
    if (activeRelation === relation) btn.classList.add("active");
    btn.textContent = relation === "all" ? `全部 ${currentEdges.length}` : `${relation} ${relationCounts.get(relation)}`;
    btn.addEventListener("click", () => {
      setActiveRelation(relation);
    });
    relationFilters.appendChild(btn);
  });
}

function setActiveRelation(relation) {
  if (activeRelation === relation) return;
  clearFilterVisualState();
  focusedEdgeKey = null;
  expandedNodeId = null;
  activeRelation = relation;
  renderRelationFilters();
  render();
}

function clearFilterVisualState() {
  canvas.querySelectorAll(".filter-muted").forEach(el => el.classList.remove("filter-muted"));
  canvas.querySelectorAll(".edge-muted").forEach(el => {
    el.classList.remove("edge-muted");
    el.classList.add("edge-active");
    el.setAttribute("marker-end", "url(#arrow-main)");
  });
  canvas.querySelectorAll(".edge-label-muted").forEach(el => el.classList.remove("edge-label-muted"));
}

function currentNetworkEdges(id) {
  const directEdges = filteredEdges(adjacency.get(id) || []);
  const neighbors = uniqueNeighborIds(id, directEdges);
  const visible = new Set([id, ...neighbors]);
  return edges
    .filter(edge => edgeVisibleInNetwork(edge, id, visible))
    .slice(0, 220);
}

function render() {
  renderBreadcrumb();
  const layout = buildLayout(centerId);
  lastLayout = layout;
  canvas.innerHTML = "";

  const stage = document.createElement("div");
  stage.className = "graph-stage";
  if (expandedNodeId) stage.classList.add("has-expansion");
  stage.style.width = `${layout.width}px`;
  stage.style.height = `${layout.height}px`;
  stageEl = stage;
  if (view.needsFit) fitViewToLayout(layout);
  applyViewTransform();

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "edge-layer");
  svg.setAttribute("width", layout.width);
  svg.setAttribute("height", layout.height);
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  svg.appendChild(renderArrowMarkers());
  const nodeIdsToDraw = layout.nodeIds;
  const labelBoxes = nodeIdsToDraw
    .map(id => layout.positions.get(id))
    .filter(Boolean)
    .map(box => ({ x: box.x - 18, y: box.y - 18, w: box.w + 36, h: box.h + 36 }));
  labelBoxes.push(...panelBoxes());
  const edgePlans = layout.edges.map((edge, index) => edgePlan(edge, layout.positions, index));
  const mutedEdgePlans = edgePlans.filter(plan => edgeMutedForState(layout, plan));
  const activeEdgePlans = edgePlans.filter(plan => !edgeMutedForState(layout, plan));
  const pathObstacles = buildPathObstacles(edgePlans);
  const pathLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  pathLayer.setAttribute("class", "edge-path-layer");
  const labelLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  labelLayer.setAttribute("class", "edge-label-layer");
  [...mutedEdgePlans, ...activeEdgePlans].forEach((plan, index) => {
    const muted = edgeMutedForState(layout, plan);
    const focused = focusedEdgeKey === plan.key;
    const rendered = renderEdge(plan, labelBoxes, pathObstacles, muted);
    if (focused) {
      rendered.pathGroup.classList.add("edge-focused-group");
      rendered.labelGroup.classList.add("edge-label-focused");
    }
    const edgeDelay = Math.min(index * 12, 260);
    rendered.pathGroup.style.setProperty("--edge-delay", `${edgeDelay}ms`);
    rendered.labelGroup.style.setProperty("--label-delay", `${edgeDelay + 80}ms`);
    pathLayer.appendChild(rendered.pathGroup);
    labelLayer.appendChild(rendered.labelGroup);
  });
  svg.append(pathLayer, labelLayer);
  stage.appendChild(svg);

  const mutedNodeIds = nodeIdsToDraw.filter(id => nodeMutedForState(layout, id));
  const activeNodeIds = nodeIdsToDraw.filter(id => !nodeMutedForState(layout, id));
  [...mutedNodeIds, ...activeNodeIds].forEach((id, index) => {
    const nodeEl = renderNode(id, layout.positions.get(id), layout.roles.get(id), nodeMutedForState(layout, id));
    if (focusedEdgeKey && !nodeMutedForState(layout, id)) nodeEl.classList.add("edge-focus-node");
    nodeEl.style.setProperty("--node-delay", `${Math.min(index * 18, 320)}ms`);
    stage.appendChild(nodeEl);
  });
  if (expandedNodeId && layout.positions.has(expandedNodeId)) {
    stage.appendChild(renderInlineExpansion(expandedNodeId, layout));
  }
  canvas.appendChild(stage);
  renderDetail(selectedId);
}

function nodeMutedForFilter(layout, id) {
  return activeRelation !== "all" && id !== centerId && !layout.matches.nodes.has(id);
}

function edgeMutedForFilter(layout, plan) {
  return activeRelation !== "all" && !layout.matches.edges.has(plan.key);
}

function focusedEdge() {
  if (!focusedEdgeKey) return null;
  return edges.find(edge => edgeKey(edge) === focusedEdgeKey) || null;
}

function nodeMutedForState(layout, id) {
  const edge = focusedEdge();
  if (edge) return id !== edge.source && id !== edge.target;
  if (expandedNodeId) return !nodeConnectedToExpanded(id);
  return nodeMutedForFilter(layout, id);
}

function edgeMutedForState(layout, plan) {
  if (focusedEdgeKey) return plan.key !== focusedEdgeKey;
  if (expandedNodeId) return plan.edge.source !== expandedNodeId && plan.edge.target !== expandedNodeId;
  return edgeMutedForFilter(layout, plan);
}

function nodeConnectedToExpanded(id) {
  if (!expandedNodeId) return false;
  if (id === expandedNodeId) return true;
  return (adjacency.get(expandedNodeId) || []).some(edge => edge.source === id || edge.target === id);
}

function initPanelToggles() {
  if (togglePathPanel) {
    togglePathPanel.addEventListener("click", () => {
      pathPanel.classList.toggle("collapsed");
      updatePanelToggleLabels();
      view.needsFit = true;
      render();
    });
  }
  document.getElementById("toggleSearchPanel").addEventListener("click", () => {
    searchPanel.classList.toggle("collapsed");
    updatePanelToggleLabels();
  });
  document.getElementById("toggleSidePanel").addEventListener("click", () => {
    sidePanel.classList.toggle("collapsed");
    updatePanelToggleLabels();
    view.needsFit = true;
    render();
  });
}

function updatePanelToggleLabels() {
  const searchBtn = document.getElementById("toggleSearchPanel");
  const sideBtn = document.getElementById("toggleSidePanel");
  const pathBtn = document.getElementById("togglePathPanel");
  if (pathBtn) {
    const collapsed = pathPanel.classList.contains("collapsed");
    pathBtn.textContent = collapsed ? "⌘ 展开路径" : "⌘ 收起路径";
    pathBtn.title = collapsed ? "展开路径显示" : "收起路径显示";
  }
  if (searchBtn) {
    const collapsed = searchPanel.classList.contains("collapsed");
    searchBtn.textContent = collapsed ? "⌕ 展开搜索" : "⌕ 收起搜索";
    searchBtn.title = collapsed ? "展开搜索栏目" : "收起搜索栏目";
  }
  if (sideBtn) {
    const collapsed = sidePanel.classList.contains("collapsed");
    sideBtn.textContent = collapsed ? "☷ 展开" : "☷ 收起";
    sideBtn.title = collapsed ? "展开关系类型栏目" : "收起关系类型栏目";
  }
  const detailBtn = document.getElementById("toggleDetailPanel");
  if (detailBtn) {
    const collapsed = detailPanel.classList.contains("collapsed");
    detailBtn.textContent = collapsed ? "◎ 展开" : "◎ 收起";
    detailBtn.title = collapsed ? "展开当前中心栏目" : "收起当前中心栏目";
  }
}

function renderArrowMarkers() {
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.appendChild(createArrowMarker("arrow-main", "rgba(128, 230, 255, 0.9)"));
  defs.appendChild(createArrowMarker("arrow-muted", "rgba(92, 118, 124, 0.54)"));
  return defs;
}

function createArrowMarker(id, fill) {
  const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  marker.setAttribute("id", id);
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "9");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "8");
  marker.setAttribute("markerHeight", "8");
  marker.setAttribute("markerUnits", "userSpaceOnUse");
  marker.setAttribute("orient", "auto");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  path.setAttribute("fill", fill);
  marker.appendChild(path);
  return marker;
}

function initViewportControls() {
  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const worldX = (mouseX - view.tx) / view.scale;
    const worldY = (mouseY - view.ty) / view.scale;
    const factor = event.deltaY < 0 ? 1.1 : 0.9;
    const nextScale = clamp(view.scale * factor, 0.58, 2.05);
    view.tx = mouseX - worldX * nextScale;
    view.ty = mouseY - worldY * nextScale;
    view.scale = nextScale;
    applyViewTransform();
  }, { passive: false });

  canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.target.closest(".net-node, .inline-expansion, .side-panel, .detail-panel, input, button, .edge-click-target")) return;
    view.dragging = true;
    view.dragMoved = false;
    view.startX = event.clientX;
    view.startY = event.clientY;
    view.startTx = view.tx;
    view.startTy = view.ty;
    canvas.classList.add("dragging");
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", event => {
    if (!view.dragging) return;
    const dx = event.clientX - view.startX;
    const dy = event.clientY - view.startY;
    if (Math.hypot(dx, dy) > 3) view.dragMoved = true;
    view.tx = view.startTx + dx;
    view.ty = view.startTy + dy;
    applyViewTransform();
  });

  canvas.addEventListener("pointerup", event => endDrag(event));
  canvas.addEventListener("pointercancel", event => endDrag(event));
}

function endDrag(event) {
  if (!view.dragging) return;
  view.dragging = false;
  canvas.classList.remove("dragging");
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (!view.dragMoved && (focusedEdgeKey || expandedNodeId) && !event.target.closest(".net-node, .inline-expansion, .side-panel, .detail-panel, input, button, .edge-click-target")) {
    focusedEdgeKey = null;
    expandedNodeId = null;
    render();
  }
}

function applyViewTransform() {
  if (!stageEl) return;
  stageEl.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
}

function resetView() {
  view.scale = 0.9;
  view.tx = 0;
  view.ty = 0;
  view.needsFit = true;
  applyViewTransform();
}

function fitViewToLayout(layout) {
  const safe = viewSafeScreenRect();
  const bounds = layoutContentBounds(layout);
  const availableW = Math.max(520, safe.w);
  const availableH = Math.max(420, safe.h);
  const scale = clamp(Math.min(availableW / bounds.w, availableH / bounds.h), 0.3, 0.96);
  view.scale = scale;
  view.tx = safe.left + (safe.w - bounds.w * scale) / 2 - bounds.left * scale;
  view.ty = safe.top + (safe.h - bounds.h * scale) / 2 - bounds.top * scale;
  view.needsFit = false;
}

function layoutContentBounds(layout) {
  const boxes = [...layout.positions.values()];
  const pad = 76;
  const left = Math.max(0, Math.min(...boxes.map(box => box.x)) - pad);
  const top = Math.max(0, Math.min(...boxes.map(box => box.y)) - pad);
  const right = Math.min(layout.width, Math.max(...boxes.map(box => box.x + box.w)) + pad);
  const bottom = Math.min(layout.height, Math.max(...boxes.map(box => box.y + box.h)) + pad);
  return { left, top, right, bottom, w: right - left, h: bottom - top };
}

function viewSafeScreenRect() {
  const canvasRect = canvas.getBoundingClientRect();
  const safe = {
    left: 18,
    top: 14,
    right: canvasRect.width - 18,
    bottom: canvasRect.height - 14
  };
  [sidePanel, detailPanel].forEach(panel => {
    if (!panel || panel.classList.contains("collapsed")) return;
    const rect = panel.getBoundingClientRect();
    const left = rect.left - canvasRect.left;
    const right = rect.right - canvasRect.left;
    const midpoint = canvasRect.width / 2;
    if (left < midpoint) safe.left = Math.max(safe.left, right + 18);
    else safe.right = Math.min(safe.right, left - 18);
  });
  if (safe.right - safe.left < 480) {
    safe.left = 18;
    safe.right = canvasRect.width - 18;
  }
  safe.w = safe.right - safe.left;
  safe.h = safe.bottom - safe.top;
  return safe;
}

function panelBoxes() {
  const canvasRect = canvas.getBoundingClientRect();
  return [document.querySelector(".side-panel"), detailPanel]
    .filter(Boolean)
    .map(panel => panel.getBoundingClientRect())
    .map(rect => ({
      x: (rect.left - canvasRect.left - view.tx - 6) / view.scale,
      y: (rect.top - canvasRect.top - view.ty - 6) / view.scale,
      w: (rect.width + 12) / view.scale,
      h: (rect.height + 12) / view.scale
    }));
}

function buildLayout(id) {
  const center = nodes.get(id);
  const directEdges = filteredEdges(adjacency.get(id) || []);
  const neighbors = uniqueNeighborIds(id, directEdges);
  const roles = buildNodeRoles(id, neighbors, directEdges);
  const rect = canvas.getBoundingClientRect();
  const baseWidth = Math.max(760, Math.floor(rect.width || window.innerWidth - 28));
  const baseHeight = Math.max(560, Math.floor(rect.height || window.innerHeight - 150));
  const spread = layoutSpread(neighbors.length);
  const width = Math.round(baseWidth * spread);
  const height = Math.round(baseHeight * Math.max(1.14, spread * 0.9));
  const safe = safeRect(width, height);
  const cx = safe.left + safe.w / 2;
  const cy = safe.top + safe.h / 2;
  const scale = layoutScale(neighbors.length, width, height);
  const positions = new Map();
  const centerSize = sizeFor(center, true, scale, "center");
  positions.set(id, {
    x: clamp(cx - centerSize.w / 2, safe.left, safe.right - centerSize.w),
    y: clamp(cy - centerSize.h / 2, safe.top, safe.bottom - centerSize.h),
    ...centerSize
  });

  placeRadialNodes(id, neighbors, directEdges, roles, positions, safe, cx, cy, scale);
  relaxPositions([id, ...neighbors], positions, safe, new Set([id]));

  const visible = new Set([id, ...neighbors]);
  const visibleEdges = edges
    .filter(edge => edgeVisibleInNetwork(edge, id, visible))
    .slice(0, 220);
  const matches = buildFilterMatches(visible, visibleEdges);

  return { width, height, positions, roles, matches, nodeIds: [...visible], edges: visibleEdges };
}

function edgeVisibleInNetwork(edge, id, visible) {
  if (!visible.has(edge.source) || !visible.has(edge.target)) return false;
  return edge.source === id || edge.target === id || relationGroup(edge.relation) === "相关主线";
}

function buildFilterMatches(visible, visibleEdges) {
  if (activeRelation === "all") {
    return {
      nodes: new Set(visible),
      edges: new Set(visibleEdges.map(edgeKey))
    };
  }
  const matchedNodes = new Set([centerId]);
  const matchedEdges = new Set();
  visibleEdges.forEach(edge => {
    if (relationGroup(edge.relation) !== activeRelation) return;
    matchedEdges.add(edgeKey(edge));
    matchedNodes.add(edge.source);
    matchedNodes.add(edge.target);
  });
  return { nodes: matchedNodes, edges: matchedEdges };
}

function buildNodeRoles(center, ids, directEdges) {
  const roles = new Map([[center, "center"]]);
  ids.forEach(id => roles.set(id, nodeRole(center, id, directEdges)));
  return roles;
}

function nodeRole(center, id, directEdges) {
  const related = directEdges.filter(edge => (edge.source === center && edge.target === id) || (edge.source === id && edge.target === center));
  if (related.some(edge => edge.relation === "包含" && edge.source === center)) return "contained";
  if (related.some(edge => edge.relation === "包含" && edge.target === center)) return "parent";
  if (related.some(edge => ["内容提要", "对应例题", "原页", "原页截图"].includes(edge.relation))) return "support";
  return "related";
}

function layoutSpread(count) {
  if (count > 38) return 3.05;
  if (count > 30) return 2.68;
  if (count > 22) return 2.34;
  if (count > 14) return 1.98;
  if (count > 8) return 1.58;
  return 1.42;
}

function filteredEdges(edgeList) {
  return edgeList
    .sort((a, b) => edgePriority(b) - edgePriority(a))
    .slice(0, 42);
}

function uniqueNeighborIds(id, directEdges) {
  const result = [];
  const seen = new Set();
  for (const edge of directEdges) {
    const other = edge.source === id ? edge.target : edge.source;
    if (!seen.has(other) && nodes.has(other)) {
      seen.add(other);
      result.push(other);
    }
  }
  return result;
}

function groupNeighbors(center, ids, directEdges) {
  const edgeByOther = new Map();
  for (const edge of directEdges) edgeByOther.set(edge.source === center ? edge.target : edge.source, edge);
  const left = [];
  const right = [];
  const top = [];
  const bottom = [];

  ids.forEach(id => {
    const node = nodes.get(id);
    const edge = edgeByOther.get(id);
    if (edge && edge.relation === "包含" && edge.target === center) left.push(id);
    else if (edge && ["包含", "内容提要", "对应例题", "原页", "原页截图"].includes(edge.relation)) right.push(id);
    else if (node.kind === "page" || node.kind === "example") bottom.push(id);
    else top.push(id);
  });
  return { left, right, top, bottom };
}

function safeRect(width, height) {
  const wide = width >= 1180;
  const left = wide ? 234 : 24;
  const rightGap = wide ? 330 : 24;
  const right = width - rightGap;
  const top = 22;
  const bottom = height - 22;
  if (right - left < 520) {
    return { left: 24, top, right: width - 24, bottom, w: width - 48, h: bottom - top };
  }
  return { left, top, right, bottom, w: right - left, h: bottom - top };
}

function layoutScale(count, width, height) {
  const areaPressure = Math.max(0, count - 12) * 0.012;
  const widthPressure = width < 1150 ? 0.08 : 0;
  const heightPressure = height < 700 ? 0.06 : 0;
  return clamp(1 - areaPressure - widthPressure - heightPressure, 0.72, 1);
}

function placeRadialNodes(center, ids, directEdges, roles, positions, safe, cx, cy, scale) {
  if (!ids.length) return;
  const ordered = orderedNeighbors(center, ids, directEdges);
  const rings = splitRings(ordered);
  const ringCount = rings.length;

  rings.forEach((ringIds, ringIndex) => {
    const ringRatio = ringCount === 1 ? 0.9 : ringIndex === 0 ? 0.64 : 0.97;
    const rx = Math.max(170, safe.w * ringRatio * 0.5);
    const ry = Math.max(145, safe.h * ringRatio * 0.5);
    const offset = ringIndex === 0 ? 0 : 0.5;
    ringIds.forEach((nodeId, idx) => {
      const node = nodes.get(nodeId);
      const size = sizeFor(node, false, scale, roles.get(nodeId));
      const angle = angleForNode(center, nodeId, directEdges, idx, ringIds.length, offset);
      const x = cx + Math.cos(angle) * rx - size.w / 2;
      const y = cy + Math.sin(angle) * ry - size.h / 2;
      positions.set(nodeId, {
        x: clamp(x, safe.left, safe.right - size.w),
        y: clamp(y, safe.top, safe.bottom - size.h),
        ...size
      });
    });
  });
}

function orderedNeighbors(center, ids, directEdges) {
  const edgeByOther = new Map();
  for (const edge of directEdges) edgeByOther.set(edge.source === center ? edge.target : edge.source, edge);
  return [...ids].sort((a, b) => {
    const rank = neighborRank(center, edgeByOther.get(a), nodes.get(a)) - neighborRank(center, edgeByOther.get(b), nodes.get(b));
    if (rank !== 0) return rank;
    return String(nodes.get(a).title).localeCompare(String(nodes.get(b).title), "zh-Hans-CN");
  });
}

function neighborRank(center, edge, node) {
  if (edge && edge.relation === "包含" && edge.target === center) return 0;
  if (edge && edge.relation === "包含") return 1;
  if (edge && edge.relation === "内容提要") return 2;
  if (node.kind === "summary") return 3;
  if (node.kind === "example") return 4;
  if (node.kind === "page") return 5;
  return 6;
}

function splitRings(ids) {
  if (ids.length <= 12) return [ids];
  const innerCount = ids.length <= 24 ? Math.ceil(ids.length * 0.46) : Math.ceil(ids.length * 0.38);
  const inner = [];
  const outer = [];
  ids.forEach((id, index) => {
    if (inner.length < innerCount && index % 2 === 0) inner.push(id);
    else outer.push(id);
  });
  ids.forEach(id => {
    if (!inner.includes(id) && !outer.includes(id)) {
      (inner.length < innerCount ? inner : outer).push(id);
    }
  });
  return [inner, outer.filter(Boolean)].filter(ring => ring.length);
}

function angleForNode(center, nodeId, directEdges, idx, count, offset) {
  const edge = directEdges.find(item => (item.source === center && item.target === nodeId) || (item.source === nodeId && item.target === center));
  if (edge && edge.relation === "包含" && edge.target === center) return Math.PI;
  return -Math.PI / 2 + ((idx + offset) / Math.max(1, count)) * Math.PI * 2;
}

function relaxPositions(ids, positions, safe, pinned = new Set()) {
  const ordered = [...ids];
  const pad = 68;
  for (let pass = 0; pass < 28; pass += 1) {
    let moved = false;
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const a = positions.get(ordered[i]);
        const b = positions.get(ordered[j]);
        if (!a || !b || !overlaps(a, b, pad)) continue;
        const acx = a.x + a.w / 2;
        const acy = a.y + a.h / 2;
        const bcx = b.x + b.w / 2;
        const bcy = b.y + b.h / 2;
        const dx = bcx - acx || 1;
        const dy = bcy - acy || 1;
        const len = Math.hypot(dx, dy) || 1;
        const push = 24;
        if (!pinned.has(ordered[i])) {
          a.x = clamp(a.x - (dx / len) * push, safe.left, safe.right - a.w);
          a.y = clamp(a.y - (dy / len) * push, safe.top, safe.bottom - a.h);
        }
        if (!pinned.has(ordered[j])) {
          b.x = clamp(b.x + (dx / len) * push, safe.left, safe.right - b.w);
          b.y = clamp(b.y + (dy / len) * push, safe.top, safe.bottom - b.h);
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function overlaps(a, b, pad) {
  return !(
    a.x + a.w + pad < b.x ||
    b.x + b.w + pad < a.x ||
    a.y + a.h + pad < b.y ||
    b.y + b.h + pad < a.y
  );
}

function overlapPenalty(a, b, pad = 0) {
  const left = Math.max(a.x - pad, b.x);
  const right = Math.min(a.x + a.w + pad, b.x + b.w);
  const top = Math.max(a.y - pad, b.y);
  const bottom = Math.min(a.y + a.h + pad, b.y + b.h);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function outsidePenalty(box, bounds) {
  const left = Math.max(0, bounds.left - box.x);
  const right = Math.max(0, box.x + box.w - bounds.right);
  const top = Math.max(0, bounds.top - box.y);
  const bottom = Math.max(0, box.y + box.h - bounds.bottom);
  return left * box.h + right * box.h + top * box.w + bottom * box.w;
}

function sizeFor(node, isCenter, scale = 1, role = "related") {
  if (isCenter) return scaledSize(230, 86, scale);
  if (role === "contained") return scaledSize(198, 58, scale);
  if (role === "parent") return scaledSize(156, 44, scale);
  if (role === "support") {
    if (node.kind === "page") return scaledSize(118, 38, scale);
    if (node.kind === "example") return scaledSize(164, 46, scale);
    return scaledSize(168, 46, scale);
  }
  return scaledSize(148, 42, scale);
}

function scaledSize(w, h, scale) {
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

function edgePlan(edge, positions, index) {
  const a = positions.get(edge.source);
  const b = positions.get(edge.target);
  const ac = boxCenter(a);
  const bc = boxCenter(b);
  const start = connectionPoint(a, bc.x, bc.y);
  const end = connectionPoint(b, ac.x, ac.y);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const normalX = -dy / len;
  const normalY = dx / len;
  const direct = edge.source === centerId || edge.target === centerId;
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const centerBox = positions.get(centerId);
  const graphCenter = centerBox ? boxCenter(centerBox) : { x: midX, y: midY };
  const outX = midX - graphCenter.x;
  const outY = midY - graphCenter.y;
  const outLen = Math.hypot(outX, outY);
  const lane = (index % 7) - 3;
  const outwardX = outLen > 12 ? outX / outLen : normalX;
  const outwardY = outLen > 12 ? outY / outLen : normalY;
  const semantic = relationGroup(edge.relation) === "相关主线";
  const directLane = lane || (index % 2 ? 1 : -1);
  const directCurve = semantic
    ? Math.min(520, Math.max(180, len * 0.4) + Math.abs(lane) * 34)
    : Math.min(160, Math.max(62, len * 0.15) + Math.abs(lane) * 14);
  const indirectCurve = semantic
    ? Math.min(980, Math.max(420, len * 0.92) + Math.abs(lane) * 86)
    : Math.min(620, Math.max(260, len * 0.62) + Math.abs(lane) * 52);
  const control = chooseEdgeControl({
    edge,
    positions,
    start,
    end,
    midX,
    midY,
    normalX,
    normalY,
    outwardX,
    outwardY,
    direct,
    directLane,
    directCurve,
    indirectCurve,
    lane
  });
  const labelT = 0.5;
  return {
    edge,
    id: `edge_path_${index}`,
    key: edgeKey(edge),
    start,
    control,
    end,
    direct,
    labelT,
    labelText: relationLabel(edge.relation)
  };
}

function chooseEdgeControl(context) {
  const {
    edge,
    positions,
    start,
    end,
    midX,
    midY,
    normalX,
    normalY,
    outwardX,
    outwardY,
    direct,
    directLane,
    directCurve,
    indirectCurve,
    lane
  } = context;
  const candidates = [];
  const push = (x, y, bias) => candidates.push({ x, y, bias });

  if (direct) {
    const semantic = relationGroup(edge.relation) === "鐩稿叧涓荤嚎";
    const outwardSign = normalX * outwardX + normalY * outwardY >= 0 ? 1 : -1;
    const signs = semantic
      ? [outwardSign, -outwardSign]
      : (directLane >= 0 ? [1, -1] : [-1, 1]);
    const multipliers = [1, 1.45, 1.9, 2.45, 3.05];
    signs.forEach(sign => {
      multipliers.forEach((multiplier, order) => {
        const offset = sign * directCurve * multiplier;
        push(midX + normalX * offset, midY + normalY * offset, order + (sign === signs[0] ? 0 : 0.35));
      });
    });
    push(midX, midY, 8);
  } else {
    const laneOffsets = [lane, lane + 2, lane - 2, lane + 4, lane - 4, 0];
    [1, 1.28, 1.58, 1.94].forEach((multiplier, order) => {
      laneOffsets.forEach((laneOffset, laneOrder) => {
        push(
          midX + outwardX * indirectCurve * multiplier + normalX * laneOffset * 64,
          midY + outwardY * indirectCurve * multiplier + normalY * laneOffset * 64,
          order + laneOrder * 0.08
        );
      });
    });
  }

  let best = candidates[0];
  let bestScore = Infinity;
  candidates.forEach(candidate => {
    const score = edgeControlScore(edge, positions, start, candidate, end) + candidate.bias;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  });
  return { x: best.x, y: best.y };
}

function edgeControlScore(edge, positions, start, control, end) {
  let score = 0;
  for (let i = 2; i < 24; i += 1) {
    const point = quadraticPoint(start, control, end, i / 24);
    positions.forEach((box, id) => {
      if (id === edge.source || id === edge.target) return;
      const pad = 10;
      if (
        point.x >= box.x - pad &&
        point.x <= box.x + box.w + pad &&
        point.y >= box.y - pad &&
        point.y <= box.y + box.h + pad
      ) {
        const center = boxCenter(box);
        const normalized = Math.hypot(point.x - center.x, point.y - center.y) / Math.max(1, Math.hypot(box.w, box.h));
        score += 1000 + (1 - Math.min(1, normalized)) * 500;
      }
    });
  }
  const mid = quadraticPoint(start, control, end, 0.5);
  score += Math.hypot(mid.x - control.x, mid.y - control.y) * 0.001;
  return score;
}

function buildPathObstacles(plans) {
  const obstacles = [];
  plans.forEach(plan => {
    for (let i = 1; i < 28; i += 1) {
      const point = quadraticPoint(plan.start, plan.control, plan.end, i / 28);
      obstacles.push({ x: point.x - 12, y: point.y - 12, w: 24, h: 24, key: plan.key });
    }
  });
  return obstacles;
}

function renderEdge(plan, labelBoxes, pathObstacles, muted = false) {
  const { edge, start, control, end, direct, labelText } = plan;
  const pathGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  pathGroup.dataset.source = edge.source;
  pathGroup.dataset.target = edge.target;
  pathGroup.dataset.relation = edge.relation;
  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.textContent = labelText;
  pathGroup.appendChild(title);

  const hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  hitPath.setAttribute("d", `M ${start.x} ${start.y} Q ${control.x} ${control.y}, ${end.x} ${end.y}`);
  hitPath.setAttribute("class", "edge-click-target");
  hitPath.dataset.source = edge.source;
  hitPath.dataset.target = edge.target;
  hitPath.dataset.relation = edge.relation;
  hitPath.addEventListener("click", event => {
    event.stopPropagation();
    focusedEdgeKey = plan.key;
    expandedNodeId = null;
    selectedId = edge.target === centerId ? edge.source : edge.target;
    render();
  });
  pathGroup.appendChild(hitPath);

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("id", plan.id);
  path.setAttribute("d", `M ${start.x} ${start.y} Q ${control.x} ${control.y}, ${end.x} ${end.y}`);
  path.setAttribute("class", `edge edge-${edgeClass(edge.relation)} ${direct ? "edge-direct" : "edge-indirect"} ${muted ? "edge-muted" : "edge-active"}`);
  path.setAttribute("marker-end", muted ? "url(#arrow-muted)" : "url(#arrow-main)");
  path.dataset.source = edge.source;
  path.dataset.target = edge.target;
  path.dataset.relation = edge.relation;
  pathGroup.appendChild(path);

  const placedLabel = placeLabelOnPath(plan, labelBoxes, pathObstacles);
  const labelGroup = renderEdgeLabel(labelText, placedLabel, muted);
  labelGroup.dataset.source = edge.source;
  labelGroup.dataset.target = edge.target;
  labelGroup.dataset.relation = edge.relation;
  return { pathGroup, labelGroup };
}

function placeLabelOnPath(plan, labelBoxes, pathObstacles) {
  const width = labelWidth(plan.labelText);
  const height = 22;
  const stageBox = stageBoxFromPositions();
  const candidates = labelCandidates(plan);
  let best = null;
  for (const t of candidates) {
    const rawPoint = quadraticPoint(plan.start, plan.control, plan.end, t);
    const tangent = quadraticTangent(plan.start, plan.control, plan.end, t);
    const angle = readableAngle(Math.atan2(tangent.y, tangent.x) * 180 / Math.PI);
    const box = labelAxisBox(rawPoint, width, height, angle);
    const labelScore = labelBoxes.reduce((sum, existing) => sum + overlapPenalty(existing, box, 26), 0);
    const lineScore = pathObstacles.reduce((sum, existing) => {
      if (existing.key === plan.key) return sum;
      return sum + overlapPenalty(existing, box, 22) * 0.75;
    }, 0);
    const stageScore = outsidePenalty(box, stageBox) * 36;
    const endpointScore = (Math.max(0, 0.12 - t) + Math.max(0, t - 0.88)) * 260;
    const driftScore = Math.abs(t - plan.labelT) * 18;
    const score = labelScore * 5 + lineScore + stageScore + endpointScore + driftScore;
    const placed = { x: rawPoint.x, y: rawPoint.y, angle, width, height };
    if (!labelScore && !lineScore && !stageScore) {
      labelBoxes.push(box);
      return placed;
    }
    if (!best || score < best.score) {
      best = { score, box, placed };
    }
  }
  if (best) {
    labelBoxes.push(best.box);
    return best.placed;
  }
  const midpoint = quadraticPoint(plan.start, plan.control, plan.end, plan.labelT);
  const fallback = { x: midpoint.x, y: midpoint.y, angle: 0, width, height };
  labelBoxes.push(labelAxisBox(midpoint, width, height, 0));
  return fallback;
}

function renderEdgeLabel(text, placedLabel, muted) {
  const wrap = document.createElementNS("http://www.w3.org/2000/svg", "g");
  wrap.setAttribute("class", `edge-label-wrap ${muted ? "edge-label-wrap-muted" : ""}`);

  const inner = document.createElementNS("http://www.w3.org/2000/svg", "g");
  inner.setAttribute("transform", `translate(${placedLabel.x} ${placedLabel.y}) rotate(${placedLabel.angle})`);

  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("class", "edge-label-bg");
  bg.setAttribute("x", -placedLabel.width / 2);
  bg.setAttribute("y", -placedLabel.height / 2);
  bg.setAttribute("width", placedLabel.width);
  bg.setAttribute("height", placedLabel.height);
  bg.setAttribute("rx", "5");

  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("x", "0");
  label.setAttribute("y", "0");
  label.setAttribute("class", `edge-label ${muted ? "edge-label-muted" : ""}`);
  label.setAttribute("dominant-baseline", "middle");
  label.textContent = text;

  inner.append(bg, label);
  wrap.appendChild(inner);
  return wrap;
}

function labelWidth(text) {
  return Math.max(38, String(text).length * 10.6 + 16);
}

function labelAxisBox(point, width, height, angle) {
  const radians = Math.abs(angle) * Math.PI / 180;
  const w = Math.abs(Math.cos(radians)) * width + Math.abs(Math.sin(radians)) * height;
  const h = Math.abs(Math.sin(radians)) * width + Math.abs(Math.cos(radians)) * height;
  return { x: point.x - w / 2, y: point.y - h / 2, w, h };
}

function labelCandidates(plan) {
  const values = [0.5, 0.44, 0.56, 0.38, 0.62, 0.32, 0.68, 0.26, 0.74, 0.2, 0.8, 0.14, 0.86];
  for (let value = 0.1; value <= 0.9; value += 0.025) values.push(Number(value.toFixed(3)));
  return values.sort((a, b) => Math.abs(a - plan.labelT) - Math.abs(b - plan.labelT));
}

function readableAngle(angle) {
  let result = angle;
  if (result > 90) result -= 180;
  if (result < -90) result += 180;
  return result;
}

function placeLabel(point, text, labelBoxes, dirX, dirY, positions) {
  const width = Math.min(190, Math.max(30, text.length * 11));
  const height = 16;
  const stageBox = stageBoxFromPositions(positions);
  const distances = [0, 18, 34, 52, 72, 96, -18, -34, -52];
  for (const distance of distances) {
    const candidate = {
      x: clamp(point.x + dirX * distance, stageBox.left + 12 + width / 2, stageBox.right - 12 - width / 2),
      y: clamp(point.y + dirY * distance, stageBox.top + 18, stageBox.bottom - 20)
    };
    const box = { x: candidate.x - width / 2, y: candidate.y - height + 2, w: width, h: height };
    if (!labelBoxes.some(existing => overlaps(existing, box, 3))) {
      labelBoxes.push(box);
      return candidate;
    }
  }
  const fallback = { x: point.x, y: point.y };
  labelBoxes.push({ x: fallback.x - width / 2, y: fallback.y - height + 2, w: width, h: height });
  return fallback;
}

function stageBoxFromPositions() {
  if (lastLayout) {
    return {
      left: 24,
      top: 22,
      right: lastLayout.width - 24,
      bottom: lastLayout.height - 22,
      w: lastLayout.width - 48,
      h: lastLayout.height - 44
    };
  }
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(760, Math.floor(rect.width || window.innerWidth - 28));
  const height = Math.max(560, Math.floor(rect.height || window.innerHeight - 150));
  return { left: 24, top: 22, right: width - 24, bottom: height - 22, w: width - 48, h: height - 44 };
}

function boxCenter(box) {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function connectionPoint(box, towardX, towardY) {
  const center = boxCenter(box);
  const dx = towardX - center.x;
  const dy = towardY - center.y;
  if (!dx && !dy) return center;
  const scale = Math.min(
    Math.abs((box.w / 2) / (dx || 0.0001)),
    Math.abs((box.h / 2) / (dy || 0.0001))
  );
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

function quadraticPoint(start, control, end, t) {
  const one = 1 - t;
  return {
    x: one * one * start.x + 2 * one * t * control.x + t * t * end.x,
    y: one * one * start.y + 2 * one * t * control.y + t * t * end.y
  };
}

function quadraticTangent(start, control, end, t) {
  return {
    x: 2 * (1 - t) * (control.x - start.x) + 2 * t * (end.x - control.x),
    y: 2 * (1 - t) * (control.y - start.y) + 2 * t * (end.y - control.y)
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function renderNode(id, pos, role = "related", muted = false) {
  const node = nodes.get(id);
  const card = document.createElement("button");
  card.type = "button";
  card.className = `net-node net-${node.kind} role-${role}`;
  if (muted) card.classList.add("filter-muted");
  if (id === centerId) card.classList.add("center");
  if (id === selectedId) card.classList.add("selected");
  if (id === expandedNodeId) card.classList.add("expanded-source");
  if (nodeMatchesSearch(node)) card.classList.add("match");
  card.title = node.title;
  card.dataset.id = id;
  card.dataset.kind = node.kind;
  card.style.left = `${pos.x}px`;
  card.style.top = `${pos.y}px`;
  card.style.width = `${pos.w}px`;
  card.style.height = `${pos.h}px`;
  card.style.background = nodeBackground(node, role);

  const title = document.createElement("span");
  title.className = "node-title";
  title.innerHTML = searchQuery ? highlightTermHTML(node.title) : escapeHtml(node.title);
  card.appendChild(title);

  const kind = document.createElement("span");
  kind.className = "node-kind";
  kind.textContent = node.kindLabel || node.kind;
  card.appendChild(kind);

  card.addEventListener("click", () => {
    focusedEdgeKey = null;
    selectedId = id;
    if (node.centerable && id !== centerId && CENTERABLE.has(node.kind)) focusNode(id, true);
    else if (EXPANDABLE.has(node.kind)) openLeafNode(id, { toggle: true, focusHost: false });
    else renderDetail(id, true);
  });

  return card;
}

function nodeBackground(node, role) {
  if (role === "center") return COLORS.root;
  if (role === "contained") return "#dff7f3";
  if (role === "parent") return "#dce8f4";
  if (role === "support") {
    if (node.kind === "example") return "#ffeef2";
    if (node.kind === "page") return "#eef1f4";
    return "#eef5ff";
  }
  return "#f1eadb";
}

function renderDetail(id, forceOpen = false) {
  const node = nodes.get(id) || nodes.get(centerId);
  const wasCollapsed = detailPanel.classList.contains("collapsed");
  detailPanel.innerHTML = "";
  detailPanel.classList.toggle("collapsed", forceOpen ? false : wasCollapsed);

  const head = document.createElement("div");
  head.className = "panel-head";
  const heading = document.createElement("strong");
  heading.textContent = "当前中心";
  const toggle = document.createElement("button");
  toggle.id = "toggleDetailPanel";
  toggle.className = "panel-toggle";
  toggle.type = "button";
  toggle.addEventListener("click", () => {
    detailPanel.classList.toggle("collapsed");
    updatePanelToggleLabels();
    view.needsFit = true;
    render();
  });
  head.append(heading, toggle);
  detailPanel.appendChild(head);

  const body = document.createElement("div");
  body.className = "detail-body";
  const h = document.createElement("h2");
  h.textContent = node.title;
  body.appendChild(h);

  const meta = document.createElement("div");
  meta.className = "meta-line";
  meta.textContent = `${node.kindLabel || node.kind}${node.page ? ` · 书内页 ${node.page}` : ""}`;
  body.appendChild(meta);

  const centerTip = document.createElement("div");
  centerTip.className = "detail-actions";
  if (node.centerable && CENTERABLE.has(node.kind)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = id === centerId ? "当前中心" : "切换为中心";
    btn.disabled = id === centerId;
    btn.addEventListener("click", () => focusNode(id, true));
    centerTip.appendChild(btn);
  }
  body.appendChild(centerTip);

  const text = node.text || "该节点主要作为关系入口，点击周围节点继续切换中心或查看例题、原页。";
  body.appendChild(renderTextBlock(text));

  if (node.kind === "page" && node.image) body.appendChild(renderPageImage(node));
  const examples = relatedExamples(node.id);
  const pages = relatedPages(node);
  if (examples.length) body.appendChild(renderNodeLinks("对应例题", examples, "example"));
  if (node.kind !== "page" && pages.length) body.appendChild(renderPageLinks(pages));
  detailPanel.appendChild(body);
  updatePanelToggleLabels();
}

function relatedExamples(id) {
  const result = [];
  const seen = new Set();
  for (const edge of adjacency.get(id) || []) {
    const otherId = edge.source === id ? edge.target : edge.source;
    const other = nodes.get(otherId);
    if (!other || other.kind !== "example" || seen.has(otherId)) continue;
    seen.add(otherId);
    result.push(otherId);
  }
  return result.slice(0, 24);
}

function relatedPages(node) {
  const result = new Set();
  [node.pages, node.summaryPages, node.examplePages].forEach(list => {
    if (Array.isArray(list)) list.forEach(page => result.add(page));
  });
  if (node.page) result.add(node.page);
  for (const edge of adjacency.get(node.id) || []) {
    const otherId = edge.source === node.id ? edge.target : edge.source;
    const other = nodes.get(otherId);
    if (other && other.kind === "page" && other.page) result.add(other.page);
  }
  return [...result].filter(Boolean).sort((a, b) => a - b);
}

function renderNodeLinks(title, ids, kind) {
  const wrap = document.createElement("div");
  wrap.className = `resource-links ${kind || ""}`;
  const label = document.createElement("strong");
  label.textContent = title;
  wrap.appendChild(label);
  const list = document.createElement("div");
  list.className = "resource-link-list";
  ids.forEach(id => {
    const node = nodes.get(id);
    if (!node) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = node.title;
    btn.title = node.title;
    btn.addEventListener("click", () => {
      if (EXPANDABLE.has(node.kind)) openLeafNode(id, { toggle: false, focusHost: true });
      else {
        selectedId = id;
        focusedEdgeKey = null;
        expandedNodeId = null;
        renderDetail(id, true);
      }
    });
    list.appendChild(btn);
  });
  wrap.appendChild(list);
  return wrap;
}

function renderPageLinks(pages) {
  const wrap = document.createElement("div");
  wrap.className = "resource-links page-links";
  const label = document.createElement("strong");
  label.textContent = "关联原页";
  wrap.appendChild(label);

  const summary = document.createElement("span");
  summary.className = "resource-summary";
  summary.textContent = compactPages(pages);
  wrap.appendChild(summary);

  const list = document.createElement("div");
  list.className = "resource-link-list";
  [...new Set(pages)].sort((a, b) => a - b).forEach(page => {
    const pageNodeId = pageNodeByPage.get(page);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `第 ${page} 页`;
    btn.disabled = !pageNodeId;
    btn.title = pageNodeId ? `打开第 ${page} 页截图` : `第 ${page} 页截图未生成`;
    btn.addEventListener("click", () => {
      if (!pageNodeId) return;
      openLeafNode(pageNodeId, { toggle: false, focusHost: true });
    });
    list.appendChild(btn);
  });
  wrap.appendChild(list);
  return wrap;
}

function renderTextBlock(text) {
  const wrap = document.createElement("div");
  wrap.className = "text-block";
  cleanDisplayText(text)
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .forEach(line => {
      const div = document.createElement("div");
      div.className = "text-line";
      if (/^注[:：]/.test(line)) div.classList.add("note-line");
      if (/^【?例\d*/.test(line) || /^解析[:：]/.test(line) || /^答案[:：]/.test(line) || /^【反思】/.test(line)) {
        div.classList.add("example-line");
      }
      div.innerHTML = formatChemistry(line);
      wrap.appendChild(div);
    });
  return wrap;
}

function renderPageImage(node) {
  const box = document.createElement("figure");
  box.className = "page-image";
  const img = document.createElement("img");
  img.src = node.image;
  img.alt = node.title;
  const cap = document.createElement("figcaption");
  cap.textContent = `${node.title} 原书截图，可用于核对苯环、结构式、表格和复杂图示。`;
  img.addEventListener("error", () => {
    box.classList.add("missing");
    cap.textContent = `${node.title} 的截图资源未随网站发布，请确认 build/page_images 目录已上传到 GitHub。`;
  });
  box.append(img, cap);
  return box;
}

function openLeafNode(id, options = {}) {
  const node = nodes.get(id);
  if (!node) return;
  const { toggle = true, focusHost = false } = options;
  const host = focusHost ? nearestCenterable(id) : null;

  focusedEdgeKey = null;
  selectedId = id;
  if (host && host !== centerId) {
    if (centerId !== host) historyStack.push(centerId);
    centerId = host;
    resetView();
    window.location.hash = `center=${host}`;
    renderRelationFilters();
  }
  expandedNodeId = expandedNodeId === id && toggle ? null : id;
  render();
}

function renderInlineExpansion(id, layout) {
  const node = nodes.get(id);
  const anchor = layout.positions.get(id);
  const size = expansionSize(node, layout);
  const pos = expansionPosition(anchor, size, layout);

  const card = document.createElement("article");
  card.className = `inline-expansion inline-${node.kind}`;
  card.dataset.id = id;
  card.style.left = `${pos.x}px`;
  card.style.top = `${pos.y}px`;
  card.style.width = `${size.w}px`;
  card.style.minHeight = `${size.h}px`;

  const head = document.createElement("div");
  head.className = "inline-expansion-head";
  const title = document.createElement("div");
  title.className = "inline-expansion-title";
  title.textContent = node.title;
  const close = document.createElement("button");
  close.type = "button";
  close.title = "收起展开内容";
  close.textContent = "×";
  close.addEventListener("click", event => {
    event.stopPropagation();
    expandedNodeId = null;
    render();
  });
  head.append(title, close);
  card.appendChild(head);

  const meta = document.createElement("div");
  meta.className = "inline-expansion-meta";
  meta.textContent = expansionMeta(node);
  card.appendChild(meta);

  if (node.kind === "page") card.appendChild(renderInlinePage(node));
  else card.appendChild(renderInlineExample(node));

  return card;
}

function expansionSize(node, layout) {
  const narrow = layout.width < 1200;
  if (node.kind === "page") return { w: narrow ? 400 : 520, h: narrow ? 540 : 650 };
  return { w: narrow ? 500 : 650, h: narrow ? 360 : 430 };
}

function expansionPosition(anchor, size, layout) {
  const gap = 26;
  const safe = visibleStageRect(layout, size);
  const baseCandidates = [
    { x: anchor.x + anchor.w + gap, y: anchor.y + anchor.h / 2 - size.h / 2 },
    { x: anchor.x - size.w - gap, y: anchor.y + anchor.h / 2 - size.h / 2 },
    { x: anchor.x + anchor.w / 2 - size.w / 2, y: anchor.y + anchor.h + gap },
    { x: anchor.x + anchor.w / 2 - size.w / 2, y: anchor.y - size.h - gap },
    { x: safe.right - size.w, y: safe.top },
    { x: safe.left, y: safe.bottom - size.h }
  ];
  const gridX = [safe.left, safe.left + safe.w * 0.28, safe.left + safe.w * 0.55, safe.right - size.w];
  const gridY = [safe.top, safe.top + safe.h * 0.25, safe.top + safe.h * 0.55, safe.bottom - size.h];
  gridX.forEach(x => gridY.forEach(y => baseCandidates.push({ x, y })));
  const shiftedCandidates = [];
  const shifts = [-140, -90, -45, 0, 45, 90, 140];
  baseCandidates.forEach(candidate => {
    shifts.forEach(dx => shifts.forEach(dy => shiftedCandidates.push({ x: candidate.x + dx, y: candidate.y + dy })));
  });
  const seen = new Set();
  const candidates = shiftedCandidates.map(candidate => ({
    x: clamp(candidate.x, safe.left, safe.right - size.w),
    y: clamp(candidate.y, safe.top, safe.bottom - size.h),
    w: size.w,
    h: size.h
  })).filter(candidate => {
    const key = `${Math.round(candidate.x)}:${Math.round(candidate.y)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const obstacles = [...layout.positions.entries()]
    .filter(([id]) => id !== expandedNodeId)
    .map(([, box]) => box);
  candidates.sort((a, b) => expansionPenalty(a, obstacles, safe) - expansionPenalty(b, obstacles, safe));
  return candidates[0];
}

function visibleStageRect(layout, size) {
  const screen = viewSafeScreenRect();
  let left = (screen.left - view.tx) / view.scale;
  let top = (screen.top - view.ty) / view.scale;
  let right = (screen.right - view.tx) / view.scale;
  let bottom = (screen.bottom - view.ty) / view.scale;
  left = clamp(left, 0, layout.width - 1);
  top = clamp(top, 0, layout.height - 1);
  right = clamp(right, left + 1, layout.width);
  bottom = clamp(bottom, top + 1, layout.height);
  if (right - left < size.w + 36 || bottom - top < size.h + 36) {
    return safeRect(layout.width, layout.height);
  }
  return { left, top, right, bottom, w: right - left, h: bottom - top };
}

function expansionPenalty(box, obstacles, safe) {
  return outsidePenalty(box, safe) * 8 + obstacles.reduce((sum, obstacle) => sum + overlapPenalty(box, obstacle, 18), 0);
}

function expansionMeta(node) {
  if (node.kind === "page") return `书内页 ${node.page} · 原页截图`;
  const pages = Array.isArray(node.pages) && node.pages.length ? compactPages(node.pages) : "未定位";
  return `例题截图 · 来源页 ${pages}`;
}

function renderInlinePage(node) {
  const figure = document.createElement("figure");
  figure.className = "inline-media inline-page-frame";
  const img = document.createElement("img");
  img.src = node.image;
  img.alt = `${node.title} 原页截图`;
  const cap = document.createElement("figcaption");
  cap.textContent = "完整原页截图";
  img.addEventListener("error", () => {
    figure.classList.add("missing");
    cap.textContent = "原页截图未随网站发布，请确认 build/page_images 已上传。";
  });
  figure.append(img, cap);
  return figure;
}

function renderInlineExample(node) {
  const crop = exampleCropSpec(node);
  if (!crop) {
    const fallback = document.createElement("div");
    fallback.className = "inline-text-fallback";
    fallback.appendChild(renderTextBlock(node.text || "该例题暂无可定位截图。"));
    return fallback;
  }

  const figure = document.createElement("figure");
  figure.className = "inline-media inline-example-crop";
  const frame = document.createElement("div");
  frame.className = "crop-frame";
  frame.dataset.cropStart = crop.startRatio;
  frame.dataset.cropEnd = crop.endRatio;

  const img = document.createElement("img");
  img.src = crop.image;
  img.alt = `${node.title} 对应页局部截图`;
  img.addEventListener("load", () => fitCropFrame(frame, img));
  img.addEventListener("error", () => {
    figure.classList.add("missing");
    frame.textContent = "例题截图未随网站发布，请确认 build/page_images 已上传。";
  });
  frame.appendChild(img);

  const cap = document.createElement("figcaption");
  cap.textContent = `第 ${crop.page} 页 OCR 定位局部`;
  figure.append(frame, cap);
  requestAnimationFrame(() => fitCropFrame(frame, img));
  return figure;
}

function fitCropFrame(frame, img) {
  if (!img.naturalWidth || !frame.clientWidth) return;
  const startRatio = Number(frame.dataset.cropStart) || 0;
  const endRatio = Number(frame.dataset.cropEnd) || 1;
  const scaledHeight = img.naturalHeight * (frame.clientWidth / img.naturalWidth);
  const start = clamp(startRatio * scaledHeight, 0, Math.max(0, scaledHeight - 120));
  const end = clamp(endRatio * scaledHeight, start + 150, scaledHeight);
  const height = clamp(end - start, 220, Math.min(500, Math.max(240, scaledHeight - start)));
  frame.style.height = `${height}px`;
  img.style.transform = `translateY(${-start}px)`;
}

function exampleCropSpec(node) {
  const page = Array.isArray(node.pages) && node.pages.length ? node.pages[0] : null;
  const pageNode = page ? nodes.get(pageNodeByPage.get(page)) : null;
  if (!pageNode || !pageNode.image) return null;
  const pageLines = textLines(pageNode.text);
  const exampleLines = textLines(node.text);
  if (!pageLines.length || !exampleLines.length) {
    return { page, image: pageNode.image, startRatio: 0.08, endRatio: 0.92 };
  }

  const startLine = exampleLines.find(line => /^【?例\d+】?/.test(line)) || exampleLines[0];
  let startIndex = findLineIndex(pageLines, startLine, 0);
  if (startIndex < 0) startIndex = findLineIndex(pageLines, exampleLines[0], 0);
  if (startIndex < 0) startIndex = Math.max(0, Math.floor(pageLines.length * 0.58));

  const lastLine = [...exampleLines].reverse().find(line => normalizedLine(line).length >= 8) || exampleLines[exampleLines.length - 1];
  const lastIndex = findLineIndex(pageLines, lastLine, startIndex);
  const nextBoundary = pageLines.findIndex((line, index) => index > startIndex + 2 && isExampleBoundary(line));
  let endIndex = lastIndex > startIndex ? lastIndex + 2 : nextBoundary > startIndex ? nextBoundary - 1 : pageLines.length - 1;
  endIndex = clamp(endIndex, startIndex + 4, pageLines.length - 1);

  const bodyStart = 0.055;
  const bodyRange = 0.89;
  const startRatio = clamp(bodyStart + (startIndex / pageLines.length) * bodyRange - 0.016, 0, 0.92);
  const endRatio = clamp(bodyStart + ((endIndex + 1) / pageLines.length) * bodyRange + 0.045, startRatio + 0.18, 1);
  return { page, image: pageNode.image, startRatio, endRatio };
}

function textLines(text) {
  return cleanDisplayText(text)
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !/^\d{3}$/.test(line));
}

function findLineIndex(lines, target, fromIndex = 0) {
  const wanted = normalizedLine(target);
  if (!wanted) return -1;
  let best = -1;
  let bestScore = 0;
  lines.forEach((line, index) => {
    if (index < fromIndex) return;
    const current = normalizedLine(line);
    if (!current) return;
    const score = lineMatchScore(current, wanted);
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return bestScore >= 0.48 ? best : -1;
}

function lineMatchScore(line, target) {
  if (line.includes(target) || target.includes(line)) return 1;
  const shortTarget = target.slice(0, Math.min(18, target.length));
  if (shortTarget.length >= 6 && line.includes(shortTarget)) return 0.86;
  let hits = 0;
  const step = Math.max(2, Math.floor(target.length / 8));
  for (let i = 0; i < target.length; i += step) {
    const token = target.slice(i, i + step);
    if (token.length >= 2 && line.includes(token)) hits += 1;
  }
  return hits / Math.max(1, Math.ceil(target.length / step));
}

function normalizedLine(line) {
  return String(line || "")
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9ⅠⅡⅢⅣⅤⅥIVX√×()+\-+=]/g, "")
    .toLowerCase();
}

function isExampleBoundary(line) {
  return /^类型/.test(line) || /^【?例\d+】?/.test(line) || /^【反思】/.test(line);
}

function focusNode(id, pushHistory) {
  if (!nodes.has(id)) return;
  focusedEdgeKey = null;
  expandedNodeId = null;
  if (pushHistory && centerId !== id) historyStack.push(centerId);
  centerId = id;
  selectedId = id;
  resetView();
  window.location.hash = `center=${id}`;
  renderRelationFilters();
  render();
}

function renderBreadcrumb() {
  const node = nodes.get(centerId);
  breadcrumb.innerHTML = "";
  const path = node.path && node.path.length ? node.path : [node.title];
  const visiblePath = path.slice(-6);
  visiblePath.forEach((part, idx) => {
    const fullIndex = path.length - visiblePath.length + idx;
    const prefix = path.slice(0, fullIndex + 1);
    const targetId = pathNodeByKey.get(pathKey(prefix));
    const item = document.createElement(targetId ? "button" : "span");
    item.className = "breadcrumb-item";
    item.textContent = part;
    if (targetId) {
      item.type = "button";
      item.title = `切换到：${part}`;
      item.addEventListener("click", () => {
        focusedEdgeKey = null;
        focusNode(targetId, true);
      });
    }
    breadcrumb.appendChild(item);
    if (idx < visiblePath.length - 1) {
      const sep = document.createElement("b");
      sep.textContent = ">";
      breadcrumb.appendChild(sep);
    }
  });
}

function pathKey(parts) {
  return parts.join("\u001f");
}

function renderSearch() {
  searchResults.innerHTML = "";
  if (!searchQuery) {
    searchResults.innerHTML = '<p class="muted">输入关键词后，可直接跳转到匹配节点。</p>';
    render();
    return;
  }
  const matches = GRAPH.nodes
    .map(node => ({ node, hit: searchHit(node) }))
    .filter(item => item.hit)
    .slice(0, 40);
  if (!matches.length) {
    searchResults.innerHTML = '<p class="muted">未找到匹配节点。</p>';
    render();
    return;
  }
  matches.forEach(({ node, hit }, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "search-result-item";
    btn.style.setProperty("--result-delay", `${Math.min(index * 18, 280)}ms`);

    const title = document.createElement("span");
    title.className = "search-result-title";
    title.innerHTML = highlightTermHTML(node.title);

    const meta = document.createElement("span");
    meta.className = "search-result-meta";
    meta.textContent = node.kindLabel || node.kind;

    const snippet = document.createElement("span");
    snippet.className = "search-result-snippet";
    snippet.innerHTML = `${escapeHtml(hit.label)}：${highlightTermHTML(hit.snippet)}`;

    btn.append(title, meta, snippet);
    btn.addEventListener("click", () => {
      focusedEdgeKey = null;
      if (node.centerable && CENTERABLE.has(node.kind)) {
        focusNode(node.id, true);
        return;
      }
      if (EXPANDABLE.has(node.kind)) {
        openLeafNode(node.id, { toggle: false, focusHost: true });
        return;
      }
      const host = nearestCenterable(node.id);
      if (host && host !== centerId) focusNode(host, true);
      selectedId = node.id;
      expandedNodeId = null;
      renderDetail(node.id, true);
    });
    searchResults.appendChild(btn);
  });
  render();
}

function nearestCenterable(id) {
  const direct = adjacency.get(id) || [];
  for (const edge of direct) {
    const other = edge.source === id ? edge.target : edge.source;
    const node = nodes.get(other);
    if (node && node.centerable && CENTERABLE.has(node.kind)) return other;
  }
  return GRAPH.rootId;
}

function nodeMatchesSearch(node) {
  return Boolean(searchHit(node));
}

function searchHit(node) {
  const query = searchQuery.trim();
  if (!query) return null;
  const fields = [
    { label: "标题", value: node.title || "" },
    { label: "正文", value: cleanDisplayText(node.text || "") },
    { label: "路径", value: (node.path || []).join(" > ") },
    { label: "标签", value: (node.tags || []).join("、") }
  ];
  const q = query.toLowerCase();
  for (const field of fields) {
    const value = String(field.value || "");
    const idx = value.toLowerCase().indexOf(q);
    if (idx >= 0) {
      return { label: field.label, snippet: searchSnippet(value, idx, query.length) };
    }
  }
  return null;
}

function searchSnippet(value, index, length) {
  const radiusBefore = 24;
  const radiusAfter = 38;
  const start = Math.max(0, index - radiusBefore);
  const end = Math.min(value.length, index + length + radiusAfter);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < value.length ? "…" : "";
  return `${prefix}${value.slice(start, end)}${suffix}`;
}

function highlightTermHTML(value) {
  const query = searchQuery.trim();
  const text = String(value || "");
  if (!query) return escapeHtml(text);
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let cursor = 0;
  let html = "";
  while (cursor < text.length) {
    const index = lower.indexOf(q, cursor);
    if (index < 0) {
      html += escapeHtml(text.slice(cursor));
      break;
    }
    html += escapeHtml(text.slice(cursor, index));
    html += `<mark class="search-mark">${escapeHtml(text.slice(index, index + query.length))}</mark>`;
    cursor = index + query.length;
  }
  return html;
}

function cleanDisplayText(text) {
  return String(text || "")
    .replaceAll("NaCI", "NaCl")
    .replaceAll("HCI", "HCl")
    .replaceAll("KCI", "KCl")
    .replaceAll("CI2", "Cl2")
    .replaceAll("SiO:", "SiO2")
    .replaceAll("CO:", "CO2")
    .replaceAll("SO:", "SO2")
    .replaceAll("NO:", "NO2");
}

function formatChemistry(line) {
  const escaped = escapeHtml(line);
  return escaped
    .replace(/([A-Z][a-z]?)(\d+)/g, (_, el, num) => `${el}<sub>${num}</sub>`)
    .replace(/\^(\d*[+-])/g, "<sup>$1</sup>")
    .replace(/([A-Za-z]\))?(\d*[+-])(?=($|[，。；、\s]))/g, match => match)
    .replace(/ΔH/g, "<span class=\"chem-symbol\">ΔH</span>")
    .replace(/ΔG/g, "<span class=\"chem-symbol\">ΔG</span>");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function compactPages(pages) {
  if (!pages || !pages.length) return "";
  const sorted = [...pages].sort((a, b) => a - b);
  const ranges = [];
  sorted.forEach(page => {
    const last = ranges[ranges.length - 1];
    if (!last || page > last[1] + 1) ranges.push([page, page]);
    else last[1] = page;
  });
  return ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join("、");
}

function relationRank(relation) {
  const idx = RELATION_ORDER.indexOf(relation);
  return idx >= 0 ? idx : 99;
}

function relationGroup(relation) {
  if (relation === "包含") return "包含";
  if (relation === "内容提要") return "内容提要";
  if (relation === "对应例题") return "对应例题";
  if (relation.includes("原页")) return "原页";
  return "相关主线";
}

function edgePriority(edge) {
  return (edge.strength || 1) * 10 - relationRank(edge.relation);
}

function edgeKey(edge) {
  return `${edge.source}\u0000${edge.relation}\u0000${edge.target}`;
}

function relationLabel(relation) {
  const labels = {
    "包含": "包含",
    "内容提要": "内容提要",
    "对应例题": "对应例题",
    "原页": "原页 OCR",
    "原页截图": "原页截图",
    "守恒与氧化还原计算互通": "守恒与氧化还原计算互通",
    "浓度与水溶液平衡计算": "浓度与水溶液平衡计算",
    "离子反应延伸到离子平衡": "离子反应延伸到离子平衡",
    "电子转移进入电化学": "电子转移进入电化学",
    "金属元素进入工艺流程": "金属元素进入工艺流程",
    "非金属元素进入工艺流程": "非金属元素进入工艺流程",
    "结构决定有机性质": "结构决定有机性质",
    "反应原理支撑工业条件": "反应原理支撑工业条件",
    "实验验证金属化合物性质": "实验验证金属化合物性质",
    "实验验证非金属化合物性质": "实验验证非金属化合物性质",
    "阿伏加德罗常数依托化学计量": "阿伏加德罗常数依托化学计量",
    "化学用语支撑离子方程式": "化学用语支撑离子方程式",
    "生活材料联系元素化合物": "生活材料联系元素化合物"
  };
  return labels[relation] || relation;
}

function edgeClass(relation) {
  if (relation === "包含") return "hierarchy";
  if (relation.includes("例题")) return "example";
  if (relation.includes("原页")) return "page";
  if (relation.includes("内容提要")) return "summary";
  return "semantic";
}
