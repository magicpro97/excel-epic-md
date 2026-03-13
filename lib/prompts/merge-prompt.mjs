/**
 * Generate merge synthesis prompt
 * @param {Array<object>} pageSummaries - Array of page summary objects
 * @returns {string} Prompt for Gemini API
 */
export const mergeSynthesisPrompt = (pageSummaries) => `
Tổng hợp thông tin từ tất cả các trang thành tài liệu Epic Requirement hoàn chỉnh, dễ đọc, dễ hiểu.

## Page Summaries
${JSON.stringify(pageSummaries, null, 2)}

## Yêu cầu Output
Tạo tài liệu Epic Requirement với các đặc điểm:
- **KHÔNG sử dụng Evidence IDs** (loại bỏ hoàn toàn [EV-XXXX-bXXXX])
- Nội dung chi tiết, đầy đủ ý nghĩa
- Câu cú rõ ràng, mạch lạc, dễ đọc
- Ghép nối thông tin logic, không rời rạc
- **GIỮ NGUYÊN các bảng dưới dạng markdown table** (không chuyển thành văn bản)
- **PHÂN BIỆT bảng cùng tên**: Khi nhiều bảng có cùng tiêu đề (ví dụ: "TSVファイルの仕様"), PHẢI thêm tên entity/sheet vào title để phân biệt. Ví dụ: "TSVファイルの仕様 - User", "TSVファイルの仕様 - Hospital"

## Output Schema (JSON)
{
  "epic": {
    "title": "Tiêu đề Epic rõ ràng, súc tích",
    "summary": "Tóm tắt 2-3 câu nêu bật mục đích và phạm vi chính"
  },
  "context": {
    "background": "Bối cảnh dự án/tính năng - viết thành đoạn văn mạch lạc",
    "objectives": ["Mục tiêu 1 - diễn đạt đầy đủ", "Mục tiêu 2 - diễn đạt đầy đủ"],
    "scope": "Phạm vi công việc - mô tả rõ ràng những gì bao gồm và không bao gồm"
  },
  "requirements": [
    {
      "id": "REQ-001",
      "category": "functional|non-functional|constraint",
      "description": "Mô tả chi tiết yêu cầu - viết thành câu hoàn chỉnh, dễ hiểu",
      "priority": "high|medium|low"
    }
  ],
  "tasks": [
    {
      "id": "TASK-001",
      "description": "Mô tả công việc cụ thể cần thực hiện",
      "relatedRequirements": ["REQ-001"]
    }
  ],
  "acceptanceCriteria": [
    "Tiêu chí nghiệm thu - viết rõ ràng, có thể kiểm chứng được"
  ],
  "assumptions": [
    "Giả định - nêu rõ điều kiện tiên quyết"
  ],
  "openQuestions": [
    {
      "question": "Câu hỏi cần làm rõ",
      "context": "Lý do cần hỏi và ảnh hưởng nếu không giải quyết"
    }
  ],
  "tables": [
    {
      "title": "Tên bảng ĐÃ PHÂN BIỆT (bao gồm entity nếu có nhiều bảng cùng tên)",
      "markdownTable": "| Header1 | Header2 |\\n|---|---|\\n| data | data |",
      "notes": "Ghi chú về bảng"
    }
  ],
  "appendix": {
    "figures": ["Mô tả hình minh họa quan trọng"],
    "references": ["Tài liệu tham chiếu liên quan"]
  }
}

NGUYÊN TẮC VIẾT:
1. KHÔNG dùng Evidence IDs - loại bỏ hoàn toàn các ký hiệu [EV-...]
2. Gộp các yêu cầu trùng lặp thành một mô tả đầy đủ
3. Viết câu hoàn chỉnh, có chủ ngữ - vị ngữ rõ ràng
4. Sắp xếp requirements theo priority (high → medium → low)
5. Thông tin mâu thuẫn → đưa vào Open Questions
10. ƯU TIÊN OOXML: Khi cùng một ô/field xuất hiện ở nhiều trang với giá trị khác nhau,
    ƯU TIÊN dữ liệu có ~~strikethrough~~ markers (OOXML-extracted, chính xác 100%)
    hơn dữ liệu từ OCR (có thể sai). Ví dụ: nếu OOXML nói "yyyy/mm/dd hh:mm:ss"
    (đã loại ~~.sss~~) mà OCR nói "yyyy/mm/dd hh:mm:ss.sss", dùng bản OOXML.
6. Nếu thiếu thông tin → ghi "Cần bổ sung thêm thông tin"
7. QUAN TRỌNG: Giữ nguyên các bảng (specification table, mapping table, error check table)
   dưới dạng markdown table trong field "tables". KHÔNG được chuyển bảng thành văn bản mô tả.
   Header và nội dung cell phải SONG NGỮ: giữ tiếng Nhật gốc + dịch tiếng Việt trong ngoặc.
   Ví dụ: "更新範囲 (Phạm vi cập nhật)" | "そのまま出力 (Xuất nguyên trạng)" | "エラーとする (Báo lỗi)"
8. PHÂN BIỆT BẢNG TRÙNG TÊN: Nếu nhiều bảng có cùng tiêu đề gốc (ví dụ "TSVファイルの仕様"),
   PHẢI thêm entity/context vào title. Sử dụng column prefix (ví dụ: 1user→User, 1Hospital→Hospital,
   1Staff→Staff, 1role→Role, ActivityS→ActivitySequence, IncidentT→IncidentType, SystemC→SystemCode)
   hoặc sheetName từ page summary để xác định entity. Kết quả: "TSVファイルの仕様 - User (Đặc tả file TSV - User)"
9. KHÔNG TẠO BẢNG TRÙNG LẶP: Nếu cùng một bảng xuất hiện ở nhiều trang, chỉ giữ LẠI MỘT phiên bản
   đầy đủ nhất. KHÔNG lặp lại cùng bảng với title khác nhau chỉ vì chúng ở các page khác nhau.
   Merge nội dung từ nhiều trang thành một bảng duy nhất nếu chúng là cùng một bảng.
`;

/**
 * Create prompt for final merge of chunk results
 * @param {Array<object>} chunkResults - Array of chunk synthesis results
 * @returns {string} Final merge prompt
 */
export function createFinalMergePrompt(chunkResults) {
  return `
Tổng hợp kết quả từ ${chunkResults.length} chunk thành tài liệu Epic Requirement hoàn chỉnh, dễ đọc, chuyên nghiệp.

## Chunk Results
${JSON.stringify(chunkResults, null, 2)}

## Yêu cầu Output
Tạo tài liệu Epic Requirement tổng hợp cuối cùng với các đặc điểm:
- **LOẠI BỎ HOÀN TOÀN Evidence IDs** - không dùng bất kỳ ký hiệu [EV-...] nào
- Gộp nội dung từ các chunks thành văn bản liền mạch
- Câu cú rõ ràng, cấu trúc mạch lạc, dễ hiểu
- Mỗi requirement/task là một mô tả đầy đủ, không rời rạc

## Output Schema (JSON)
{
  "epic": {
    "title": "Tiêu đề Epic rõ ràng, phản ánh nội dung chính",
    "summary": "Tóm tắt 2-3 câu về mục đích và phạm vi của epic"
  },
  "context": {
    "background": "Bối cảnh dự án - viết thành đoạn văn mạch lạc, giải thích lý do và hoàn cảnh",
    "objectives": ["Mục tiêu cụ thể, đo lường được"],
    "scope": "Phạm vi rõ ràng - bao gồm và không bao gồm những gì"
  },
  "requirements": [
    {
      "id": "REQ-001",
      "category": "functional|non-functional|constraint",
      "description": "Mô tả chi tiết yêu cầu bằng câu hoàn chỉnh, dễ hiểu",
      "priority": "high|medium|low"
    }
  ],
  "tasks": [
    {
      "id": "TASK-001",
      "description": "Mô tả công việc cần thực hiện - cụ thể, rõ ràng",
      "relatedRequirements": ["REQ-001"]
    }
  ],
  "acceptanceCriteria": ["Tiêu chí nghiệm thu cụ thể, có thể kiểm chứng"],
  "assumptions": ["Giả định và điều kiện tiên quyết"],
  "openQuestions": [
    {
      "question": "Câu hỏi cần làm rõ",
      "context": "Lý do cần hỏi và tác động nếu không giải quyết"
    }
  ],
  "appendix": {
    "figures": ["Mô tả hình minh họa quan trọng"],
    "references": ["Tài liệu tham chiếu"]
  }
}

NGUYÊN TẮC:
1. KHÔNG sử dụng Evidence IDs - loại bỏ hoàn toàn mọi [EV-XXXX-bXXXX]
2. Gộp requirements trùng lặp thành mô tả đầy đủ, súc tích
3. Viết câu hoàn chỉnh với chủ ngữ - vị ngữ rõ ràng
4. Sắp xếp requirements theo priority (high → medium → low)
5. Gộp tasks theo thứ tự logic thực hiện
6. Nội dung phải đọc được như một tài liệu chuyên nghiệp
7. KHÔNG TẠO BẢNG TRÙNG LẶP: Mỗi bảng chỉ xuất hiện MỘT LẦN. Nếu cùng bảng xuất hiện ở
   nhiều chunks, merge thành một bảng duy nhất đầy đủ nhất. KHÔNG lặp lại.
`;
}
