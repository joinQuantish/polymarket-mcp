#!/bin/bash
set -e

echo "Starting Polymarket MCP Server..."

# Wait for database to be ready (with retries)
echo "Waiting for database to be ready..."
MAX_RETRIES=30
RETRY_COUNT=0

until npx prisma db push --accept-data-loss 2>/dev/null; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    echo "ERROR: Database not ready after $MAX_RETRIES retries (2.5 minutes)"
    echo "Starting server anyway - will handle DB errors at runtime"
    break
  fi
  echo "Database not ready (attempt $RETRY_COUNT/$MAX_RETRIES), waiting 5 seconds..."
  sleep 5
done

if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
  echo "Database ready! Schema synced."
fi

echo "Starting Node.js server..."
exec node dist/index.js

