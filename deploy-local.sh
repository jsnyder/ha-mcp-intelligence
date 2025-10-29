#!/bin/bash
set -e

# Local deployment script for HA MCP Intelligence Add-on
# This script copies the add-on to Home Assistant and installs it locally

HA_HOST="${HA_HOST:-assistant.5745.house}"
HA_USER="${HA_USER:-root}"
SSH_KEY="${SSH_KEY:-~/.ssh/id_ed25519_ha}"
ADDON_SLUG="ha-mcp-intelligence"

echo "🚀 Deploying HA MCP Intelligence Add-on to ${HA_HOST}"
echo

# Step 1: Build locally first to catch any errors
echo "📦 Building TypeScript..."
npm run build
if [ $? -ne 0 ]; then
  echo "❌ Build failed!"
  exit 1
fi
echo "✅ Build successful"
echo

# Step 2: Create temporary deployment package (exclude node_modules, .env, etc.)
echo "📁 Creating deployment package..."
TEMP_DIR=$(mktemp -d)
ADDON_DIR="${TEMP_DIR}/${ADDON_SLUG}"
mkdir -p "${ADDON_DIR}"

# Copy essential files
cp -r src dist package*.json tsconfig.json "${ADDON_DIR}/"
cp config.yaml build.yaml Dockerfile run.sh README.md "${ADDON_DIR}/"

# Create a tarball
tar -czf "/tmp/${ADDON_SLUG}.tar.gz" -C "${TEMP_DIR}" "${ADDON_SLUG}"
echo "✅ Package created: /tmp/${ADDON_SLUG}.tar.gz"
echo

# Step 3: Copy to Home Assistant
echo "📤 Copying to Home Assistant..."
scp -i "${SSH_KEY}" "/tmp/${ADDON_SLUG}.tar.gz" "${HA_USER}@${HA_HOST}:/tmp/"
echo "✅ Copied to HA"
echo

# Step 4: Extract and install on HA
echo "🔧 Installing on Home Assistant..."
ssh -i "${SSH_KEY}" "${HA_USER}@${HA_HOST}" << 'ENDSSH'
set -e

ADDON_SLUG="ha-mcp-intelligence"

# Create local add-ons directory if it doesn't exist
mkdir -p /addons/${ADDON_SLUG}

# Extract the add-on
cd /addons
rm -rf ${ADDON_SLUG}
tar -xzf /tmp/${ADDON_SLUG}.tar.gz
rm /tmp/${ADDON_SLUG}.tar.gz

echo "✅ Add-on extracted to /addons/${ADDON_SLUG}"
echo
echo "📋 Next steps:"
echo "1. Go to Settings → Add-ons → Add-on Store"
echo "2. Click the ⋮ menu (top right) → Repositories"
echo "3. Add repository: /addons"
echo "4. Refresh and install 'Home Assistant MCP Intelligence Server'"
echo "5. Configure and start the add-on"
ENDSSH

# Cleanup
rm -rf "${TEMP_DIR}" "/tmp/${ADDON_SLUG}.tar.gz"

echo
echo "🎉 Deployment complete!"
echo
echo "📋 Manual steps required:"
echo "   1. Open Home Assistant → Settings → Add-ons"
echo "   2. Click ⋮ (top right) → Repositories"
echo "   3. Add: /addons"
echo "   4. Refresh the add-on store"
echo "   5. Find and install: Home Assistant MCP Intelligence Server"
echo "   6. Configure: log_level, cache_ttl_seconds"
echo "   7. Start the add-on"
echo
echo "   View logs: http://${HA_HOST}:8123/hassio/addon/${ADDON_SLUG}/logs"
