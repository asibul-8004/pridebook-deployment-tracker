/**
 * Deploy Service - GitHub Workflow Trigger & Status Tracking
 * Handles dual trigger of release-deploy.yml for frontend and backend repositories
 */

const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
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
 * Trigger both Frontend and Backend release-deploy.yml workflows
 */
async function triggerDualDeploy({ client, frontend_tag, backend_tag, token }) {
  const targetClient = (client || '').toLowerCase().trim();
  const allowedClients = ['stage', 'shinshin', 'karupannya', 'bengal', 'arrival', 'ananta-uat', 'ananta-live'];
  if (!allowedClients.includes(targetClient)) {
    throw new Error(`Invalid client '${targetClient}'. Allowed: ${allowedClients.join(', ')}`);
  }

  const tagRegex = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
  if (!frontend_tag || !tagRegex.test(frontend_tag.trim())) {
    throw new Error(`Invalid frontend tag '${frontend_tag}'. Must match strict vX.Y.Z (e.g. v1.42.0)`);
  }
  if (!backend_tag || !tagRegex.test(backend_tag.trim())) {
    throw new Error(`Invalid backend tag '${backend_tag}'. Must match strict vX.Y.Z (e.g. v2.10.2)`);
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
      return { success: true, repo, tag: tag.trim(), client: targetClient };
    }

    const errText = await res.text();
    let errMsg = `GitHub API HTTP ${res.status}: ${res.statusText}`;
    try {
      const errJson = JSON.parse(errText);
      if (errJson.message) errMsg = errJson.message;
    } catch (_) {}
    throw new Error(`Failed to dispatch ${stackName} deploy on ${repo}: ${errMsg}`);
  };

  const [fResult, bResult] = await Promise.all([
    dispatchWorkflow(fRepo, frontend_tag, 'Frontend'),
    dispatchWorkflow(bRepo, backend_tag, 'Backend')
  ]);

  return {
    success: true,
    client: targetClient,
    timestamp: new Date().toISOString(),
    frontend: fResult,
    backend: bResult
  };
}

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
      const runsUrl = `https://api.github.com/repos/${repo}/actions/workflows/release-deploy.yml/runs?per_page=10`;
      const res = await fetch(runsUrl, { headers });
      if (!res.ok) {
        return { status: 'unknown', message: `HTTP ${res.status}` };
      }
      const data = await res.json();
      const runs = data.workflow_runs || [];

      // Find matching run
      for (const run of runs) {
        let matches = false;
        let activeJobName = '';

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

        // Fallback match: if run was created very recently (< 15 mins) and matches
        const createdMs = new Date(run.created_at).getTime();
        const isRecent = (Date.now() - createdMs) < (15 * 60 * 1000);

        if (matches || isRecent) {
          let cardStatus = 'queued';
          if (run.status === 'in_progress') {
            cardStatus = 'deploying';
          } else if (run.status === 'completed') {
            cardStatus = run.conclusion === 'success' ? 'deployed' : 'failed';
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
    checkRunStatus(fRepo, frontend_tag, 'Frontend'),
    checkRunStatus(bRepo, backend_tag, 'Backend')
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
  const headers = getHeaders(token);

  async function fetchRecent(repo, stack) {
    try {
      const url = `https://api.github.com/repos/${repo}/actions/workflows/release-deploy.yml/runs?per_page=6`;
      const res = await fetch(url, { headers });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.workflow_runs || []).map(r => ({
        stack,
        id: r.id,
        run_number: r.run_number,
        name: r.name,
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
  getReleaseTags,
  triggerDualDeploy,
  getDeployStatus,
  getRecentDeployments
};
