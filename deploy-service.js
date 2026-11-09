/**
 * Deploy Service - GitHub Workflow Trigger & Status Tracking
 * Handles authentication, selective execution, deployability checks, and cancellation
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const rootDir = __dirname;

function loadEnv() {
  const envPath = path.join(rootDir, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const lines = content.split('\n');
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
          if (['USERNAME', 'PASSWORD', 'AUTH_USERNAME', 'AUTH_PASSWORD'].includes(key) || process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
    } catch (_) {}
  }
}
loadEnv();

function getEnv(key, fallback = '') {
  return process.env[key] || fallback;
}

function getHeaders(token) {
  const effectiveToken = token || getEnv('GITHUB_TOKEN');
  const headers = {
    'User-Agent': 'Pridebook-Deploy-Service',
    'Accept': 'application/vnd.github.v3+json'
  };
  if (effectiveToken) {
    headers['Authorization'] = `token ${effectiveToken.trim()}`;
  }
  return headers;
}

/**
 * Validate credentials against ENV file
 */
function verifyCredentials(username, password) {
  loadEnv();
  const expectedUser = (process.env.AUTH_USERNAME || (process.env.USERNAME && process.env.USERNAME !== process.env.USER ? process.env.USERNAME : null) || 'pridebook').trim();
  const expectedPass = (process.env.AUTH_PASSWORD || process.env.PASSWORD || 'prideerp').trim();
  return (
    Boolean(username) &&
    Boolean(password) &&
    String(username).trim() === expectedUser &&
    String(password).trim() === expectedPass
  );
}

function getAuthSecret() {
  return process.env.AUTH_SECRET || (process.env.PASSWORD || 'prideerp') + '_pride_auth_key_2026';
}

/**
 * Generate HMAC signed authentication token
 */
function generateAuthToken(username) {
  loadEnv();
  const effectiveUser = (username || process.env.AUTH_USERNAME || 'pridebook').trim();
  const timestamp = Date.now();
  const data = `${effectiveUser}:${timestamp}`;
  const sig = crypto.createHmac('sha256', getAuthSecret()).update(data).digest('hex');
  return Buffer.from(`${data}:${sig}`).toString('base64');
}

/**
 * Verify HMAC signed authentication token (valid 24h)
 */
function verifyAuthToken(token) {
  if (!token) return null;
  try {
    loadEnv();
    const raw = Buffer.from(token, 'base64').toString('utf8');
    const parts = raw.split(':');
    if (parts.length !== 3) return null;
    const [user, timeStr, sig] = parts;
    const timestamp = parseInt(timeStr, 10);
    if (Date.now() - timestamp > 24 * 60 * 60 * 1000) return null;
    const expectedSig = crypto.createHmac('sha256', getAuthSecret()).update(`${user}:${timeStr}`).digest('hex');
    const expectedUser = (process.env.AUTH_USERNAME || (process.env.USERNAME && process.env.USERNAME !== process.env.USER ? process.env.USERNAME : null) || 'pridebook').trim();
    if (sig === expectedSig && user === expectedUser) {
      return { valid: true, username: user };
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Check if a version is deployable to client (non-stage)
 * If Deployable to Client == 1, it's flagged as non-deployable (has issue)
 */
async function checkDeployability({ client, frontend_tag, backend_tag }) {
  const targetClient = (client || '').toLowerCase().trim();
  if (!targetClient || targetClient === 'stage') {
    return {
      isStage: true,
      frontend: { deployable: true, message: '' },
      backend: { deployable: true, message: '' }
    };
  }

  const history = await db.getDeploymentHistory();
  const res = {
    isStage: false,
    frontend: { deployable: true, message: '' },
    backend: { deployable: true, message: '' }
  };

  if (frontend_tag && frontend_tag.trim()) {
    const fTag = frontend_tag.trim();
    const blockedF = (history || []).find(h =>
      h.event_stack === 'F' &&
      h.frontend_version === fTag &&
      Number(h.is_deployable_to_client) === 1
    );
    if (blockedF) {
      res.frontend.deployable = false;
      res.frontend.message = `Frontend version [${fTag}] is flagged as non-deployable`;
    }
  }

  if (backend_tag && backend_tag.trim()) {
    const bTag = backend_tag.trim();
    const blockedB = (history || []).find(h =>
      h.event_stack === 'B' &&
      h.backend_version === bTag &&
      Number(h.is_deployable_to_client) === 1
    );
    if (blockedB) {
      res.backend.deployable = false;
      res.backend.message = `Backend version [${bTag}] is flagged as non-deployable`;
    }
  }

  return res;
}

/**
 * Fetch available release tags for Frontend and Backend
 */
async function getReleaseTags(token) {
  const fRepo = getEnv('GITHUB_FRONTEND_REPO') || getEnv('GITHUB_REPO') || 'pride-erp-local/pride-erp-frontend';
  const bRepo = getEnv('GITHUB_BACKEND_REPO') || (getEnv('GITHUB_REPO') ? getEnv('GITHUB_REPO').replace(/-frontend$/, '-backend') : '') || 'pride-erp-local/pride-erp-backend';
  const headers = getHeaders(token);

  async function fetchTags(repo) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=15`, { headers });
      if (!res.ok) return [];
      const data = await res.json();
      return (Array.isArray(data) ? data : [])
        .map(t => t.name)
        .filter(n => /^v[0-9]+\.[0-9]+/.test(n));
    } catch (e) {
      console.warn(`[Deploy Service] Could not fetch tags for ${repo}:`, e.message);
      return [];
    }
  }

  const [frontendTags, backendTags] = await Promise.all([
    fetchTags(fRepo),
    fetchTags(bRepo)
  ]);

  return {
    frontend: frontendTags.length ? frontendTags : ['v1.42.0', 'v1.41.0', 'v1.40.0', 'v1.39.1'],
    backend: backendTags.length ? backendTags : ['v2.10.2', 'v2.10.1', 'v2.10.0', 'v2.9.0']
  };
}

/**
 * Trigger Release Deployment with selective execution, authentication, and deployability validation
 */
async function triggerReleaseDeploy({
  client,
  frontend_tag,
  backend_tag,
  username,
  password,
  authToken,
  token
}) {
  // 1. Authentication check (accepts either username/password or valid session token)
  let isAuth = false;
  if (username && password && verifyCredentials(username, password)) {
    isAuth = true;
  } else if (authToken && verifyAuthToken(authToken)) {
    isAuth = true;
  }

  if (!isAuth) {
    const err = new Error('Invalid or missing authentication credentials');
    err.statusCode = 401;
    throw err;
  }

  const targetClient = (client || '').toLowerCase().trim();
  const allowedClients = ['stage', 'shinshin', 'karupannya', 'bengal', 'arrival', 'ananta-uat', 'ananta-live'];
  if (!allowedClients.includes(targetClient)) {
    throw new Error(`Invalid client '${targetClient}'. Allowed: ${allowedClients.join(', ')}`);
  }

  const fTag = (frontend_tag || '').trim();
  const bTag = (backend_tag || '').trim();

  // 2. Selective Execution: require at least one version
  if (!fTag && !bTag) {
    throw new Error('Please specify at least a Frontend Version or a Backend Version');
  }

  const tagRegex = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
  if (fTag && !tagRegex.test(fTag)) {
    throw new Error(`Invalid frontend tag '${fTag}'. Must match strict vX.Y.Z (e.g. v1.42.0)`);
  }
  if (bTag && !tagRegex.test(bTag)) {
    throw new Error(`Invalid backend tag '${bTag}'. Must match strict vX.Y.Z (e.g. v2.10.2)`);
  }

  // 3. Client & Version Deployability Validation
  const deployability = await checkDeployability({
    client: targetClient,
    frontend_tag: fTag,
    backend_tag: bTag
  });

  const fDeployable = deployability.frontend.deployable;
  const bDeployable = deployability.backend.deployable;

  const fShouldRun = Boolean(fTag && fDeployable);
  const bShouldRun = Boolean(bTag && bDeployable);

  const blockedWarnings = [];
  if (fTag && !fDeployable) {
    blockedWarnings.push(deployability.frontend.message);
  }
  if (bTag && !bDeployable) {
    blockedWarnings.push(deployability.backend.message);
  }

  // If no requested component is deployable, reject
  if (!fShouldRun && !bShouldRun) {
    throw new Error(blockedWarnings.join('. '));
  }

  const fRepo = getEnv('GITHUB_FRONTEND_REPO') || getEnv('GITHUB_REPO') || 'pride-erp-local/pride-erp-frontend';
  const bRepo = getEnv('GITHUB_BACKEND_REPO') || (getEnv('GITHUB_REPO') ? getEnv('GITHUB_REPO').replace(/-frontend$/, '-backend') : '') || 'pride-erp-local/pride-erp-backend';
  const headers = {
    ...getHeaders(token),
    'Content-Type': 'application/json'
  };

  const dispatchWorkflow = async (repo, tag, stackName) => {
    const url = `https://api.github.com/repos/${repo}/actions/workflows/release-deploy.yml/dispatches`;
    const body = JSON.stringify({
      ref: 'main',
      inputs: {
        tag: tag.trim(),
        client: targetClient
      }
    });

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body
    });

    if (res.status === 204) {
      return { success: true, repo, tag: tag.trim(), client: targetClient, stack: stackName };
    }

    const errText = await res.text();
    let errMsg = `GitHub API HTTP ${res.status}: ${res.statusText}`;
    try {
      const errJson = JSON.parse(errText);
      if (errJson.message) errMsg = errJson.message;
    } catch (_) {}
    throw new Error(`Failed to dispatch ${stackName} deploy on ${repo}: ${errMsg}`);
  };

  const tasks = [];
  if (fShouldRun) {
    tasks.push(dispatchWorkflow(fRepo, fTag, 'Frontend'));
  }
  if (bShouldRun) {
    tasks.push(dispatchWorkflow(bRepo, bTag, 'Backend'));
  }

  const results = await Promise.all(tasks);
  const fResult = fShouldRun ? results.find(r => r.stack === 'Frontend') : null;
  const bResult = bShouldRun ? results.find(r => r.stack === 'Backend') : null;

  return {
    success: true,
    client: targetClient,
    timestamp: new Date().toISOString(),
    frontend: fResult,
    backend: bResult,
    warnings: blockedWarnings
  };
}

/**
 * Cancel an active GitHub workflow run
 */
async function cancelDeployRun({ stack, run_id, token }) {
  if (!run_id) throw new Error('Missing run_id to cancel');
  const isBackend = stack && stack.toLowerCase().startsWith('b');
  const repo = isBackend
    ? (getEnv('GITHUB_BACKEND_REPO') || (getEnv('GITHUB_REPO') ? getEnv('GITHUB_REPO').replace(/-frontend$/, '-backend') : '') || 'pride-erp-local/pride-erp-backend')
    : (getEnv('GITHUB_FRONTEND_REPO') || getEnv('GITHUB_REPO') || 'pride-erp-local/pride-erp-frontend');

  const headers = getHeaders(token);
  const url = `https://api.github.com/repos/${repo}/actions/runs/${run_id}/cancel`;
  const res = await fetch(url, {
    method: 'POST',
    headers
  });

  if (res.status === 202) {
    return { success: true, message: `Deployment run #${run_id} cancellation requested` };
  }

  let errMsg = `HTTP ${res.status}: ${res.statusText}`;
  try {
    const d = await res.json();
    if (d.message) errMsg = d.message;
  } catch (_) {}
  throw new Error(`Failed to cancel run #${run_id}: ${errMsg}`);
}

const statusJobsCache = new Map();

/**
 * Query live deployment status for recent release runs
 */
async function getDeployStatus({ client, frontend_tag, backend_tag, token }) {
  const targetClient = (client || '').toLowerCase().trim();
  const fRepo = getEnv('GITHUB_FRONTEND_REPO') || getEnv('GITHUB_REPO') || 'pride-erp-local/pride-erp-frontend';
  const bRepo = getEnv('GITHUB_BACKEND_REPO') || (getEnv('GITHUB_REPO') ? getEnv('GITHUB_REPO').replace(/-frontend$/, '-backend') : '') || 'pride-erp-local/pride-erp-backend';
  const headers = getHeaders(token);

  async function checkRunStatus(repo, expectedTag, stackName) {
    try {
      const runsUrl = `https://api.github.com/repos/${repo}/actions/workflows/release-deploy.yml/runs?per_page=5`;
      const res = await fetch(runsUrl, { headers });
      if (!res.ok) {
        return { status: 'unknown', message: `HTTP ${res.status}` };
      }
      const data = await res.json();
      const runs = (data.workflow_runs || []).slice(0, 3);

      // Find matching run
      for (const run of runs) {
        let matches = false;
        let activeJobName = '';

        if (statusJobsCache.has(run.id)) {
          const cached = statusJobsCache.get(run.id);
          matches = cached.matches;
          activeJobName = cached.activeJobName;
        } else {
          try {
            const jobsRes = await fetch(run.jobs_url, { headers });
            if (jobsRes.ok) {
              const jobsData = await jobsRes.json();
              for (const job of jobsData.jobs || []) {
                const nameLower = job.name.toLowerCase();
                if (
                  nameLower.includes(targetClient) ||
                  (expectedTag && nameLower.includes(expectedTag.toLowerCase()))
                ) {
                  matches = true;
                  activeJobName = job.name;
                  break;
                }
              }
            }
          } catch (_) {}

          if (run.status === 'completed') {
            statusJobsCache.set(run.id, { matches, activeJobName });
          }
        }

        const createdMs = new Date(run.created_at).getTime();
        const isRecent = (Date.now() - createdMs) < (15 * 60 * 1000);

        if (matches || isRecent) {
          let cardStatus = 'queued';
          if (run.status === 'in_progress') {
            cardStatus = 'deploying';
          } else if (run.status === 'completed') {
            if (run.conclusion === 'success') cardStatus = 'deployed';
            else if (run.conclusion === 'cancelled') cardStatus = 'cancelled';
            else cardStatus = 'failed';
          } else if (run.status === 'queued') {
            cardStatus = 'queued';
          }

          return {
            status: cardStatus,
            raw_status: run.status,
            conclusion: run.conclusion,
            run_id: String(run.id),
            run_number: run.run_number,
            run_url: run.html_url,
            active_job: activeJobName || run.name,
            started_at: run.created_at,
            updated_at: run.updated_at,
            actor: run.actor ? run.actor.login : 'system'
          };
        }
      }

      return { status: 'idle', message: 'No active deployment found' };
    } catch (err) {
      return { status: 'unknown', error: err.message };
    }
  }

  const [frontendStatus, backendStatus] = await Promise.all([
    frontend_tag ? checkRunStatus(fRepo, frontend_tag, 'Frontend') : Promise.resolve({ status: 'idle' }),
    backend_tag ? checkRunStatus(bRepo, backend_tag, 'Backend') : Promise.resolve({ status: 'idle' })
  ]);

  return {
    client: targetClient,
    frontend: frontendStatus,
    backend: backendStatus,
    timestamp: new Date().toISOString()
  };
}

/**
 * Fetch recent runs from both repos for display on the release page
 */
async function getRecentDeployments(token) {
  const fRepo = getEnv('GITHUB_FRONTEND_REPO') || getEnv('GITHUB_REPO') || 'pride-erp-local/pride-erp-frontend';
  const bRepo = getEnv('GITHUB_BACKEND_REPO') || (getEnv('GITHUB_REPO') ? getEnv('GITHUB_REPO').replace(/-frontend$/, '-backend') : '') || 'pride-erp-local/pride-erp-backend';

  try {
    const history = await db.getDeploymentHistory();
    if (Array.isArray(history) && history.length > 0) {
      return history.slice(0, 15).map(h => {
        const isBackend = h.event_stack === 'B';
        const repo = isBackend ? bRepo : fRepo;
        const version = isBackend ? h.backend_version : h.frontend_version;
        return {
          stack: isBackend ? 'Backend' : 'Frontend',
          client: (h.client_name || 'stage').toLowerCase(),
          id: h.run_id || h.deployment_tracker_dtl_no,
          run_number: h.run_id ? String(h.run_id).slice(-4) : h.deployment_tracker_dtl_no,
          name: isBackend ? 'Release Deploy (API)' : 'Release Deploy',
          version: version || 'unknown',
          status: h.status || 'success',
          conclusion: h.status || 'success',
          run_url: h.run_id ? `https://github.com/${repo}/actions/runs/${h.run_id}` : '#',
          actor: h.deployed_by || 'system',
          created_at: h.event_time || h.frontend_deployed_at || h.backend_deployed_at || new Date().toISOString()
        };
      });
    }
  } catch (err) {
    console.warn('[Recent Runs DB fallback warn]:', err.message);
  }

  const headers = getHeaders(token);
  async function fetchRecent(repo, stack) {
    try {
      const url = `https://api.github.com/repos/${repo}/actions/workflows/release-deploy.yml/runs?per_page=6`;
      const res = await fetch(url, { headers });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.workflow_runs || []).map(r => ({
        stack,
        client: 'stage',
        id: r.id,
        run_number: r.run_number,
        name: r.name,
        version: '',
        status: r.status,
        conclusion: r.conclusion,
        run_url: r.html_url,
        actor: r.actor ? r.actor.login : 'system',
        created_at: r.created_at
      }));
    } catch (e) {
      return [];
    }
  }

  const [fRuns, bRuns] = await Promise.all([
    fetchRecent(fRepo, 'Frontend'),
    fetchRecent(bRepo, 'Backend')
  ]);

  return [...fRuns, ...bRuns].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

module.exports = {
  verifyCredentials,
  generateAuthToken,
  verifyAuthToken,
  checkDeployability,
  getReleaseTags,
  triggerReleaseDeploy,
  cancelDeployRun,
  getDeployStatus,
  getRecentDeployments
};
