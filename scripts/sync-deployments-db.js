#!/usr/bin/env node
/**
 * Pridebook Deployment Database Sync Script
 * 
 * Usage:
 *   node scripts/sync-deployments-db.js
 *   node scripts/sync-deployments-db.js --list
 *   node scripts/sync-deployments-db.js --toggle <client> <stack> <0|1>
 * 
 * Stack:
 *   'F' = Frontend (pride-erp-frontend)
 *   'B' = Backend  (pride-erp-backend)
 * 
 * is_deployable_to_client:
 *   0 = Deployable (Ready / Good to deploy)
 *   1 = Has an issue (Not deployable / Blocked)
 */

const fs = require('fs');
const path = require('path');

const trackerDir = path.resolve(__dirname, '..');

// Load environment variables from .env if present
function loadEnv() {
  const envPath = path.join(trackerDir, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx !== -1) {
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}

loadEnv();

const db = require('../db');

function printUsage() {
  console.log(`
Pridebook Deployment Database CLI & Sync Tool
=============================================
Usage:
  node scripts/sync-deployments-db.js                  # Sync from GitHub & display table
  node scripts/sync-deployments-db.js --list           # Display current DB records without sync
  node scripts/sync-deployments-db.js --toggle <client> <stack> <0|1>
                                                       # 0 = Deployable, 1 = Has Issue

Examples:
  node scripts/sync-deployments-db.js --toggle stage F 1      # Mark stage Frontend as having an issue
  node scripts/sync-deployments-db.js --toggle stage F 0      # Mark stage Frontend as deployable
  node scripts/sync-deployments-db.js --toggle shinshin B 0   # Mark shinshin Backend as deployable
`);
}

function displayTable(rows) {
  console.log(`\n SQLite Database: ${db.DB_PATH}`);
  console.log(` Table: client_deployments | Total Records: ${rows.length}\n`);

  const formatted = rows.map(r => ({
    'Client Box': r.client_name.toUpperCase(),
    'Stack': r.stack === 'F' ? 'Frontend (F)' : 'Backend (B)',
    'Version': r.version,
    'Status': r.status,
    'Deployable Flag': r.is_deployable_to_client === 0 ? '0 (Deployable)' : '1 (ISSUE - NOT DEPLOYABLE)',
    'Deployed By': r.deployed_by || '-',
    'Last Deployed': r.last_deployed_at ? r.last_deployed_at.replace('T', ' ').replace('Z', ' UTC') : 'Never',
    'Run ID': r.run_id ? `#${r.run_id}` : '-'
  }));

  console.table(formatted);

  const deployableCount = rows.filter(r => r.is_deployable_to_client === 0).length;
  const issueCount = rows.filter(r => r.is_deployable_to_client === 1).length;
  console.log(`Summary: ${deployableCount} Deployable (0), ${issueCount} With Issue (1)\n`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  // Handle manual toggle: --toggle <client> <stack> <0|1>
  const toggleIdx = args.indexOf('--toggle');
  if (toggleIdx !== -1) {
    const client = args[toggleIdx + 1];
    const stack = args[toggleIdx + 2];
    const val = args[toggleIdx + 3];

    if (!client || !stack || val === undefined) {
      console.error('Error: --toggle requires <client> <stack(F|B)> <value(0|1)>');
      printUsage();
      process.exit(1);
    }

    const flagVal = parseInt(val, 10);
    if (flagVal !== 0 && flagVal !== 1) {
      console.error('Error: value must be 0 (deployable) or 1 (has issue)');
      process.exit(1);
    }

    const updated = db.updateDeployableFlag(client, stack.toUpperCase(), flagVal);
    if (!updated) {
      console.error(`Client ${client} [${stack.toUpperCase()}] not found in database.`);
      process.exit(1);
    }

    console.log(` Updated ${client.toUpperCase()} [${stack.toUpperCase()}]:`);
    console.log(`  is_deployable_to_client = ${flagVal} (${flagVal === 0 ? 'Deployable' : 'Has Issue / Not Deployable'})`);
    console.log(`  Updated at: ${updated.updated_at}`);
    process.exit(0);
  }

  // Handle --list only (no sync)
  if (args.includes('--list')) {
    const rows = db.getAllDeployments();
    displayTable(rows);
    process.exit(0);
  }

  // Default: Full Sync from GitHub
  const token = process.env.GITHUB_TOKEN || '';
  console.log('🔄 Syncing deployments from GitHub (Frontend + Backend)...');
  const startTime = Date.now();

  try {
    const rows = await db.syncDatabaseFromGitHub(token);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(` GitHub sync completed in ${duration}s.`);
    displayTable(rows);
  } catch (err) {
    console.error(' Sync failed:', err.message);
    console.log('Displaying current database records:');
    displayTable(db.getAllDeployments());
  }
}

main();
