#!/bin/bash
# ZXZ 交易機械人後端 - 一鍵安裝腳本
echo "============================================="
echo "  ZXZ Trading Bot Engine - 安裝腳本"
echo "============================================="

echo ""
echo "📦 安裝 Node.js 依賴..."
npm install

echo ""
echo "🔑 設定環境變數..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  請編輯 .env 檔案填入您的 API Key"
fi

echo ""
echo "✅ 安裝完成!"
echo ""
echo "📋 使用方式:"
echo "  npm start          # 啟動交易引擎"
echo "  node server.js     # 啟動 (開發模式)"
echo ""
echo "🔗 前端連接設定:"
echo "  在 ZXZ 平台 -> 交易機械人 -> 後端交易引擎連線"
echo "  輸入: http://YOUR_SERVER_IP:3000"
echo ""
echo "⚠️  重要: 請先編輯 .env 填入您的幣安 API Key"
echo "  並確保 IP 白名單設為您的伺服器 IP"
echo "============================================="
