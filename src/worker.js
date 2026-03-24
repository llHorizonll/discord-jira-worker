import { verifyKey } from "discord-interactions";

function jiraDescription(text) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function embed(title, description, url = null) {
  return {
    type: 4,
    data: {
      embeds: [
        {
          title,
          description,
          color: 3447003,
          url,
        },
      ],
    },
  };
}

async function jira(env, path, method = "GET", body = null) {
  const headers = {
    Authorization: "Basic " + btoa(env.JIRA_EMAIL + ":" + env.JIRA_API_TOKEN),
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const res = await fetch(`${env.JIRA_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `Jira API error: ${res.status} ${res.statusText} - ${errorText}`,
    );
  }

  const contentType = res.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

async function cacheSet(env, key, data) {
  await env.JIRA_CACHE.put(key, JSON.stringify(data), { expirationTtl: 3600 });
}

async function updateInteraction(env, token, data) {
  const url = `https://discord.com/api/v10/webhooks/${env.APP_ID}/${token}/messages/@original`;
  await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("ok");
    }

    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");
    const body = await request.text();

    const valid = verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);

    if (!valid) {
      return new Response("bad request", { status: 401 });
    }

    const interaction = JSON.parse(body);

    if (interaction.type === 1) {
      return Response.json({ type: 1 });
    }

    const discordUser = interaction.member?.user || interaction.user;
    const discordId = discordUser?.id;
    const token = interaction.token;
    const cmd = interaction.data.name;

    if (cmd === "create") {
      try {
        const opts = interaction.data.options;
        const title = opts.find((o) => o.name === "title").value;
        const description = opts.find((o) => o.name === "description").value;
        const issuetype = opts.find((o) => o.name === "issuetype").value;
        const priority = opts.find((o) => o.name === "priority")?.value;
        const assigneeParam = opts.find((o) => o.name === "assignee")?.value;
        const sprintIdParam = opts.find((o) => o.name === "sprint_id")?.value;
        const epicKeyParam = opts.find((o) => o.name === "epic_key")?.value;

        const fields = {
          project: { key: env.JIRA_PROJECT_KEY },
          summary: title,
          description: jiraDescription(description),
          issuetype: { name: issuetype },
          ...(priority ? { priority: { name: priority } } : {}),
        };

        if (assigneeParam) {
          const users = await jira(
            env,
            `/rest/api/3/user/search?query=${encodeURIComponent(assigneeParam)}`,
          );
          if (users && users.length > 0) {
            fields.assignee = { accountId: users[0].accountId };
          }
        }

        if (epicKeyParam) {
          fields.parent = { key: epicKeyParam };
        }

        const issue = await jira(env, "/rest/api/3/issue", "POST", { fields });

        if (sprintIdParam && issue.id) {
          await jira(env, `/rest/agile/1.0/sprint/${sprintIdParam}/issue`, "POST", {
            issues: [issue.key],
          });
        }

        return Response.json(
          embed(
            "📌 Jira Task Created",
            `**Key:** [${issue.key}](${env.JIRA_BASE_URL}/browse/${issue.key})\n**Summary:** ${title}${assigneeParam ? `\n**Assignee:** ${assigneeParam}` : ""}${sprintIdParam ? `\n**Sprint ID:** ${sprintIdParam}` : ""}${epicKeyParam ? `\n**Epic:** ${epicKeyParam}` : ""}`,
            `${env.JIRA_BASE_URL}/browse/${issue.key}`,
          ),
        );
      } catch (err) {
        return Response.json(embed("❌ Error", err.message));
      }
    }

    if (cmd === "sprint") {
      try {
        const projectKey = env.JIRA_PROJECT_KEY;
        let boardId = await env.JIRA_CACHE.get(`BOARD_ID_${projectKey}`);

        if (!boardId) {
          const boards = await jira(
            env,
            `/rest/agile/1.0/board?projectKeyOrId=${projectKey}`,
          );
          if (!boards.values || boards.values.length === 0) {
            return Response.json(embed("❌ Error", "No boards found"));
          }
          boardId = boards.values[0].id;
          await env.JIRA_CACHE.put(
            `BOARD_ID_${projectKey}`,
            boardId.toString(),
          );
        }

        let sprintData;
        let sprintId = await env.JIRA_CACHE.get(`ACTIVE_SPRINT_ID_${boardId}`);
        if (!sprintId) {
          const sprints = await jira(
            env,
            `/rest/agile/1.0/board/${boardId}/sprint?state=active`,
          );
          sprintData = sprints.values?.[0];
          if (!sprintData) {
            return Response.json(embed("🏃 Sprint", "No active sprint"));
          }
          sprintId = sprintData.id;
          await env.JIRA_CACHE.put(
            `ACTIVE_SPRINT_ID_${boardId}`,
            sprintId.toString(),
            { expirationTtl: 600 },
          );
          // Store name in cache too to save a fetch later
          await env.JIRA_CACHE.put(
            `ACTIVE_SPRINT_NAME_${sprintId}`,
            sprintData.name,
            { expirationTtl: 600 },
          );
        } else {
          // If we had ID, try to get name from cache or fetch it
          const cachedName = await env.JIRA_CACHE.get(
            `ACTIVE_SPRINT_NAME_${sprintId}`,
          );
          if (cachedName) {
            sprintData = { id: sprintId, name: cachedName };
          } else {
            sprintData = await jira(env, `/rest/agile/1.0/sprint/${sprintId}`);
            await env.JIRA_CACHE.put(
              `ACTIVE_SPRINT_NAME_${sprintId}`,
              sprintData.name,
              { expirationTtl: 600 },
            );
          }
        }

        const issuesData = await jira(
          env,
          `/rest/agile/1.0/sprint/${sprintId}/issue?maxResults=15&fields=summary,status`,
        );
        const issues = issuesData.issues
          ?.map((i) => {
            const status = i.fields.status.name.toUpperCase();
            return `\`[${status}]\` **[${i.key}](${env.JIRA_BASE_URL}/browse/${i.key})** ${i.fields.summary}`;
          })
          .join("\n");

        return Response.json(
          embed(`🏃 ${sprintData.name}`, issues || "No issues in sprint"),
        );
      } catch (err) {
        return Response.json(embed("❌ Error", err.message));
      }
    }

    if (cmd === "mytasks") {
      try {
        const accountId = await env.USER_MAP.get(discordId);

        if (!accountId) {
          return Response.json({
            type: 4,
            data: {
              content: "⚠️ Please link your Jira first using /linkjira email",
            },
          });
        }

        const jql = `assignee = "${accountId}" AND statusCategory != Done ORDER BY updated DESC`;
        const data = await jira(env, `/rest/api/3/search/jql`, "POST", {
          jql,
          fields: ["summary", "status"],
          maxResults: 10,
        });

        const issues = data.issues
          ?.map((i) => {
            const status = i.fields.status.name.toUpperCase();
            return `\`[${status}]\` **[${i.key}](${env.JIRA_BASE_URL}/browse/${i.key})** ${i.fields.summary}`;
          })
          .join("\n");

        return Response.json({
          type: 4,
          data: {
            embeds: [
              {
                title: "📋 My Jira Tasks",
                description: issues || "No tasks assigned",
                color: 3447003,
              },
            ],
          },
        });
      } catch (err) {
        return Response.json(embed("❌ Error", err.message));
      }
    }

    if (cmd === "done") {
      const key = interaction.data.options[0].value;

      await jira(env, `/rest/api/3/issue/${key}/transitions`, "POST", {
        transition: { id: "31" },
      });

      return Response.json(
        embed(
          "✅ Task Updated",
          `${key} marked as Done`,
          `${env.JIRA_BASE_URL}/browse/${key}`,
        ),
      );
    }

    if (cmd === "linkjira") {
      const email = interaction.data.options[0].value;

      // search jira user
      const users = await jira(env, `/rest/api/3/user/search?query=${email}`);

      if (!users || users.length === 0) {
        return Response.json({
          type: 4,
          data: {
            content: "❌ Jira user not found with that email",
          },
        });
      }

      const accountId = users[0].accountId;

      // save mapping
      await env.USER_MAP.put(discordId, accountId);

      return Response.json({
        type: 4,
        data: {
          content: `✅ Jira account linked\nDiscord: <@${discordId}>\nJira: ${email}`,
        },
      });
    }

    if (cmd === "help") {
      return Response.json(
        embed(
          "🤖 Jira Bot",
          `
            /create – create Jira task with dropdown options
            /sprint – show current sprint board
            /mytasks – show tasks assigned to you
            /done – mark task done
          `,
        ),
      );
    }
  },
};
