# Discord-Jira Worker

A Cloudflare Worker that integrates Discord with Jira, allowing teams to manage Jira tasks directly from Discord using slash commands.

## Project Overview

**Purpose:** Provides a Discord bot interface for Jira operations.

**Technologies:** Cloudflare Workers, Discord Interactions API, Jira REST API (v3), Bun.

**Key Dependencies:** `discord-interactions`, `wrangler`.

**Architecture:**
- `src/worker.js`: Main entry point for handling Discord interactions.
- `register-command.js`: Script to register slash commands with the Discord API.
- `wrangler.toml`: Configuration for Cloudflare Worker and KV namespaces.

## Prerequisites

- Node.js or Bun
- Cloudflare account with Wrangler CLI installed
- Discord application with bot token
- Jira account with API access

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd discord-jira-worker
   ```

2. Install dependencies:
   ```bash
   bun install
   # or npm install
   ```

3. Set up environment variables in Cloudflare Workers secrets or local `.env`:
   - `JIRA_EMAIL`: Your Jira account email
   - `JIRA_API_TOKEN`: Your Jira API token
   - `DISCORD_PUBLIC_KEY`: Discord application public key
   - `APP_ID`: Discord application ID
   - `BOT_TOKEN`: Discord bot token

## Available Commands

### Development
- `bun run dev` or `wrangler dev`: Start local development server
- `bun run register` or `bun register-command.js`: Register/update Discord slash commands
- `bun run log` or `wrangler tail`: View worker logs

### Deployment
- `bun run deploy` or `wrangler deploy`: Deploy to Cloudflare Workers

## Discord Slash Commands

The bot provides the following slash commands:

- `/create`: Create a Jira task with options for title, description, issue type, priority, assignee, sprint ID, and epic key
- `/sprint`: Display issues in the current active sprint
- `/mytasks`: List Jira tasks assigned to your linked account (requires `/linkjira` first)
- `/done`: Mark a specific Jira task as "Done" by providing the issue key
- `/linkjira`: Link your Discord account to your Jira email for personalized commands
- `/help`: Show bot help and command descriptions

## Configuration

### Wrangler Configuration
The `wrangler.toml` file includes:
- Worker name: `discord-jira-bot`
- Main script: `src/worker.js`
- KV namespaces for caching: `JIRA_CACHE` and `USER_MAP`
- Environment variables for Jira base URL and project key

### Jira Setup
- Base URL and project key are configured in `wrangler.toml`
- Supports Jira Cloud API v3
- Uses basic authentication with email and API token

### Discord Setup
- Requires a Discord application with bot permissions
- Slash commands are registered via the `register-command.js` script
- Handles Discord interactions securely with signature verification

## Usage Manual

1. **Setup Discord Bot:**
   - Create a Discord application at https://discord.com/developers/applications
   - Add bot to your server with appropriate permissions
   - Run `bun run register` to register slash commands

2. **Configure Jira:**
   - Ensure your Jira account has API access
   - Set up environment variables for Jira credentials
   - Configure project key in `wrangler.toml`

3. **Deploy:**
   - Run `bun run deploy` to deploy the worker
   - Set up the Discord interaction endpoint to point to your worker URL

4. **Using Commands:**
   - `/linkjira your-email@jira.com`: Link your Discord account to Jira
   - `/create`: Fill in the form to create new Jira issues
   - `/sprint`: View current sprint issues
   - `/mytasks`: See your assigned tasks
   - `/done ISSUE-123`: Mark issues as complete

## Troubleshooting

- Ensure all environment variables are set correctly
- Check worker logs with `wrangler tail`
- Verify Discord application permissions
- Confirm Jira API token has necessary scopes

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally with `wrangler dev`
5. Submit a pull request

## License

[Add your license here]