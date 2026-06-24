#!/bin/bash
set -e

# update-plugin.sh
# This script builds the Tessera plugin and installs it inside the PeerTube Docker container.

echo "🔄 Pulling latest version from GitHub..."
git fetch origin
git reset --hard origin/main


echo "📦 Building the Tessera Plugin..."
npm install
npm run build
# Remove old tarballs so we don't accidentally deploy them
rm -f peertube-plugin-tessera-*.tgz
npm pack

# Find the generated tarball (e.g. peertube-plugin-tessera-1.0.9.tgz)
TARBALL=$(ls peertube-plugin-tessera-*.tgz | sort -V | tail -n 1)

if [ -z "$TARBALL" ]; then
    echo "❌ Error: Tarball not found. Build may have failed."
    exit 1
fi

# Find the PeerTube container dynamically
CONTAINER=${PEERTUBE_CONTAINER:-$(docker ps --format '{{.Names}}' | awk '/peertube/ && !/redis/ && !/postgres/ && !/postfix/ && !/webserver/ && !/reloader/ {print; exit}')}

if [ -z "$CONTAINER" ]; then
    echo "❌ Error: Could not find PeerTube container. Is Docker running?"
    echo "You can manually set the container name like this:"
    echo "PEERTUBE_CONTAINER=my_peertube_container ./update-plugin.sh"
    exit 1
fi

echo "🎯 Using PeerTube container: $CONTAINER"
echo "🚀 Transferring $TARBALL to the PeerTube container..."

# Remove any previous leftover files
docker exec $CONTAINER sh -c "rm -rf /tmp/peertube-plugin-tessera*"

# Copy the new tarball
docker cp $TARBALL $CONTAINER:/tmp/

echo "⚙️ Installing the plugin inside the container..."

# Clean corrupt pnpm state and install fresh
docker exec $CONTAINER sh -c "
  echo '🧹 Uninstalling old plugin version...' &&
  npm run plugin:uninstall -- --npm-name peertube-plugin-tessera || true &&
  echo '🧹 Cleaning corrupt plugin state...' &&
  rm -rf /data/plugins/node_modules/peertube-plugin-tessera* &&
  rm -f /data/plugins/pnpm-lock.yaml &&
  node -e \"
    const fs = require('fs');
    const path = '/data/plugins/package.json';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (pkg.dependencies) delete pkg.dependencies['peertube-plugin-tessera'];
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2));
    console.log('Cleaned package.json');
  \" &&
  rm -rf /tmp/peertube-plugin-tessera &&
  mkdir -p /tmp/peertube-plugin-tessera &&
  tar -xzf /tmp/$TARBALL -C /tmp/peertube-plugin-tessera --strip-components=1 &&
  echo '📥 Running plugin:install...' &&
  npm run plugin:install -- --plugin-path /tmp/peertube-plugin-tessera
"

echo "🔄 Restarting PeerTube to apply changes..."
docker restart $CONTAINER

echo "✅ Plugin update complete!"
