#!/bin/bash
# Run from ~/Developer/rentalcore after unzipping auth-module.zip there.
set -e

echo "Installing new dependencies (bcrypt, JWT, validation)..."
npm install bcrypt @nestjs/jwt class-validator class-transformer
npm install --save-dev @types/bcrypt

echo "Auth module files are already in src/auth/ (from the zip)."
echo "app.module.ts and main.ts have been updated to wire it in."
echo ""
echo "Next: add JWT_SECRET to your .env and to Railway's variables:"
echo "  openssl rand -base64 32"
echo ""
echo "Then run:"
echo "  npm run build"
echo ""
echo "If the build succeeds, commit and push:"
echo "  git add ."
echo "  git commit -m 'Add auth module: register, login, refresh, logout'"
echo "  git push origin main"
