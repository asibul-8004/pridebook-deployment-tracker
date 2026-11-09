# Pridebook Version Tracker Application

A standalone single-page, two-tab application for tracking deployments and releases across all Pridebook ERP client environments and staging release history using **Central GitHub Raw / API**.

## Location
- Application Directory: [`/home/asibul/Pridebook/deployment-tracker/`](file:///home/asibul/Pridebook/deployment-tracker/)
- Application Entry Point: [`index.html`](file:///home/asibul/Pridebook/deployment-tracker/index.html) (or `version-tracker.html`)
- Live Data: [`deployments.json`](file:///home/asibul/Pridebook/deployment-tracker/deployments.json)
- Server Script: [`server.js`](file:///home/asibul/Pridebook/deployment-tracker/server.js)

---

## Architectural Approach: Central GitHub Raw / API

Instead of modifying `pride-erp-frontend` files (`Dockerfile`, `angular.json`, `nginx.conf`) or baking files into Docker images, the dashboard fetches the single source of truth directly from the GitHub repository (`main` branch).

- **Always in sync**: Whenever GitHub Actions updates `deployments.json` on `main`, all client dashboards update automatically without rebuilding or redeploying any container.
- **Zero image changes**: `pride-erp-frontend` remains untouched.
- **Private Repo Access**: Configured securely via `.env` file (`GITHUB_TOKEN=...`).

---

## Features

### Tab 1: All Clients (Latest Version)
- **Default View**: Modern, clean **List / Table mode**.
- Displays current deployment status for all client target boxes (`stage`, `shinshin`, `karupannya`, etc.).
- Real-time status badges (`Success`, `Pending First Deploy`, `Failed`).
- Current version and previous version comparisons.
- Deployed by (actor) and last deployed timestamp with relative time counter (`(just now)`, `(2h ago)`).
- Direct links to GitHub Actions runs (`#42471364643`).
- KPI metric overview (Total Clients, Deployed, Pending, Current Stage Release).
- Instant search filter and status filter.

### Tab 2: Stage Deployment History (Last 50 Versions)
- Dedicated release log for the staging environment.
- Displays up to 50 real historical deployments from `stage.history`.
- Version tags with 1-click copy button.
- GitHub Actions run links and GitHub release notes links.
- Search and filter stage history by version, actor, or run ID.
- Zero mock data.

### Controls & Utilities
- **Auto-Refresh**: Live toggle polling every 30 seconds.
- **Manual Refresh**: 1-click refresh with cache-busting.
- **Theme**: Dark mode by default with toggle to Light mode.
- **Source Configuration**: GitHub repo, branch, and token settings with fallback to local `deployments.json`.

---

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fasibul-8004%2Fpridebook-deployment-tracker&env=GITHUB_TOKEN,GITHUB_REPO,GITHUB_BRANCH,SOURCE_MODE&envDescription=Configuration%20for%20fetching%20deployments.json%20from%20GitHub)

### Steps to Deploy via Vercel Web Dashboard:

1. Go to [vercel.com](https://vercel.com) and log in with your GitHub account.
2. Click **Add New...** -> **Project**.
3. Under **Import Git Repository**, select **`asibul-8004/pridebook-deployment-tracker`** and click **Import**.
4. In the **Environment Variables** section, add:
   - `GITHUB_TOKEN`: `ghp_...` (Your GitHub Personal Access Token)
   - `GITHUB_REPO`: `pride-erp-local/pride-erp-frontend`
   - `GITHUB_BRANCH`: `main`
   - `SOURCE_MODE`: `github`
5. Click **Deploy**.

Vercel will build the project and assign a production URL (e.g., `https://pridebook-deployment-tracker.vercel.app`).

---

## How to Run Locally

1. Configure environment variables (optional for public repositories, required for private repositories):
```bash
cp .env.example .env
# Edit .env with your GITHUB_TOKEN and settings
```

2. Start the application:
```bash
cd /home/asibul/Pridebook/deployment-tracker
npm start
```

3. Open **`http://localhost:3000`** in your browser.
