#!/usr/bin/env python3
"""
OCR script using Tesseract for offline operation.
Processes PNG pages and extracts text with bounding boxes.
Supports table detection via img2table library.
"""

import json
import argparse
import os
import sys
from pathlib import Path
import subprocess

# Check for pytesseract
try:
    import pytesseract
    from PIL import Image, ImageEnhance, ImageFilter
except ImportError:
    print("❌ Missing dependencies. Install with:")
    print("   uv pip install pytesseract Pillow")
    sys.exit(1)

from concurrent.futures import ThreadPoolExecutor, as_completed

# Optional: img2table for table detection
try:
    from img2table.document import Image as Img2TableImage
    from img2table.ocr import TesseractOCR as Img2TableTesseract
    IMG2TABLE_AVAILABLE = True
except ImportError:
    print("⚠️  img2table not installed. Table detection disabled. Run: uv pip install img2table")
    IMG2TABLE_AVAILABLE = False

# img2table's Tesseract parser regex only matches 1-4 digit bbox coords.
# Images taller/wider than 9999px must be resized before table detection.
IMG2TABLE_MAX_DIM = 9999


def detect_tables(image_path, page_number, prefix=None):
    """
    Detect tables in an image using img2table with Tesseract backend.

    Args:
        image_path: Path to PNG image
        page_number: Page number for logging
        prefix: Evidence ID prefix (e.g. 's06' for sheet 6)

    Returns:
        list of table dictionaries with structure info
    """
    if not IMG2TABLE_AVAILABLE:
        return []

    try:
        # Check if image exceeds img2table's bbox regex limit (4 digits max)
        pil_img = Image.open(image_path)
        orig_w, orig_h = pil_img.size
        scale_factor = 1.0
        src_path = str(image_path)
        tmp_path = None

        if max(orig_w, orig_h) > IMG2TABLE_MAX_DIM:
            scale_factor = IMG2TABLE_MAX_DIM / max(orig_w, orig_h)
            new_w = int(orig_w * scale_factor)
            new_h = int(orig_h * scale_factor)
            # Convert RGBA→RGB if needed, resize
            if pil_img.mode == 'RGBA':
                pil_img = pil_img.convert('RGB')
            resized = pil_img.resize((new_w, new_h), Image.LANCZOS)
            import tempfile
            tmp_file = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
            resized.save(tmp_file.name)
            src_path = tmp_file.name
            tmp_path = tmp_file.name
            print(f"    📐 Resized {orig_w}x{orig_h} → {new_w}x{new_h} for table detection")

        # Initialize img2table with Tesseract backend
        ocr_engine = Img2TableTesseract(lang="jpn+eng")
        img = Img2TableImage(src=src_path)

        # Extract tables (including borderless tables)
        extracted_tables = img.extract_tables(
            ocr=ocr_engine,
            borderless_tables=True,
            min_confidence=50
        )

        tables = []
        evidence_prefix = prefix or f"p{page_number:04d}"

        for idx, table in enumerate(extracted_tables, start=1):
            # Get table bounding box (convert numpy types to native Python)
            bbox = [float(table.bbox.x1), float(table.bbox.y1), float(table.bbox.x2), float(table.bbox.y2)]

            # Extract cell content as 2D array
            content = []
            for row in table.content.values():
                row_content = []
                for cell in row:
                    cell_text = cell.value if cell and cell.value else ""
                    row_content.append(cell_text)
                content.append(row_content)

            # Scale bbox back to original dimensions if resized
            if scale_factor != 1.0:
                bbox = [v / scale_factor for v in bbox]

            tables.append({
                "tableId": f"t{idx:04d}",
                "evidenceId": f"EV-{evidence_prefix}-t{idx:04d}",
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
    finally:
        # Clean up temp file if created
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


def process_page(image_path, page_num, confidence_threshold=0.7, prefix=None, detect_tables_enabled=True):
    """
    Process a single page image with Tesseract OCR.
    
    Args:
        image_path: Path to the PNG image
        page_num: Page number (1-based)
        confidence_threshold: Minimum confidence for a block
        prefix: Evidence ID prefix (e.g. 's01' for sheet 1). Defaults to 'p{page_num:04d}'.
        detect_tables_enabled: Whether to detect tables using img2table
        
    Returns:
        dict with page data including blocks and tables
    """
    img = Image.open(image_path)
    width, height = img.size

    # Detect tables first (if enabled)
    tables = []
    if detect_tables_enabled:
        tables = detect_tables(image_path, page_num, prefix=prefix)
    
    # --- Image preprocessing to improve OCR confidence ---
    # 1. Convert to grayscale
    img_processed = img.convert('L')
    # 2. Mild contrast enhancement (too high blurs kanji strokes)
    enhancer = ImageEnhance.Contrast(img_processed)
    img_processed = enhancer.enhance(1.5)
    # 3. Sharpen to make text edges clearer
    img_processed = img_processed.filter(ImageFilter.SHARPEN)
    # Note: MedianFilter removed - it blurs fine strokes of Japanese characters
    
    # Get OCR data with bounding boxes and confidence
    # Use --psm 3 (auto) which works best for mixed spreadsheet layouts
    # Remove 'vie' language to reduce confusion on Japanese documents
    tesseract_config = r'--oem 3 --psm 3'
    data = pytesseract.image_to_data(
        img_processed, lang='jpn+eng',
        config=tesseract_config,
        output_type=pytesseract.Output.DICT
    )
    
    blocks = []
    current_block = None
    block_id = 0
    
    for i in range(len(data['text'])):
        text = str(data['text'][i]).strip()
        if not text:
            continue
            
        conf = float(data['conf'][i]) / 100.0  # Tesseract gives 0-100, normalize to 0-1
        
        # Skip very low confidence
        if conf < 0:
            continue
            
        block_num = data['block_num'][i]
        
        # Get bounding box
        x = data['left'][i]
        y = data['top'][i]
        w = data['width'][i]
        h = data['height'][i]
        
        # Normalize bbox to 0-1 range
        bbox = [
            x / width,
            y / height,
            (x + w) / width,
            (y + h) / height
        ]
        
        # Group by block number
        if current_block is None or current_block['block_num'] != block_num:
            if current_block is not None:
                blocks.append(current_block)
            block_id += 1
            current_block = {
                'block_num': block_num,
                'id': block_id,
                'text': text,
                'confidence': conf,
                'bbox': bbox,
                'words': [{'text': text, 'conf': conf, 'bbox': bbox}]
            }
        else:
            # Merge with current block
            current_block['text'] += ' ' + text
            # Use weighted average confidence by text length (longer words = more reliable)
            total_len = sum(len(w['text']) for w in current_block['words']) + len(text)
            if total_len > 0:
                weighted_sum = sum(w['conf'] * len(w['text']) for w in current_block['words']) + conf * len(text)
                current_block['confidence'] = weighted_sum / total_len
            else:
                current_block['confidence'] = (current_block['confidence'] + conf) / 2
            # Expand bbox
            current_block['bbox'] = [
                min(current_block['bbox'][0], bbox[0]),
                min(current_block['bbox'][1], bbox[1]),
                max(current_block['bbox'][2], bbox[2]),
                max(current_block['bbox'][3], bbox[3])
            ]
            current_block['words'].append({'text': text, 'conf': conf, 'bbox': bbox})
    
    # Don't forget last block
    if current_block is not None:
        blocks.append(current_block)
    
    # Format blocks for output
    formatted_blocks = []
    ambiguous_count = 0
    
    for block in blocks:
        is_ambiguous = block['confidence'] < confidence_threshold
        if is_ambiguous:
            ambiguous_count += 1
        
        # Generate evidenceId: EV-p{page}-b{block} or EV-s{sheet}-b{block}
        evidence_prefix = f"p{page_num:04d}" if prefix is None else prefix
        evidence_id = f"EV-{evidence_prefix}-b{block['id']:04d}"
            
        formatted_blocks.append({
            'id': block['id'],
            'evidenceId': evidence_id,
            'text': block['text'],
            'confidence': round(block['confidence'], 3),
            'bbox': [round(x, 4) for x in block['bbox']],
            'ambiguous': is_ambiguous
        })
    
    return {
        'page': page_num,
        'size': {'width': width, 'height': height},
        'blocks': formatted_blocks,
        'tables': tables,
        'stats': {
            'total_blocks': len(formatted_blocks),
            'total_tables': len(tables),
            'ambiguous_blocks': ambiguous_count
        }
    }


def main():
    parser = argparse.ArgumentParser(description='OCR pages using Tesseract')
    parser.add_argument('--input', required=True, help='Input directory (with render/pages/)')
    parser.add_argument('--output', required=True, help='Output directory')
    args = parser.parse_args()
    
    input_dir = Path(args.input)
    output_dir = Path(args.output)
    sheets_dir = input_dir / 'render' / 'sheets'
    pages_dir = input_dir / 'render' / 'pages'
    ocr_dir = output_dir / 'ocr'
    
    # Prefer sheets (stitched) over pages if available
    use_sheets = sheets_dir.exists() and len(list(sheets_dir.glob("sheet-*.png"))) > 0
    source_dir = sheets_dir if use_sheets else pages_dir
    file_pattern = "sheet-*.png" if use_sheets else "page-*.png"
    ocr_prefix = "sheet" if use_sheets else "page"
    
    # Validate
    if not source_dir.exists():
        print(f"❌ Source directory not found: {source_dir}")
        sys.exit(1)
    
    # Create output dir
    ocr_dir.mkdir(parents=True, exist_ok=True)
    
    # Check if OCR is already complete (skip if all files exist)
    source_files = sorted(source_dir.glob(file_pattern))
    existing_ocr = list(ocr_dir.glob(f"{ocr_prefix}-*.json"))
    
    if len(existing_ocr) >= len(source_files) and len(source_files) > 0:
        print(f"  ⏭️ Skipping OCR: {len(existing_ocr)} {ocr_prefix}s already processed in {ocr_dir}")
        return
    
    # Get confidence threshold
    confidence_threshold = float(os.environ.get("OCR_CONFIDENCE_THRESHOLD", "0.7"))
    print(f"  🎯 Confidence threshold: {confidence_threshold}")

    # Get table detection setting from environment (default: enabled)
    detect_tables_enabled = os.environ.get("DETECT_TABLES", "true").lower() == "true"
    if detect_tables_enabled and IMG2TABLE_AVAILABLE:
        print("  📊 Table detection: enabled (img2table + Tesseract)")
    elif detect_tables_enabled and not IMG2TABLE_AVAILABLE:
        print("  ⚠️  Table detection: disabled (img2table not installed)")
        detect_tables_enabled = False
    else:
        print("  📊 Table detection: disabled")
    
    # Check tesseract
    if use_sheets:
        print(f"  🧩 Using sheet-based OCR ({len(source_files)} stitched sheets)")
    else:
        print(f"  📄 Using page-based OCR ({len(source_files)} pages)")
    print("  🔧 Using Tesseract OCR (offline mode)")
    try:
        version = pytesseract.get_tesseract_version()
        print(f"  📦 Tesseract version: {version}")
    except Exception as e:
        print(f"❌ Tesseract not found: {e}")
        sys.exit(1)
    
    if not source_files:
        print(f"❌ No {ocr_prefix} images found in {source_dir}")
        sys.exit(1)
    
    print(f"  📄 Found {len(source_files)} {ocr_prefix}s to process")
    
    # Read manifest for sheet names (if doing sheet-based OCR)
    manifest_path = output_dir / 'manifest.json'
    sheet_names = {}
    if use_sheets and manifest_path.exists():
        try:
            with open(manifest_path, 'r', encoding='utf-8') as f:
                manifest_data = json.load(f)
            for s in manifest_data.get('sheets', []):
                sheet_names[s['sheetIndex']] = s['sheetName']
        except Exception:
            pass
    
    all_pages = []
    total_blocks = 0
    total_tables = 0
    total_ambiguous = 0

    # Parallel OCR processing
    max_workers = int(os.environ.get('OCR_WORKERS', str(min(4, os.cpu_count() or 4))))

    # Prepare tasks
    tasks = []
    for i, source_file in enumerate(source_files):
        item_num = i + 1
        if use_sheets:
            prefix = f"s{item_num:02d}"
            sheet_name = sheet_names.get(item_num, '')
        else:
            prefix = f"p{item_num:04d}"
            sheet_name = ''
        tasks.append((source_file, item_num, confidence_threshold, prefix, detect_tables_enabled, sheet_name))

    print(f"  🚀 Processing {len(tasks)} {ocr_prefix}s with {max_workers} workers...")

    def _process_task(task):
        """Worker function for parallel OCR."""
        src_file, num, conf_thr, pfx, det_tables, sh_name = task
        page_data = process_page(src_file, num, conf_thr, prefix=pfx, detect_tables_enabled=det_tables)
        if use_sheets and sh_name:
            page_data['sheetName'] = sh_name
        return (num, page_data)

    results = {}
    errors = []

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_num = {
            executor.submit(_process_task, t): t[1] for t in tasks
        }
        for future in as_completed(future_to_num):
            item_num = future_to_num[future]
            if use_sheets:
                sh_name = sheet_names.get(item_num, '')
                label = f"sheet {item_num}" + (f" ({sh_name[:20]})" if sh_name else "")
            else:
                label = f"page {item_num}"
            try:
                num, page_data = future.result()
                results[num] = page_data
                table_info = f", {page_data['stats'].get('total_tables', 0)} tables" if page_data['stats'].get('total_tables', 0) > 0 else ""
                print(f"  ✅ {label}: {page_data['stats']['total_blocks']} blocks{table_info}")
            except Exception as e:
                errors.append(item_num)
                print(f"  ❌ {label}: {e}")

    # Save results in order
    for item_num in sorted(results.keys()):
        page_data = results[item_num]
        output_file = ocr_dir / f"{ocr_prefix}-{item_num}.json"
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(page_data, f, ensure_ascii=False, indent=2)
        all_pages.append(page_data)
        total_blocks += page_data['stats']['total_blocks']
        total_tables += page_data['stats'].get('total_tables', 0)
        total_ambiguous += page_data['stats']['ambiguous_blocks']
    
    # Update manifest
    manifest_path = output_dir / 'manifest.json'
    if manifest_path.exists():
        with open(manifest_path, 'r', encoding='utf-8') as f:
            manifest = json.load(f)
    else:
        manifest = {}
    
    manifest['ocr'] = {
        'engine': 'tesseract',
        'languages': ['jpn', 'eng', 'vie'],
        'mode': 'sheet' if use_sheets else 'page',
        'totalItems': len(all_pages),
        'totalBlocks': total_blocks,
        'totalTables': total_tables,
        'ambiguousBlocks': total_ambiguous,
        'confidenceThreshold': confidence_threshold,
        'tableDetectionEnabled': detect_tables_enabled
    }
    
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    
    mode_label = "sheets" if use_sheets else "pages"
    print(f"\n  ✅ OCR complete:")
    print(f"     - {mode_label.capitalize()}: {len(all_pages)}")
    print(f"     - Total blocks: {total_blocks}")
    print(f"     - Total tables: {total_tables}")
    print(f"     - Ambiguous (conf < {confidence_threshold}): {total_ambiguous}")


if __name__ == '__main__':
    main()
