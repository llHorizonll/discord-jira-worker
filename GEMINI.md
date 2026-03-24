# Discord-Jira Worker

A Cloudflare Worker that integrates Discord with Jira, allowing teams to manage Jira tasks directly from Discord using slash commands.

## Project Overview

*   **Purpose:** Provides a Discord bot interface for Jira operations.
*   **Technologies:** Cloudflare Workers, Discord Interactions API, Jira REST API (v3), Bun.
*   **Key Dependencies:** `discord-interactions`, `wrangler`.
*   **Architecture:**
    *   `src/worker.js`: Main entry point for handling Discord interactions.
    *   `register-command.js`: Script to register slash commands with the Discord API.
    *   `wrangler.toml`: Configuration for Cloudflare Worker and KV namespaces.

## Building and Running

### Development
To start the local development server:
```bash
wrangler dev
```

### Deployment
To deploy to Cloudflare Workers:
```bash
wrangler deploy
```

### Registering Commands
To register or update Discord slash commands:
```bash
bun register-command.js
```
*Note: Requires `.env` with `APP_ID` and `BOT_TOKEN`.*

## Available Slash Commands

*   `/create`: Create a Jira task (Title, Description, Issue Type, Priority).
*   `/sprint`: List issues in the current active sprint.
*   `/mytasks`: List Jira tasks assigned to your linked account.
*   `/done`: Mark a specific Jira task (by key) as "Done".
*   `/linkjira`: Map your Discord account to your Jira email.
*   `/help`: Show bot help and command descriptions.

## Configuration

### Environment Variables (Required in Cloudflare/Secret Management)
*   `JIRA_EMAIL`: Your Jira account email.
*   `JIRA_API_TOKEN`: Your Jira API token.
*   `DISCORD_PUBLIC_KEY`: Discord application public key.
*   `APP_ID`: Discord application ID.
*   `BOT_TOKEN`: Discord bot token.

### Wrangler Variables (Configured in `wrangler.toml`)
*   `JIRA_BASE_URL`: The base URL of your Jira instance.
*   `JIRA_PROJECT_KEY`: The default Jira project key.

### KV Namespaces
*   `JIRA_CACHE`: Used for temporary caching of Jira data.
*   `USER_MAP`: Stores the mapping between Discord IDs and Jira account IDs.

## Development Conventions

*   **Atlassian Document Format (ADF):** Jira descriptions are created using ADF (see `jiraDescription` in `src/worker.js`).
*   **Security:** All incoming requests from Discord must be verified using `verifyKey` from `discord-interactions`.
*   **API Interactions:** Basic Auth is used for Jira API calls (`email:token`).
