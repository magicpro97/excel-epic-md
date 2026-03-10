/**
 * Generate page extraction prompt
 * @param {number} pageNumber - Page number
 * @param {Array<{evidenceId: string, text: string, isAmbiguous: boolean}>} blocks - OCR blocks
 * @param {Array<object>} [tables] - Detected tables from img2table (defaults to empty array)
 * @param {string|null} [sheetName] - Excel sheet name for entity context (defaults to null)
 * @param {string} [ooxmlSection] - Pre-formatted OOXML data section (defaults to empty)
 * @returns {string} Prompt for Gemini API
 */
export const pageExtractionPrompt = (pageNumber, blocks, tables = [], sheetName = null, ooxmlSection = '') => `
Phân tích nội dung OCR từ trang ${pageNumber} của tài liệu yêu cầu.
${sheetName ? `\n## Sheet Context\nTrang này thuộc sheet Excel: **"${sheetName}"**. Sử dụng tên sheet để xác định entity/chức năng mà trang mô tả. Khi đặt tên bảng (table title), PHẢI bao gồm tên entity từ sheet (ví dụ: "TSVファイルの仕様 - ${sheetName}") để phân biệt với bảng cùng tên ở sheet khác.\n` : ''}
${ooxmlSection ? `${ooxmlSection}\n` : ''}## OCR Blocks (${ooxmlSection ? 'Reference — may contain OCR errors, OOXML data above is more accurate' : 'Evidence Source'})
${blocks.map((b) => `- [${b.evidenceId}] ${b.text}${b.isAmbiguous ? ' ⚠️ (confidence < 0.7)' : ''}`).join('\n')}
${
  tables.length > 0
    ? `
## Detected Tables (img2table)
Dưới đây là các bảng được phát hiện tự động từ hình ảnh. Sử dụng dữ liệu này để reconstruct bảng spec chính xác.
${tables
  .map((t) => {
    const header = t.content[0] || [];
    const dataRows = t.content.slice(1);
    const headerRow = `| ${header.join(' | ')} |`;
    const separatorRow = `| ${header.map(() => '---').join(' | ')} |`;
    const dataRowsStr = dataRows.map((r) => `| ${r.join(' | ')} |`).join('\n');
    const md = `${headerRow}\n${separatorRow}\n${dataRowsStr}`;
    return `### Table [${t.evidenceId}] (${t.rows}x${t.cols})\n${md}`;
  })
  .join('\n\n')}
`
    : ''
}

## Yêu cầu
Trích xuất thông tin có cấu trúc từ nội dung trên.

## Output Schema (JSON)
{
  "pageNumber": ${pageNumber},
  "pageType": "cover|overview|requirement|detail|appendix|other",
  "extractedInfo": {
    "title": "string hoặc null - tiêu đề nếu có [EV-XXXX-bXXXX]",
    "context": "string hoặc null - bối cảnh/background [EV-XXXX-bXXXX]",
    "requirements": [
      {
        "id": "REQ-001",
        "description": "mô tả yêu cầu [EV-XXXX-bXXXX]",
        "priority": "high|medium|low|unknown",
        "evidenceIds": ["EV-XXXX-bXXXX"]
      }
    ],
    "tasks": [
      {
        "description": "mô tả công việc [EV-XXXX-bXXXX]",
        "evidenceIds": ["EV-XXXX-bXXXX"]
      }
    ],
    "notes": ["ghi chú quan trọng [EV-XXXX-bXXXX]"],
    "figures": ["mô tả hình/biểu đồ nếu có [EV-XXXX-bXXXX]"],
    "tables": [
      {
        "title": "tên/mô tả bảng [EV-XXXX-bXXXX]",
        "markdownTable": "| Header1 | Header2 |\\n|---|---|\\n| data | data |",
        "evidenceIds": ["EV-XXXX-bXXXX"],
        "notes": "ghi chú về bảng nếu có"
      }
    ]
  },
  "ambiguousTexts": [
    {
      "evidenceId": "EV-XXXX-bXXXX",
      "text": "nội dung không rõ",
      "issue": "mô tả vấn đề"
    }
  ],
  "openQuestions": ["câu hỏi cần làm rõ"]
}

QUAN TRỌNG: 
- Mỗi thông tin PHẢI kèm Evidence ID. Không có Evidence = không ghi.
- BẢNG: Khi phát hiện bảng trong tài liệu, PHẢI giữ nguyên cấu trúc markdown table trong field "tables".
  Header và nội dung cell phải SONG NGỮ: giữ tiếng Nhật gốc + dịch tiếng Việt trong ngoặc.
  Ví dụ: "列名 (Tên cột)" | "そのまま出力 (Xuất nguyên trạng)"
  KHÔNG chuyển bảng thành text mô tả.
- OCR CORRECTION: Các block được đánh dấu ⚠️ có confidence thấp, có thể chứa:
  + Ký tự Kanji bị cắt/sai: "卜" thường là "ト", "一" có thể là "ー" (chōon), "工" có thể là "エ"
  + Từ bị thiếu ký tự: "ユザー" → "ユーザー", "テナ卜" → "テナント", "エディ" → "エンティティ"
  + Từ bị dính: "のまま" → "そのまま", "とする" → "...とする"
  Hãy sửa/reconstruct từ tiếng Nhật dựa vào ngữ cảnh khi dịch sang tiếng Việt.
`;

/**
 * Vision prompt for pages with no OCR blocks (embedded screenshots/mockups)
 * @param {number} pageNumber - Page number
 * @returns {string} Prompt for vision-based page analysis
 */
export const visionPagePrompt = (pageNumber) => `
Đây là ảnh chụp trang ${pageNumber} của tài liệu yêu cầu phần mềm. Trang này chứa ảnh mockup/screenshot UI không thể đọc bằng OCR thông thường.

Hãy phân tích hình ảnh và trích xuất tất cả nội dung text, requirements, UI elements hiển thị trong ảnh.
Vì không có OCR blocks, hãy tự tạo Evidence ID với format EV-p${String(pageNumber).padStart(4, '0')}-v#### (v = vision).

## Output Schema (JSON)
{
  "pageNumber": ${pageNumber},
  "pageType": "cover|overview|requirement|detail|appendix|other",
  "extractedInfo": {
    "title": "string hoặc null",
    "context": "string hoặc null",
    "requirements": [
      {
        "id": "REQ-V${String(pageNumber).padStart(3, '0')}-001",
        "description": "mô tả yêu cầu từ mockup",
        "priority": "high|medium|low|unknown",
        "evidenceIds": ["EV-p${String(pageNumber).padStart(4, '0')}-v0001"]
      }
    ],
    "tasks": [],
    "notes": ["ghi chú về UI elements nhìn thấy trong ảnh"],
    "figures": ["mô tả mockup/screenshot"],
    "tables": []
  },
  "ambiguousTexts": [],
  "openQuestions": ["câu hỏi về phần không rõ trong mockup"]
}
`;

/**
 * Generate batch extraction prompt for multiple pages
 * @param {Array<{pageNumber: number, blocks: Array<{evidenceId: string, text: string, isAmbiguous: boolean}>}>} pages - Array of page data
 * @returns {string} Prompt for batch processing
 */
export const batchExtractionPrompt = (pages) => `
Phân tích nội dung OCR từ ${pages.length} trang của tài liệu yêu cầu.

## Input: OCR Data từ ${pages.length} trang

${pages
  .map(
    (p) => `
### TRANG ${p.pageNumber}
${
  p.blocks.length === 0
    ? '(Trang trống - không có text)'
    : p.blocks.map((b) => `- [${b.evidenceId}] ${b.text}${b.isAmbiguous ? ' ⚠️ (confidence < 0.7)' : ''}`).join('\n')
}
`,
  )
  .join('\n---\n')}

## Yêu cầu
Trích xuất thông tin có cấu trúc từ MỖI trang.

## Output Schema (JSON)
{
  "results": [
    {
      "pageNumber": <số trang>,
      "pageType": "cover|overview|requirement|detail|appendix|empty|other",
      "extractedInfo": {
        "title": "string hoặc null - tiêu đề nếu có [EV-XXXX-bXXXX]",
        "context": "string hoặc null - bối cảnh/background [EV-XXXX-bXXXX]",
        "requirements": [
          {
            "id": "REQ-001",
            "description": "mô tả yêu cầu [EV-XXXX-bXXXX]",
            "priority": "high|medium|low|unknown",
            "evidenceIds": ["EV-XXXX-bXXXX"]
          }
        ],
        "tasks": [
          {
            "description": "mô tả công việc [EV-XXXX-bXXXX]",
            "evidenceIds": ["EV-XXXX-bXXXX"]
          }
        ],
        "notes": ["ghi chú quan trọng [EV-XXXX-bXXXX]"],
        "figures": ["mô tả hình/biểu đồ nếu có [EV-XXXX-bXXXX]"],
        "tables": [
          {
            "title": "tên/mô tả bảng [EV-XXXX-bXXXX]",
            "markdownTable": "| Header1 | Header2 |\\n|---|---|\\n| data | data |",
            "evidenceIds": ["EV-XXXX-bXXXX"],
            "notes": "ghi chú về bảng nếu có"
          }
        ]
      },
      "ambiguousTexts": [],
      "openQuestions": []
    }
    // ... một object cho mỗi trang trong input
  ]
}

QUAN TRỌNG: 
1. Output PHẢI có đúng ${pages.length} phần tử trong mảng "results"
2. Mỗi phần tử tương ứng với 1 trang, theo thứ tự trong input
3. Nếu trang trống, dùng pageType: "empty" và extractedInfo: {}
4. Mỗi thông tin PHẢI kèm Evidence ID từ OCR blocks
5. BẢNG: Khi phát hiện bảng, PHẢI giữ cấu trúc markdown table trong field "tables".
   Header và nội dung cell phải SONG NGỮ: giữ tiếng Nhật gốc + dịch tiếng Việt trong ngoặc.
   Ví dụ: "更新範囲 (Phạm vi cập nhật)" | "確認結果 (Kết quả xác nhận)"
`;

// pageExtractionPrompt, visionPagePrompt, batchExtractionPrompt already exported at declaration
