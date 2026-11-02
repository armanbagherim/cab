#!/bin/sh
set -eu

if [ -d prisma/migrations ] && find prisma/migrations -mindepth 1 -maxdepth 1 -type d -print -quit | grep -q .; then
  npx prisma migrate deploy
else
  # This project has no migrations yet. Keep this fallback non-destructive.
  npx prisma db push --skip-generate
fi

exec npm start
