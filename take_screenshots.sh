#!/bin/bash
SAVE="$HOME/Desktop/Fayeyu-Podcast-Gallery/screenshots"
mkdir -p "$SAVE"

echo "=== Fayeyu's Podcast Gallery 截图工具 ==="
echo "请先在浏览器中打开 http://localhost:3456"
echo ""

pages=("01-dashboard" "02-pending" "03-done" "04-notes-drawer" "05-knowledge-graph" "06-best-of-faye" "07-search")
labels=("控制台" "待处理" "已提炼" "笔记抽屉(点查看笔记)" "知识图谱" "Best of Faye" "搜索播客(点添加后输入)")

for i in "${!pages[@]}"; do
  echo "[$((i+1))/7] 请切换到「${labels[$i]}」页面，然后按回车截图..."
  read
  screencapture -x "$SAVE/${pages[$i]}.png"
  echo "  -> 已保存 ${pages[$i]}.png"
done

echo ""
echo "全部截图完成！保存在 $SAVE/"
ls -lh "$SAVE"/*.png
