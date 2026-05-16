import argparse
import json
import multiprocessing as mp
import os
import re
import time
from pathlib import Path

import fitz
import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR


ROOT = Path(__file__).resolve().parents[1]
PDF_PATH = ROOT / "chemistry_method.pdf"
DATA_PATH = ROOT / "build" / "mindmap_base.json"
OCR_DIR = ROOT / "build" / "page_ocr"
CONTENT_PATH = ROOT / "build" / "extracted_content.json"

PAGE_OFFSET = 19
MAX_BOOK_PAGE = 789
_ENGINE = None
_DOC = None
_SCALE = 1.0


def load_base():
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def direct_types(node):
    return [child for child in node.get("children", []) if child.get("kind") == "type"]


def iter_nodes(node):
    yield node
    for child in node.get("children", []):
        yield from iter_nodes(child)


def assign_summary_pages(node, siblings=None, idx=0):
    node["summaryPages"] = []
    node["examplePages"] = []
    if node.get("kind") == "type" and node.get("page"):
        node["examplePages"] = [node["page"]]
    if node.get("kind") in {"module", "section"} and node.get("page"):
        types = direct_types(node)
        if types:
            first_type = min(child["page"] for child in types)
            end = max(node["page"], min(first_type, node["page"] + 7, MAX_BOOK_PAGE))
            node["summaryPages"] = list(range(max(1, node["page"]), end + 1))
        elif not node.get("children"):
            next_page = None
            if siblings and idx + 1 < len(siblings):
                next_page = siblings[idx + 1].get("page")
            end = next_page - 1 if next_page else node["page"] + 2
            end = max(node["page"], min(end, node["page"] + 5, MAX_BOOK_PAGE))
            node["summaryPages"] = list(range(max(1, node["page"]), end + 1))
    for child_idx, child in enumerate(node.get("children", [])):
        assign_summary_pages(child, node.get("children", []), child_idx)


def needed_pages(root):
    pages = set()
    for node in iter_nodes(root):
        pages.update(node.get("summaryPages", []))
        pages.update(node.get("examplePages", []))
    return sorted(p for p in pages if 1 <= p <= MAX_BOOK_PAGE)


def init_ocr_worker(scale):
    global _ENGINE, _DOC, _SCALE
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    os.environ.setdefault("OMP_WAIT_POLICY", "PASSIVE")
    _SCALE = scale
    _ENGINE = RapidOCR()
    _DOC = fitz.open(str(PDF_PATH))


def ocr_one_page(book_page):
    out_path = OCR_DIR / f"page_{book_page:03d}.json"
    if out_path.exists():
        return book_page
    page_index = book_page + PAGE_OFFSET - 1
    page = _DOC.load_page(page_index)
    pix = page.get_pixmap(matrix=fitz.Matrix(_SCALE, _SCALE), alpha=False)
    img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
    result, _ = _ENGINE(np.array(img))
    lines = []
    if result:
        result = sorted(
            result,
            key=lambda row: (
                sum(point[1] for point in row[0]) / 4,
                sum(point[0] for point in row[0]) / 4,
            ),
        )
        lines = [row[1].strip() for row in result if row[1].strip()]
    payload = {
        "bookPage": book_page,
        "pdfPage": book_page + PAGE_OFFSET,
        "lines": lines,
        "text": "\n".join(lines),
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return book_page


def run_ocr(pages, workers, scale):
    OCR_DIR.mkdir(parents=True, exist_ok=True)
    missing = [p for p in pages if not (OCR_DIR / f"page_{p:03d}.json").exists()]
    if not missing:
        print(f"OCR cache already covers {len(pages)} pages.")
        return
    print(f"OCR missing pages: {len(missing)} / {len(pages)}; workers={workers}; scale={scale}")
    start = time.time()
    with mp.Pool(processes=workers, initializer=init_ocr_worker, initargs=(scale,)) as pool:
        done = 0
        for page in pool.imap_unordered(ocr_one_page, missing, chunksize=1):
            done += 1
            elapsed = time.time() - start
            if done == 1 or done % 20 == 0 or done == len(missing):
                print(f"processed {done}/{len(missing)} pages in {elapsed:.1f}s; latest={page}")


def read_page(book_page):
    path = OCR_DIR / f"page_{book_page:03d}.json"
    if not path.exists():
        return ""
    return json.loads(path.read_text(encoding="utf-8")).get("text", "")


def join_pages(pages):
    blocks = []
    for page in pages:
        text = read_page(page)
        if text:
            blocks.append(f"【书内页{page}】\n{text}")
    return "\n".join(blocks)


def strip_boilerplate(text):
    lines = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("一化") or line.endswith("核心方法"):
            continue
        if re.fullmatch(r"\d{3}", line):
            continue
        lines.append(line)
    return "\n".join(lines)


def cut_between(text, start_patterns, stop_patterns):
    start = 0
    for pat in start_patterns:
        found = text.find(pat)
        if found >= 0:
            start = found
            break
    end = len(text)
    for pat in stop_patterns:
        found = text.find(pat, start + 1)
        if found >= 0:
            end = min(end, found)
    return text[start:end].strip()


def compact_text(text, max_chars):
    text = strip_boilerplate(text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    last_break = max(cut.rfind("\n"), cut.rfind("。"), cut.rfind("；"))
    if last_break > max_chars * 0.65:
        cut = cut[: last_break + 1]
    return cut.rstrip() + "\n……"


def type_code(title):
    match = re.match(r"类型\s*([^：:]+)", title)
    return match.group(1).strip() if match else ""


def extract_summary(node):
    pages = node.get("summaryPages", [])
    if not pages:
        return ""
    text = join_pages(pages)
    text = cut_between(text, ["内容提要"], ["类型I", "类型Ⅰ", "【例", "例1】"])
    return compact_text(text, 2300)


def extract_example(node, sibling_stop_titles):
    pages = node.get("examplePages", [])
    if not pages:
        return ""
    page = pages[0]
    text = join_pages([page])
    title = node.get("title", "")
    code = type_code(title)
    starts = [title]
    if code:
        starts.extend([f"类型{code}", f"类型 {code}"])
    stops = ["总结", "内容提要"]
    stops.extend(sibling_stop_titles)
    block = cut_between(text, starts, stops)
    if "【例" in block:
        block = block[block.find("【例") :]
    elif "例" in block:
        block = block[block.find("例") :]
    return compact_text(block, 1600)


def attach_content(root):
    for node in iter_nodes(root):
        if node.get("kind") in {"module", "section"}:
            summary = extract_summary(node)
            if summary:
                node["extracted"] = {"summary": summary}
        if node.get("kind") == "type":
            siblings = node.get("_siblings", [])
            idx = siblings.index(node) if node in siblings else -1
            next_titles = []
            if idx >= 0 and idx + 1 < len(siblings):
                next_titles.append(siblings[idx + 1].get("title", ""))
            example = extract_example(node, next_titles)
            node["extracted"] = {"example": example or f"原书例题见书内页 {node.get('page', '')}。"}


def link_siblings(node):
    children = node.get("children", [])
    for child in children:
        child["_siblings"] = children
        link_siblings(child)


def cleanup_private(node):
    node.pop("_siblings", None)
    node.pop("parent", None)
    for child in node.get("children", []):
        cleanup_private(child)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--scale", type=float, default=1.0)
    parser.add_argument("--ocr-only", action="store_true")
    args = parser.parse_args()

    root = load_base()
    assign_summary_pages(root)
    pages = needed_pages(root)
    (ROOT / "build").mkdir(exist_ok=True)
    (ROOT / "build" / "needed_pages.json").write_text(
        json.dumps(pages, ensure_ascii=False), encoding="utf-8"
    )
    run_ocr(pages, max(1, args.workers), args.scale)
    if args.ocr_only:
        return
    link_siblings(root)
    attach_content(root)
    cleanup_private(root)
    CONTENT_PATH.write_text(json.dumps(root, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {CONTENT_PATH}")


if __name__ == "__main__":
    mp.freeze_support()
    main()
