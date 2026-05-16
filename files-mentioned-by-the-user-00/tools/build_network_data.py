import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "build" / "extracted_content.json"
OCR_DIR = ROOT / "build" / "page_ocr"
OUT = ROOT / "network_data.js"


TAG_RELATIONS = {
    "守恒与计量": "物质的量与守恒计算",
    "离子与水溶液": "离子反应与水溶液平衡",
    "氧化还原与电化学": "电子转移与电极反应",
    "元素化合物": "元素性质与转化",
    "结构决定性质": "结构解释性质",
    "反应原理": "能量速率平衡调控",
    "有机推断": "官能团与合成推断",
    "实验综合": "实验验证与定量分析",
    "工艺流程": "工业流程综合",
    "化学与生活": "真实情境应用",
    "图像分析": "图像变量关系",
}


COMMON_REPLACEMENTS = [
    ("NaCI", "NaCl"),
    ("KCI", "KCl"),
    ("HCI", "HCl"),
    ("NHCI", "NH4Cl"),
    ("MgCI", "MgCl"),
    ("CaCI", "CaCl"),
    ("BaCI", "BaCl"),
    ("FeCI", "FeCl"),
    ("CuCI", "CuCl"),
    ("AlCI", "AlCl"),
    ("CI2", "Cl2"),
    ("C1", "Cl"),
    ("c1", "Cl"),
    ("NaC1", "NaCl"),
    ("KC1", "KCl"),
    ("HC1", "HCl"),
    ("NH4C1", "NH4Cl"),
    ("H;O", "H2O"),
    ("H,O", "H2O"),
    ("H.O", "H2O"),
    ("CO:", "CO2"),
    ("CO；", "CO2"),
    ("SO:", "SO2"),
    ("NO:", "NO2"),
    ("SiO:", "SiO2"),
    ("SiOz", "SiO2"),
    ("Fe;O,", "Fe2O3"),
    ("Fe;O", "Fe2O3"),
    ("AlOs", "Al2O3"),
    ("AlO;", "Al2O3"),
    ("Na;CO;", "Na2CO3"),
    ("NaCO;", "Na2CO3"),
    ("K;CO;", "K2CO3"),
    ("CaCO;", "CaCO3"),
    ("NaHCO;", "NaHCO3"),
    ("HCO;", "HCO3"),
    ("HNO;", "HNO3"),
    ("H;SO", "H2SO4"),
    ("HSO", "H2SO4"),
    ("SO；-", "SO4^2-"),
    ("SO-）", "SO4^2-)"),
    ("OH-）", "OH-)"),
    ("H+）", "H+)"),
    ("AgNO;", "AgNO3"),
    ("KMnO", "KMnO4"),
    ("KFeO", "K2FeO4"),
    ("Naz", "Na2"),
    ("Na;O", "Na2O"),
    ("NaO", "Na2O"),
    ("NazO2", "Na2O2"),
    ("NaOH", "NaOH"),
    ("BaSO；", "BaSO4"),
    ("CuSO", "CuSO4"),
    ("FeSO", "FeSO4"),
    ("△H", "ΔH"),
    ("AG", "ΔG"),
    ("恰变", "焓变"),
    ("给变", "焓变"),
    ("化学健", "化学键"),
    ("关健", "关键"),
    ("形藏", "形成"),
    ("看点是", "看成是"),
    ("数质", "分散质"),
    ("股体", "胶体"),
    ("离子品体", "离子晶体"),
    ("单度", "单质"),
    ("高子", "离子"),
    ("形藏", "形成"),
    ("热数应", "热效应"),
    ("断聚", "断裂"),
    ("案自", "来自"),
    ("大焰", "火焰"),
]


def clean_text(text: str) -> str:
    if not text:
        return ""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("（X）", "（×）").replace("(X)", "（×）")
    text = text.replace("~", "√").replace("一一", "——")
    text = re.sub(r"[ \t]+", " ", text)
    for old, new in COMMON_REPLACEMENTS:
        text = text.replace(old, new)
    # Fix common OCR of element chlorine in formulas after uppercase/lowercase boundaries.
    text = re.sub(r"([A-Z][a-z]?)C[I1](?=\d|[、，。；;)\]）\s])", r"\1Cl", text)
    text = re.sub(r"\bC[I1](?=\d|[、，。；;)\]）\s])", "Cl", text)
    # Normalize several formula punctuation forms.
    text = re.sub(r"\bCO[,，](?=[与和反应生成，。；、\s])", "CO2", text)
    text = re.sub(r"\bSO[,，](?=[与和反应生成，。；、\s])", "SO2", text)
    text = re.sub(r"\bNO[,，](?=[与和反应生成，。；、\s])", "NO2", text)
    text = re.sub(r"([A-Z][a-z]?)([0-9])\s+([A-Z])", r"\1\2\3", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return "\n".join(line.strip() for line in text.splitlines() if line.strip())


def split_summary_units(text):
    text = clean_text(text)
    lines = text.splitlines()
    units = []
    current = []
    current_title = None

    def is_start(line):
        if line == "内容提要":
            return False
        return bool(
            re.match(r"^[一二三四五六七八九十]+[、.．]", line)
            or re.match(r"^\d+[.．、]", line)
            or re.match(r"^\([1-9]\)", line)
            or line.startswith("注：")
        )

    for line in lines:
        if not current:
            current = [line]
            current_title = line
            continue
        if is_start(line) and len("\n".join(current)) > 120:
            units.append((current_title or current[0], "\n".join(current)))
            current = [line]
            current_title = line
        else:
            current.append(line)
    if current:
        units.append((current_title or current[0], "\n".join(current)))

    compacted = []
    for title, body in units:
        title = title.replace("内容提要", "").strip() or "内容提要"
        title = title[:34] + "..." if len(title) > 34 else title
        compacted.append((title, body))
    return compacted[:18]


def page_text(page):
    path = OCR_DIR / f"page_{page:03d}.json"
    if not path.exists():
        return ""
    data = json.loads(path.read_text(encoding="utf-8"))
    return clean_text(data.get("text", ""))


def node_kind_label(kind):
    return {
        "root": "中心",
        "chapter": "章",
        "module": "模块",
        "section": "节",
        "type": "类型",
    }.get(kind, kind)


def add_node(nodes, node_id, kind, title, centerable=True, **extra):
    if node_id in nodes:
        nodes[node_id].update(extra)
        return
    payload = {
        "id": node_id,
        "kind": kind,
        "title": title,
        "centerable": centerable,
    }
    payload.update(extra)
    nodes[node_id] = payload


def add_edge(edges, source, target, relation, strength=1, directed=False):
    if source == target:
        return
    key = (source, target, relation)
    if key in edges["_seen"]:
        return
    edges["_seen"].add(key)
    edges["items"].append(
        {
            "source": source,
            "target": target,
            "relation": relation,
            "strength": strength,
            "directed": directed,
        }
    )


def build():
    root = json.loads(SOURCE.read_text(encoding="utf-8"))
    assign_ids(root)
    nodes = {}
    edges = {"items": [], "_seen": set()}
    hierarchy_nodes = []
    page_nodes = set()

    def visit(tree_node, parent_id=None):
        node_id = tree_node["id"]
        extracted = tree_node.get("extracted") or {}
        summary = clean_text(extracted.get("summary", ""))
        example = clean_text(extracted.get("example", ""))
        text = summary or example or ""
        add_node(
            nodes,
            node_id,
            tree_node.get("kind", "node"),
            tree_node.get("title", ""),
            centerable=True,
            page=tree_node.get("page"),
            summaryPages=tree_node.get("summaryPages", []),
            examplePages=tree_node.get("examplePages", []),
            path=tree_node.get("path", []),
            tags=tree_node.get("tags", []),
            text=text,
            kindLabel=node_kind_label(tree_node.get("kind", "node")),
        )
        hierarchy_nodes.append(tree_node)
        if parent_id:
            add_edge(edges, parent_id, node_id, "包含", 3, True)

        if summary:
            for idx, (title, body) in enumerate(split_summary_units(summary), 1):
                sid = f"sum_{node_id}_{idx}"
                add_node(
                    nodes,
                    sid,
                    "summary",
                    title,
                    centerable=True,
                    text=body,
                    parent=node_id,
                    tags=tree_node.get("tags", []),
                    pages=tree_node.get("summaryPages", []),
                    kindLabel="提要",
                )
                add_edge(edges, node_id, sid, "内容提要", 2, True)
                for page in tree_node.get("summaryPages", []):
                    pid = add_page_node(nodes, page, page_nodes)
                    add_edge(edges, sid, pid, "原页", 1, True)

        if tree_node.get("kind") == "type":
            ex_id = f"ex_{node_id}"
            add_node(
                nodes,
                ex_id,
                "example",
                f"例题｜{tree_node.get('title', '').replace('类型', '')}",
                centerable=False,
                text=example,
                parent=node_id,
                pages=tree_node.get("examplePages", []),
                tags=tree_node.get("tags", []),
                kindLabel="例题",
            )
            add_edge(edges, node_id, ex_id, "对应例题", 2, True)
            for page in tree_node.get("examplePages", []):
                pid = add_page_node(nodes, page, page_nodes)
                add_edge(edges, ex_id, pid, "原页截图", 1, True)

        for child in tree_node.get("children", []):
            visit(child, node_id)

    visit(root)
    add_semantic_edges(nodes, edges, hierarchy_nodes)
    return {
        "rootId": root["id"],
        "nodes": list(nodes.values()),
        "edges": edges["items"],
        "stats": {
            "nodes": len(nodes),
            "edges": len(edges["items"]),
            "hierarchy": len(hierarchy_nodes),
            "pages": len(page_nodes),
        },
        "source": "化学：方法册_00.pdf OCR 摘取 + 主观化学式校正",
    }


def assign_ids(root):
    counter = 0

    def walk(node, path=None):
        nonlocal counter
        counter += 1
        node["id"] = node.get("id") or f"n{counter}"
        current_path = (path or []) + [node.get("title", "")]
        node["path"] = node.get("path") or current_path
        for child in node.get("children", []):
            walk(child, current_path)

    walk(root)


def add_page_node(nodes, page, page_nodes):
    pid = f"page_{page:03d}"
    page_nodes.add(page)
    if pid not in nodes:
        add_node(
            nodes,
            pid,
            "page",
            f"书内页 {page}",
            centerable=False,
            text=page_text(page),
            page=page,
            image=f"build/page_images/page_{page:03d}.jpg",
            kindLabel="原页",
        )
    return pid


def find_by_title(hierarchy_nodes, needle, kind=None):
    for node in hierarchy_nodes:
        if needle in node.get("title", "") and (kind is None or node.get("kind") == kind):
            return node["id"]
    return None


def add_semantic_edges(nodes, edges, hierarchy_nodes):
    pairs = [
        ("第2章", "第4章", "守恒与氧化还原计算互通"),
        ("第2章", "第10章", "浓度与水溶液平衡计算"),
        ("第3章", "第10章", "离子反应延伸到离子平衡"),
        ("第4章", "第11章", "电子转移进入电化学"),
        ("第5章", "第7章", "金属元素进入工艺流程"),
        ("第6章", "第7章", "非金属元素进入工艺流程"),
        ("第8章", "第12章", "结构决定有机性质"),
        ("第9章", "第7章", "反应原理支撑工业条件"),
        ("第13章", "第5章", "实验验证金属化合物性质"),
        ("第13章", "第6章", "实验验证非金属化合物性质"),
        ("第14章", "第2章", "阿伏加德罗常数依托化学计量"),
        ("第15章", "第3章", "化学用语支撑离子方程式"),
        ("第16章", "第5章", "生活材料联系元素化合物"),
    ]
    for a, b, rel in pairs:
        aid = find_by_title(hierarchy_nodes, a, "chapter")
        bid = find_by_title(hierarchy_nodes, b, "chapter")
        if aid and bid:
            add_edge(edges, aid, bid, rel, 2, False)

    by_tag = {}
    for node in hierarchy_nodes:
        if node.get("kind") not in {"chapter", "module"}:
            continue
        for tag in node.get("tags", []):
            by_tag.setdefault(tag, []).append(node["id"])
    for tag, ids in by_tag.items():
        label = TAG_RELATIONS.get(tag, tag)
        ids = ids[:24]
        for i in range(len(ids) - 1):
            add_edge(edges, ids[i], ids[i + 1], label, 1, False)


def main():
    graph = build()
    OUT.write_text(
        "window.NETWORK_DATA = " + json.dumps(graph, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    print(json.dumps(graph["stats"], ensure_ascii=False, indent=2))
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
