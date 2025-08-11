#!/bin/bash

# 1. Loyihani yangilab olish
git fetch origin

# 2. main branchga o'tish
git checkout main

# 3. Kerakli commit holatiga qaytish
git reset --hard 1fd1f1e


# 4. GitHub'ga majburan push qilish
git push origin main --force

echo "✅ Proyekt 'Update package.json' (1fd1f1e) commit holatiga qaytdi."
