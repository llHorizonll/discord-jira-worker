# PLAN.md — Zoho Workflow → Cloudflare Worker → Discord Webhook

## 1. Goal

Build a Cloudflare Worker middleware that receives webhook payloads from Zoho Workflow Rules, transforms the raw Zoho data into a clean Discord Embed message, masks sensitive fields, and forwards the notification to a Discord channel via Discord Webhook.

Current flow:

```text
Zoho Workflow Rule
      ↓ POST JSON
Cloudflare Worker
      ↓ format / validate / mask / route
Discord Webhook Channel
```

Future extensibility:

```text
Zoho Workflow Rule
      ↓
Cloudflare Worker
      ├─ Discord Webhook Notification
      ├─ D1 Audit Log
      ├─ KV Config / Routing
      └─ Discord Bot Commands later
```

---

## 2. Problem

Zoho can send webhook notifications directly to Discord, but direct integration has limitations:

- Discord webhook URL is exposed in Zoho.
- Formatting logic is hard to maintain in Zoho UI.
- Cannot easily mask sensitive fields like AdminToken or Authorization.
- Cannot route messages to different Discord channels based on product/status.
- Cannot validate missing fields before sending.
- Cannot keep audit logs.
- Hard to extend into Discord commands later.

---

## 3. Proposed Solution

Create a Cloudflare Worker endpoint:

```text
POST /webhook/zoho-license
```

Zoho will send its Workflow Webhook to this Worker URL instead of directly to Discord.

The Worker will:

1. Accept JSON payload from Zoho.
2. Validate required fields.
3. Normalize empty/null values.
4. Mask sensitive fields.
5. Build Discord Embed payload.
6. Send the formatted message to Discord Webhook.
7. Return success/failure response to Zoho.
8. Optionally log events for debugging/audit.

---

## 4. Zoho Webhook Configuration

### URL to Notify

Use the Cloudflare Worker URL, not the Discord Webhook URL.

Example with workers.dev:

```text
https://zoho-discord-license.<your-subdomain>.workers.dev/webhook/zoho-license
```

Example with custom domain:

```text
https://license-discord.yourdomain.com/webhook/zoho-license
```

### Method

```text
POST
```

### Content Type

```text
application/json
```

### Body

Use simple raw JSON from Zoho. Do not build Discord embed inside Zoho.

```json
{
  "licenseId": "${Licenses.License Id}",
  "account": "${Lookup:Account Name.Account Name}",
  "product": "${Lookup:Purchased Product.Product Name}",
  "version": "${Licenses.Version}",
  "users": "${Licenses.User License}",
  "businessUnit": "${Licenses.Business Unit Name}",
  "tenant": "${Licenses.Tenant}",
  "authorization": "${Licenses.Authorization}",
  "adminToken": "${Licenses.AdminToken}",
  "emails": "${Licenses.Notify license to email(s)}",
  "hotelUrl": "${Licenses.Hotel URL}",
  "status": "${Licenses.Status}",
  "requestDate": "${Licenses.Request Date}",
  "expiryDate": "${Licenses.Expiry Date}",
  "zohoRecordUrl": "${Licenses.Record Id}"
}
```

Note: If Zoho has a direct record URL merge field, use that instead of record id.

---

## 5. Worker Environment Variables

Store secrets in Cloudflare Worker secrets.

Required:

```bash
wrangler secret put DISCORD_WEBHOOK_LICENSE
```

Optional for routing:

```bash
wrangler secret put DISCORD_WEBHOOK_PMS
wrangler secret put DISCORD_WEBHOOK_ACCOUNTING
wrangler secret put DISCORD_WEBHOOK_TEST
```

Optional shared secret for Zoho request authentication:

```bash
wrangler secret put ZOHO_WEBHOOK_SECRET
```

---

## 6. Recommended Project Structure

```text
zoho-discord-worker/
├─ src/
│  ├─ index.ts
│  ├─ handlers/
│  │  └─ zohoLicenseHandler.ts
│  ├─ services/
│  │  ├─ discordService.ts
│  │  └─ auditLogService.ts
│  ├─ utils/
│  │  ├─ format.ts
│  │  ├─ mask.ts
│  │  └─ validation.ts
│  └─ types/
│     └─ zoho.ts
├─ wrangler.toml
├─ package.json
├─ tsconfig.json
└─ README.md
```

---

## 7. Data Contract

### Zoho License Payload

```ts
export type ZohoLicensePayload = {
  licenseId?: string;
  account?: string;
  product?: string;
  version?: string;
  users?: string | number;
  businessUnit?: string;
  tenant?: string;
  authorization?: string;
  adminToken?: string;
  emails?: string;
  hotelUrl?: string;
  status?: string;
  requestDate?: string;
  expiryDate?: string;
  zohoRecordUrl?: string;
};
```

### Discord Webhook Payload

```ts
export type DiscordWebhookPayload = {
  username?: string;
  avatar_url?: string;
  content?: string;
  embeds: Array<{
    title?: string;
    description?: string;
    url?: string;
    color?: number;
    fields?: Array<{
      name: string;
      value: string;
      inline?: boolean;
    }>;
    footer?: {
      text: string;
    };
    timestamp?: string;
  }>;
};
```

---

## 8. Discord Message Design

Recommended message style:

```text
🟢 New License Request

📄 License Request
Hotel ABC requested a new license.

🏨 Account / License
Account: Hotel ABC
License ID: LIC-0001
Status: New

📦 Product
Product: Carmen PMS
Version: 9.0
Users: 20

🔐 Authorization
Authorization: ||masked||
AdminToken: ||masked||

🔗 Hotel URL
https://hotel.example.com

📅 Dates
Request: 2026-06-23
Expiry: 2027-06-23
```

Use Discord spoiler markdown for sensitive data:

```text
||secret-value||
```

For very sensitive fields, prefer partial masking instead:

```text
abcd••••••••wxyz
```

---

## 9. Worker Routing Rules

Initial version:

```ts
const webhookUrl = env.DISCORD_WEBHOOK_LICENSE;
```

Future version:

```ts
function getDiscordWebhookUrl(data: ZohoLicensePayload, env: Env): string {
  if (data.product?.toLowerCase().includes("pms")) {
    return env.DISCORD_WEBHOOK_PMS;
  }

  if (data.product?.toLowerCase().includes("accounting")) {
    return env.DISCORD_WEBHOOK_ACCOUNTING;
  }

  return env.DISCORD_WEBHOOK_LICENSE;
}
```

---

## 10. Validation Rules

Required fields:

- account
- product
- licenseId
- status

If required fields are missing:

- Return HTTP 400.
- Do not send to Discord.
- Include a short error response.

Example:

```json
{
  "ok": false,
  "error": "Missing required field: account"
}
```

---

## 11. Security Requirements

### Do not expose Discord Webhook URL

Discord Webhook URL must only be stored in Cloudflare Worker secrets.

### Optional Zoho Secret

Zoho can send a secret header:

```text
X-Zoho-Webhook-Secret: <secret>
```

Worker should verify it:

```ts
const secret = req.headers.get("X-Zoho-Webhook-Secret");

if (env.ZOHO_WEBHOOK_SECRET && secret !== env.ZOHO_WEBHOOK_SECRET) {
  return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
}
```

If Zoho UI cannot set custom headers, use a secret query string:

```text
https://license-discord.yourdomain.com/webhook/zoho-license?token=<secret>
```

Worker checks:

```ts
const token = new URL(req.url).searchParams.get("token");
```

### Mask Sensitive Fields

Fields to mask:

- authorization
- adminToken
- API keys
- passwords
- tokens

Recommended mask function:

```ts
function maskSecret(value?: string): string {
  if (!value) return "-";
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}••••••••${value.slice(-4)}`;
}
```

---

## 12. Error Handling

Worker should handle:

- Non-POST requests → 405
- Invalid JSON → 400
- Missing required fields → 400
- Discord webhook failure → 502
- Unexpected error → 500

Response format:

```json
{
  "ok": true,
  "message": "Notification sent"
}
```

or

```json
{
  "ok": false,
  "error": "Discord webhook failed"
}
```

---

## 13. MVP Implementation

Create `src/index.ts`:

```ts
export interface Env {
  DISCORD_WEBHOOK_LICENSE: string;
  ZOHO_WEBHOOK_SECRET?: string;
}

type ZohoLicensePayload = {
  licenseId?: string;
  account?: string;
  product?: string;
  version?: string;
  users?: string | number;
  businessUnit?: string;
  tenant?: string;
  authorization?: string;
  adminToken?: string;
  emails?: string;
  hotelUrl?: string;
  status?: string;
  requestDate?: string;
  expiryDate?: string;
  zohoRecordUrl?: string;
};

function valueOrDash(value?: unknown): string {
  const text = String(value ?? "").trim();
  return text || "-";
}

function maskSecret(value?: string): string {
  const text = valueOrDash(value);
  if (text === "-") return "-";
  if (text.length <= 8) return "••••••••";
  return `${text.slice(0, 4)}••••••••${text.slice(-4)}`;
}

function buildDiscordPayload(data: ZohoLicensePayload) {
  const title = "📄 New License Request";

  return {
    username: "Zoho License Bot",
    content: "🟢 **New License Request**",
    embeds: [
      {
        title,
        url: data.zohoRecordUrl || undefined,
        description: `**${valueOrDash(data.account)}** requested a new license.`,
        color: 5763719,
        fields: [
          {
            name: "🏨 Account / License",
            value:
              `**Account:** ${valueOrDash(data.account)}\n` +
              `**License ID:** \`${valueOrDash(data.licenseId)}\`\n` +
              `**Status:** \`${valueOrDash(data.status)}\``,
            inline: false
          },
          {
            name: "📦 Product",
            value:
              `**Product:** ${valueOrDash(data.product)}\n` +
              `**Version:** \`${valueOrDash(data.version)}\`\n` +
              `**Users:** \`${valueOrDash(data.users)}\``,
            inline: true
          },
          {
            name: "🏢 Business",
            value:
              `**BU:** ${valueOrDash(data.businessUnit)}\n` +
              `**Tenant:** \`${valueOrDash(data.tenant)}\``,
            inline: true
          },
          {
            name: "🔐 Sensitive",
            value:
              `**Authorization:** \`${maskSecret(data.authorization)}\`\n` +
              `**AdminToken:** \`${maskSecret(data.adminToken)}\``,
            inline: false
          },
          {
            name: "📧 Notify Emails",
            value: valueOrDash(data.emails),
            inline: false
          },
          {
            name: "🔗 Hotel URL",
            value: valueOrDash(data.hotelUrl),
            inline: false
          },
          {
            name: "📅 Dates",
            value:
              `**Request:** \`${valueOrDash(data.requestDate)}\`\n` +
              `**Expiry:** \`${valueOrDash(data.expiryDate)}\``,
            inline: false
          }
        ],
        footer: {
          text: "Zoho CRM • License Workflow"
        },
        timestamp: new Date().toISOString()
      }
    ]
  };
}

function validatePayload(data: ZohoLicensePayload): string | null {
  if (!valueOrDash(data.account) || valueOrDash(data.account) === "-") {
    return "Missing required field: account";
  }

  if (!valueOrDash(data.product) || valueOrDash(data.product) === "-") {
    return "Missing required field: product";
  }

  if (!valueOrDash(data.licenseId) || valueOrDash(data.licenseId) === "-") {
    return "Missing required field: licenseId";
  }

  return null;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);

      if (req.method !== "POST") {
        return Response.json(
          { ok: false, error: "Method not allowed" },
          { status: 405 }
        );
      }

      if (env.ZOHO_WEBHOOK_SECRET) {
        const token =
          req.headers.get("X-Zoho-Webhook-Secret") ||
          url.searchParams.get("token");

        if (token !== env.ZOHO_WEBHOOK_SECRET) {
          return Response.json(
            { ok: false, error: "Unauthorized" },
            { status: 401 }
          );
        }
      }

      let data: ZohoLicensePayload;

      try {
        data = await req.json();
      } catch {
        return Response.json(
          { ok: false, error: "Invalid JSON body" },
          { status: 400 }
        );
      }

      const validationError = validatePayload(data);

      if (validationError) {
        return Response.json(
          { ok: false, error: validationError },
          { status: 400 }
        );
      }

      const discordPayload = buildDiscordPayload(data);

      const discordResponse = await fetch(env.DISCORD_WEBHOOK_LICENSE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(discordPayload)
      });

      if (!discordResponse.ok) {
        const errorText = await discordResponse.text();

        return Response.json(
          {
            ok: false,
            error: "Discord webhook failed",
            detail: errorText
          },
          { status: 502 }
        );
      }

      return Response.json({
        ok: true,
        message: "Notification sent"
      });
    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: "Internal server error"
        },
        { status: 500 }
      );
    }
  }
};
```

---

## 14. `wrangler.toml`

```toml
name = "zoho-discord-license"
main = "src/index.ts"
compatibility_date = "2026-06-23"

[observability]
enabled = true
```

---

## 15. Test with curl

```bash
curl -X POST "https://zoho-discord-license.<your-subdomain>.workers.dev/webhook/zoho-license" \
  -H "Content-Type: application/json" \
  -d '{
    "licenseId": "LIC-0001",
    "account": "Hotel ABC",
    "product": "Carmen PMS",
    "version": "9.0",
    "users": 20,
    "businessUnit": "Hotel",
    "tenant": "hotelabc",
    "authorization": "AUTH-SECRET-1234567890",
    "adminToken": "ADMIN-TOKEN-1234567890",
    "emails": "admin@hotelabc.com",
    "hotelUrl": "https://hotelabc.example.com",
    "status": "New",
    "requestDate": "2026-06-23",
    "expiryDate": "2027-06-23"
  }'
```

With secret query token:

```bash
curl -X POST "https://zoho-discord-license.<your-subdomain>.workers.dev/webhook/zoho-license?token=<secret>" \
  -H "Content-Type: application/json" \
  -d '{ "licenseId": "LIC-0001", "account": "Hotel ABC", "product": "Carmen PMS" }'
```

---

## 16. Deployment Steps

1. Create new Worker project.

```bash
npm create cloudflare@latest zoho-discord-license
```

2. Choose Worker + TypeScript.

3. Add or replace `src/index.ts`.

4. Set Discord webhook secret.

```bash
npx wrangler secret put DISCORD_WEBHOOK_LICENSE
```

5. Optional: set Zoho auth secret.

```bash
npx wrangler secret put ZOHO_WEBHOOK_SECRET
```

6. Deploy.

```bash
npx wrangler deploy
```

7. Copy deployed Worker URL.

8. Paste Worker URL into Zoho Workflow Webhook `URL to Notify`.

9. Test workflow from Zoho.

---

## 17. Future Phase: D1 Audit Log

Add D1 table:

```sql
CREATE TABLE license_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id TEXT,
  account TEXT,
  product TEXT,
  status TEXT,
  payload_json TEXT,
  discord_sent INTEGER DEFAULT 0,
  error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

Use D1 to support future Discord commands:

```text
/license LIC-0001
/latest-license
/licenses status:new
/licenses account:"Hotel ABC"
```

---

## 18. Future Phase: Discord Bot

Webhook can only send messages.

For interactive buttons and commands, add Discord Bot later.

Possible commands:

```text
/license-search
/license-latest
/license-by-account
/license-renew
/license-expiring
```

Possible buttons:

```text
Open Zoho
Open Hotel URL
Mark as Processing
Approve
Reject
Renew
```

Note: Real interactive buttons require Discord Bot API / Interactions, not simple Discord Webhook only.

---

## 19. Acceptance Criteria

MVP is complete when:

- Zoho sends JSON to Worker successfully.
- Worker returns `{ "ok": true }`.
- Discord receives a clean formatted embed.
- Sensitive fields are masked.
- Missing required fields return HTTP 400.
- Discord webhook URL is not stored in Zoho.
- Worker can be deployed with `wrangler deploy`.

---

## 20. Notes for Codex

Implement this as a clean TypeScript Cloudflare Worker.

Prioritize:

1. Simple deployment.
2. Clear code structure.
3. Safe secret handling.
4. Good error responses.
5. Easy future extension for D1 and Discord Bot.

Do not hardcode Discord webhook URLs in source code.
Use Cloudflare Worker secrets only.
