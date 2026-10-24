#!/usr/bin/env bash
# 題庫分析模組 雲端測試版 一鍵部署
# 用法：bash qbank/scripts/deploy.sh [測試子網域]
# 前提：已 `npx wrangler login` 登入該網域所在的 Cloudflare 帳號；Node 22+。
# 做的事：1) 沒有 D1 就建立並把 id 寫進 wrangler.jsonc  2) 沒有 QBANK_AUTH 密鑰就要求輸入  3) 部署（可同時綁自訂網域）
set -euo pipefail
cd "$(dirname "$0")/.."
DOMAIN="${1:-}"
PLACEHOLDER="00000000-0000-0000-0000-000000000000"

echo "== 1/3 D1 資料庫"
if grep -q "$PLACEHOLDER" wrangler.jsonc; then
  set +e
  created=$(npx wrangler d1 create qbank-test 2>&1)
  set -e
  id=$(printf '%s' "$created" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)
  if [ -z "$id" ]; then
    # 可能已存在：改查詢
    id=$(npx wrangler d1 info qbank-test --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.uuid||j.id||"")})')
  fi
  if [ -z "$id" ]; then echo "無法取得 D1 database_id，請手動執行 npx wrangler d1 create qbank-test 並填入 wrangler.jsonc"; exit 1; fi
  sed -i.bak "s/$PLACEHOLDER/$id/" wrangler.jsonc && rm -f wrangler.jsonc.bak
  echo "   已寫入 database_id=$id（wrangler.jsonc 已修改，請勿把真實 id 以外的東西提交）"
else
  echo "   wrangler.jsonc 已有 database_id，略過建立"
fi

echo "== 2/3 登入密鑰 QBANK_AUTH"
if npx wrangler secret list 2>/dev/null | grep -q '"QBANK_AUTH"'; then
  echo "   已存在，略過（要換密碼：npx wrangler secret put QBANK_AUTH）"
else
  echo "   請輸入「帳號:密碼」（只用英數與符號，不要中文；不會顯示在畫面）："
  npx wrangler secret put QBANK_AUTH
fi

echo "== 3/3 部署"
if [ -n "$DOMAIN" ]; then
  npx wrangler deploy --domains "$DOMAIN"
  echo "   已部署並綁定自訂網域：https://$DOMAIN/"
else
  npx wrangler deploy
  echo "   已部署（未綁網域；要綁：bash qbank/scripts/deploy.sh 子網域，或在後台 Domains & Routes 加入）"
fi
echo "請依 docs/07 第二節做部署後檢查（未登入要 401、robots Disallow、匯入範例 8 題）。"
