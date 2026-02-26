#!/usr/bin/env python3
"""
OCR script using PaddleOCR with img2table for table detection
Extracts text from PNG images with bounding box and confidence
Preserves table structure using img2table library

Output format (per page):
{
  "page": 1,
  "blocks": [
    {
      "blockId": "b0001",
      "evidenceId": "EV-p0001-b0001",
      "text": "extracted text",
      "bbox": [x1, y1, x2, y2],
      "confidence": 0.95
    }
  ],
  "tables": [
    {
      "tableId": "t0001",
      "bbox": [x1, y1, x2, y2],
      "rows": 5,
      "cols": 3,
      "content": [["cell1", "cell2", ...], ...]
    }
  ]
}
"""

import argparse
import json
import os
import sys
from pathlib import Path

try:
    from paddleocr import PaddleOCR
except ImportError:
    print("❌ PaddleOCR not installed. Run: uv pip install paddleocr paddlepaddle")
    sys.exit(1)

try:
    from img2table.document import Image as Img2TableImage
    from img2table.ocr import PaddleOCR as Img2TablePaddleOCR
    IMG2TABLE_AVAILABLE = True
except ImportError:
    print("⚠️  img2table not installed. Table detection disabled. Run: uv pip install img2table")
    IMG2TABLE_AVAILABLE = False


def parse_args():
    parser = argparse.ArgumentParser(description="OCR PNG images using PaddleOCR")
    parser.add_argument("--input", required=True, help="Output directory (with render/pages/)")
    parser.add_argument("--output", required=True, help="Output directory")
    return parser.parse_args()


def get_reading_order_key(bbox):
    """
    Sort blocks by reading order: top-to-bottom, left-to-right
    Use y-center (with tolerance) then x-left
    """
    x1, y1, x2, y2 = bbox
    y_center = (y1 + y2) / 2
    # Group by rows (tolerance = 20px)
    row = int(y_center / 20)
    return (row, x1)


def detect_tables(image_path, page_number):
    """
    Detect tables in an image using img2table

    Args:
        image_path: Path to PNG image
        page_number: Page number for logging

    Returns:
        list of table dictionaries with structure info
    """
    if not IMG2TABLE_AVAILABLE:
        return []

    try:
        # Initialize img2table with PaddleOCR backend
        ocr_engine = Img2TablePaddleOCR(lang="vi")
        img = Img2TableImage(src=str(image_path))

        # Extract tables (including borderless tables)
        extracted_tables = img.extract_tables(
            ocr=ocr_engine,
            borderless_tables=True,
            min_confidence=50
        )

        tables = []
        for idx, table in enumerate(extracted_tables, start=1):
            # Get table bounding box
            bbox = [table.bbox.x1, table.bbox.y1, table.bbox.x2, table.bbox.y2]

            # Extract cell content as 2D array
            content = []
            for row in table.content.values():
                row_content = []
                for cell in row:
                    cell_text = cell.value if cell and cell.value else ""
                    row_content.append(cell_text)
                content.append(row_content)

            tables.append({
                "tableId": f"t{idx:04d}",
                "evidenceId": f"EV-p{page_number:04d}-t{idx:04d}",
                "bbox": [round(v, 1) for v in bbox],
                "rows": len(content),
                "cols": len(content[0]) if content else 0,
                "content": content,
            })

        if tables:
            print(f"    📊 Detected {len(tables)} table(s) on page {page_number}")

        return tables

    except Exception as e:
        print(f"    ⚠️  Table detection failed on page {page_number}: {e}")
        return []


def process_page(ocr, image_path, page_number, confidence_threshold=0.7, detect_tables_enabled=True):
    """
    Process a single page image with OCR and optional table detection

    Args:
        ocr: PaddleOCR instance
        image_path: Path to PNG image
        page_number: Page number (1-indexed)
        confidence_threshold: Minimum confidence to mark as reliable
        detect_tables_enabled: Whether to detect tables using img2table

    Returns:
        dict with page number, blocks, and tables
    """
    print(f"    📖 Processing page {page_number}...")

    # Detect tables first (if enabled)
    tables = []
    if detect_tables_enabled:
        tables = detect_tables(image_path, page_number)

    result = ocr.ocr(str(image_path), cls=True)

    if not result or not result[0]:
        print(f"    ⚠️  No text detected on page {page_number}")
        return {
            "page": page_number,
            "filename": os.path.basename(image_path),
            "blocks": [],
            "tables": tables,
            "hasAmbiguous": False,
        }

    blocks = []
    ambiguous_count = 0

    for line in result[0]:
        bbox_points, (text, confidence) = line

        # Convert polygon to bounding box [x1, y1, x2, y2]
        xs = [p[0] for p in bbox_points]
        ys = [p[1] for p in bbox_points]
        bbox = [min(xs), min(ys), max(xs), max(ys)]

        blocks.append({
            "text": text,
            "bbox": [round(v, 1) for v in bbox],
            "confidence": round(confidence, 3),
            "isAmbiguous": confidence < confidence_threshold,
        })

        if confidence < confidence_threshold:
            ambiguous_count += 1

    # Sort blocks by reading order
    blocks.sort(key=lambda b: get_reading_order_key(b["bbox"]))

    # Assign block IDs and evidence IDs
    for idx, block in enumerate(blocks, start=1):
        block["blockId"] = f"b{str(idx).padStart(4, '0')}" if hasattr(str, 'padStart') else f"b{idx:04d}"
        block["evidenceId"] = f"EV-p{page_number:04d}-b{idx:04d}"

    page_result = {
        "page": page_number,
        "filename": os.path.basename(image_path),
        "blocks": blocks,
        "tables": tables,
        "totalBlocks": len(blocks),
        "totalTables": len(tables),
        "ambiguousCount": ambiguous_count,
        "hasAmbiguous": ambiguous_count > 0,
    }

    table_info = f", {len(tables)} tables" if tables else ""
    print(f"    ✅ Page {page_number}: {len(blocks)} blocks{table_info}, {ambiguous_count} ambiguous")
    return page_result


def main():
    args = parse_args()
    output_dir = Path(args.output)
    pages_dir = output_dir / "render" / "pages"
    ocr_dir = output_dir / "ocr"

    # Validate input
    if not pages_dir.exists():
        print(f"❌ Pages directory not found: {pages_dir}")
        sys.exit(1)

    # Create OCR output directory
    ocr_dir.mkdir(parents=True, exist_ok=True)

    # Get confidence threshold from environment
    confidence_threshold = float(os.environ.get("OCR_CONFIDENCE_THRESHOLD", "0.7"))
    print(f"  🎯 Confidence threshold: {confidence_threshold}")

    # Get table detection setting from environment (default: enabled)
    detect_tables_enabled = os.environ.get("DETECT_TABLES", "true").lower() == "true"
    if detect_tables_enabled and IMG2TABLE_AVAILABLE:
        print("  📊 Table detection: enabled")
    elif detect_tables_enabled and not IMG2TABLE_AVAILABLE:
        print("  ⚠️  Table detection: disabled (img2table not installed)")
        detect_tables_enabled = False
    else:
        print("  📊 Table detection: disabled")

    # Initialize PaddleOCR (Vietnamese + English)
    print("  🔧 Initializing PaddleOCR...")
    ocr = PaddleOCR(lang="vi")  # Vietnamese (also handles English)

    # Find all page images
    page_files = sorted(pages_dir.glob("page-*.png"))

    if not page_files:
        print(f"❌ No page images found in {pages_dir}")
        sys.exit(1)

    print(f"  📄 Found {len(page_files)} pages to process")

    all_pages = []
    total_blocks = 0
    total_tables = 0
    total_ambiguous = 0

    for page_file in page_files:
        # Extract page number from filename (page-0001.png → 1)
        page_number = int(page_file.stem.replace("page-", ""))

        page_result = process_page(ocr, page_file, page_number, confidence_threshold, detect_tables_enabled)
        all_pages.append(page_result)

        # Save individual page result
        page_json = ocr_dir / f"page-{page_number:04d}.json"
        with open(page_json, "w", encoding="utf-8") as f:
            json.dump(page_result, f, ensure_ascii=False, indent=2)

        total_blocks += page_result["totalBlocks"]
        total_tables += page_result.get("totalTables", 0)
        total_ambiguous += page_result["ambiguousCount"]

    # Save summary
    summary = {
        "totalPages": len(all_pages),
        "totalBlocks": total_blocks,
        "totalTables": total_tables,
        "totalAmbiguous": total_ambiguous,
        "confidenceThreshold": confidence_threshold,
        "tableDetectionEnabled": detect_tables_enabled,
        "completedAt": __import__("datetime").datetime.now().isoformat(),
    }

    summary_path = ocr_dir / "summary.json"
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    # Update manifest
    manifest_path = output_dir / "manifest.json"
    if manifest_path.exists():
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)

        manifest["ocr"] = summary

        # Add OCR paths to pages
        for page_info in manifest.get("pages", []):
            page_num = page_info["pageNumber"]
            page_info["ocrPath"] = f"ocr/page-{page_num:04d}.json"

        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"\n  📊 OCR Summary:")
    print(f"     Total pages: {len(all_pages)}")
    print(f"     Total blocks: {total_blocks}")
    print(f"     Total tables: {total_tables}")
    print(f"     Ambiguous (< {confidence_threshold}): {total_ambiguous}")


if __name__ == "__main__":
    main()
