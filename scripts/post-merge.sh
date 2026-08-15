#!/bin/bash
set -e

# Install any new dependencies introduced by merged tasks
npm install

# Sync database schema (project uses drizzle db:push, no migration files)
npm run db:push -- --force
