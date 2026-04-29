#!/bin/bash
echo "🔁 Reset Shopify Dev..."
rm -rf .shopify
rm -rf node_modules/.cache
shopify app dev
