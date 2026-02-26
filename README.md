# Excel → Epic Requirement MD

Chuyển đổi file Excel (có Shape/Chart/TextBox) thành file Markdown Epic Requirement tiếng Việt, đầy đủ ngữ cảnh và traceable.

## Yêu cầu hệ thống

### Linux (Ubuntu/Debian)
```bash
# Bun runtime
curl -fsSL https://bun.sh/install | bash

# LibreOffice (render Excel → PNG) - headless mode is built-in
sudo apt-get install libreoffice-calc

# Poppler (PDF → PNG)
sudo apt-get install poppler-utils

# uv (Python package manager - faster than pip)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Python 3.11+ với PaddleOCR (trong venv riêng)
cd tool/excel-epic-md
uv venv .venv --python 3.12  # PaddlePaddle chỉ hỗ trợ Python 3.9-3.13
source .venv/bin/activate
uv pip install paddleocr paddlepaddle
# Hoặc với GPU: uv pip install paddlepaddle-gpu
```

### macOS
```bash
# Bun runtime
curl -fsSL https://bun.sh/install | bash

brew install --cask libreoffice
brew install poppler

# uv (Python package manager)
brew install uv

# Python với PaddleOCR
cd tool/excel-epic-md
uv venv .venv --python 3.12
source .venv/bin/activate
uv pip install paddleocr paddlepaddle
```

## Cài đặt

```bash
cd tool/excel-epic-md
cp .env.example .env
# Sửa .env và cấu hình LLM provider

bun install
```

## LLM Providers

Tool hỗ trợ nhiều LLM providers. Chọn provider trong `.env`:

### 1. Google Gemini (mặc định)
```env
LLM_PROVIDER=gemini
GEMINI_API_KEY=your-api-key
GEMINI_MODEL=gemini-1.5-pro
```

### 2. GitHub Models
GitHub cung cấp free tier cho developers. Lấy token tại [github.com/settings/tokens](https://github.com/settings/tokens).
```env
LLM_PROVIDER=github
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
GITHUB_MODEL=gpt-4o
# Các model khác: gpt-4o-mini, o1-preview, o1-mini
```

### 3. OpenAI
```env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-xxxxxxxxxxxx
OPENAI_MODEL=gpt-4o
```

### 4. Azure OpenAI (Enterprise SLA)
Azure OpenAI cung cấp 99.9% SLA uptime, phù hợp cho môi trường production.
```env
LLM_PROVIDER=azure
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=xxxxxxxxxxxx
AZURE_OPENAI_DEPLOYMENT=gpt-4o
AZURE_OPENAI_API_VERSION=2024-02-15-preview  # Optional, default 2024-02-15-preview
```

### 5. OpenRouter (Claude, Gemini, Llama via API)
[OpenRouter](https://openrouter.ai/) cung cấp unified API cho nhiều LLM providers.
```env
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-xxxxxxxxxxxx
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet
# Các model khác: google/gemini-pro-1.5, meta-llama/llama-3.1-70b-instruct
```

### 6. Ollama (Local LLM)
Chạy LLM locally với [Ollama](https://ollama.ai/).
```bash
# Install và chạy model
ollama pull llama3.1
ollama serve
```
```env
LLM_PROVIDER=ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.1
```

## Sử dụng

### Chạy toàn bộ pipeline
```bash
bun start -- --input /path/to/file.xlsx
```

### Chạy từng bước (debug)
```bash
# Bước 1: Render Excel → PNG
bun run render -- --input /path/to/file.xlsx

# Bước 2: OCR các page
bun run ocr -- --input ../../outputs/<basename>

# Bước 3: Synthesis với Gemini
bun run synthesize -- --input ../../outputs/<basename>

# Bước 4: Assemble output.md
bun run assemble -- --input ../../outputs/<basename>
```

## Output

```
outputs/<basename>/
├── manifest.json           # Metadata, mapping
├── render/
│   └── pages/
│       ├── page-0001.png
│       └── ...
├── ocr/
│   ├── page-0001.json      # blocks + bbox + confidence
│   └── ...
├── llm/
│   ├── page_summaries/     # Per-page extraction
│   └── epic_synthesis.json # Merged synthesis
└── output.md               # Final Epic Requirement
```

## Evidence ID Format

- `EV-p####-b####`: Page + Block
  - `p####`: 1-based page index (4 digits)
  - `b####`: 1-based block index (4 digits)
  - Example: `EV-p0007-b0012`

## OCR Confidence Threshold

- `>= 0.7`: Tạo requirement bình thường
- `< 0.7`: Đánh dấu ambiguous → N/A + Open Questions

## Epic Sections (tiếng Việt)

1. Bối cảnh (Background)
2. Mục tiêu (Goals)
3. Phạm vi (Scope)
4. Yêu cầu chức năng (FR)
5. Yêu cầu phi chức năng (NFR)
6. Tiêu chí nghiệm thu (Acceptance Criteria)
7. Công việc (Work Items)
8. Rủi ro (Risks)
9. Câu hỏi mở (Open Questions)
10. Traceability

## Troubleshooting

### LibreOffice render lỗi
```bash
# Kiểm tra LibreOffice
libreoffice --version

# Chạy manual test
libreoffice --headless --convert-to pdf --outdir /tmp /path/to/file.xlsx
```

### PaddleOCR lỗi
```bash
# Kiểm tra Python (trong venv)
source .venv/bin/activate
python3 -c "from paddleocr import PaddleOCR; print('OK')"

# Nếu lỗi, cài lại
uv pip uninstall paddleocr paddlepaddle
uv pip install paddleocr paddlepaddle
```

### Gemini API lỗi
```bash
# Kiểm tra API key
curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY"
```
