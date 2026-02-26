#!/bin/bash
# Run excel-epic-md pipeline when Gemini quota resets
# Gemini quota resets at midnight UTC = 7:00 AM Vietnam time

cd /home/linhnt102/fdx-neomatch/tool/excel-epic-md

LOG_FILE="pipeline-scheduled-$(date +%Y%m%d-%H%M%S).log"

echo "=== Pipeline started at $(date) ===" | tee -a "$LOG_FILE"

NODE_TLS_REJECT_UNAUTHORIZED=0 timeout 7200 bun cli.mjs \
  --input "Sprint23_3305：ユーザー・ロール・マスターデータ・システムコードのインポートを行う.xlsx" \
  2>&1 | tee -a "$LOG_FILE"

echo "=== Pipeline finished at $(date) ===" | tee -a "$LOG_FILE"
