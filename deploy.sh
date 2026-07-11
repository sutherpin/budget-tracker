#!/bin/bash
set -e  # stop immediately if any step fails

echo "📝 Commit message:"
read -r commit_msg

if [ -z "$commit_msg" ]; then
  echo "❌ Empty commit message, aborting."
  exit 1
fi

echo "➕ Staging changes..."
git add -A

echo "💾 Committing..."
git commit -m "$commit_msg"

echo "⬆️  Pushing to GitHub..."
git push

echo "☁️  Deploying to Cloudflare..."
wrangler deploy

echo "✅ Done — pushed to GitHub and deployed to Cloudflare"
