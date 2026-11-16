#!/usr/bin/env node
/**
 * Manifest generator for BrowserAgent extension.
 * 
 * Scans extension/src/providers/ directory for provider plugins and injects
 * their hostPermissions into extension/manifest.json.
 * 
 * Usage: node scripts/generate-manifest.mjs
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(__dirname, '..', 'extension');
const PROVIDERS_DIR = join(EXTENSION_DIR, 'src', 'providers');
const MANIFEST_PATH = join(EXTENSION_DIR, 'manifest.json');

function loadProviderInfo(providerDir) {
  const indexPath = join(providerDir, 'index.ts');
  if (!existsSync(indexPath)) return null;
  
  // Read the file and extract providerInfo export
  const content = readFileSync(indexPath, 'utf8');
  const match = content.match(/export\s+const\s+providerInfo\s*=\s*({[\s\S]*?});/);
  if (!match) return null;
  
  try {
    // Simple eval for the object literal (safe since we control the providers)
    return eval(`(${match[1]})`);
  } catch (e) {
    console.warn(`Failed to parse providerInfo from ${indexPath}:`, e.message);
    return null;
  }
}

function scanProviders() {
  if (!existsSync(PROVIDERS_DIR)) {
    console.log('No providers directory found');
    return [];
  }
  
  const entries = readdirSync(PROVIDERS_DIR, { withFileTypes: true });
  const providers = [];
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    const providerDir = join(PROVIDERS_DIR, entry.name);
    const info = loadProviderInfo(providerDir);
    
    if (info && info.permissions?.hostPermissions) {
      providers.push({
        id: info.id || entry.name,
        name: info.name || entry.name,
        hostPermissions: info.permissions.hostPermissions
      });
    }
  }
  
  return providers;
}

function updateManifest(providers) {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  
  // Collect all host permissions from providers
  const allHostPermissions = providers.flatMap(p => p.hostPermissions || []);
  
  // Remove duplicates
  const uniquePermissions = [...new Set(allHostPermissions)];
  
  // Update or add host_permissions
  if (uniquePermissions.length > 0) {
    manifest.host_permissions = uniquePermissions;
    console.log(`Injected ${uniquePermissions.length} host permission(s) from ${providers.length} provider(s)`);
  } else {
    delete manifest.host_permissions;
    console.log('No host permissions to inject');
  }
  
  // Write back
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('Manifest updated:', MANIFEST_PATH);
}

function main() {
  console.log('Scanning providers...');
  const providers = scanProviders();
  
  if (providers.length === 0) {
    console.log('No providers with hostPermissions found');
  } else {
    console.log(`Found ${providers.length} provider(s):`, providers.map(p => p.id).join(', '));
  }
  
  updateManifest(providers);
}

main();
