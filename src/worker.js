import { verifyKey } from "discord-interactions";

function jiraDescription(text) {
  const paragraphs = text.split("\n").filter(p => p.trim() !== "").map(p => ({
    type: "paragraph",
    content: [{ type: "text", text: p.trim() }],
  }));

  return {
    type: "doc",
    version: 1,
    content: paragraphs.length > 0 ? paragraphs : [
      {
        type: "paragraph",
        content: [{ type: "text", text: "" }],
      }
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

async function getBoardId(env, projectKey) {
  let boardId = await env.JIRA_CACHE.get(`BOARD_ID_${projectKey}`);
  if (!boardId) {
    const boards = await jira(env, `/rest/agile/1.0/board?projectKeyOrId=${projectKey}`);
    boardId = boards.values?.[0]?.id;
    if (boardId) {
      await env.JIRA_CACHE.put(`BOARD_ID_${projectKey}`, boardId.toString());
    }
  }
  return boardId;
}

async function getActiveSprintId(env, projectKey) {
  const boardId = await getBoardId(env, projectKey);
  if (!boardId) return null;

  const activeSprints = await jira(env, `/rest/agile/1.0/board/${boardId}/sprint?state=active`);
  return activeSprints.values?.[0]?.id?.toString() || null;
}

async function getStoryPointFieldId(env) {
  let fieldId = await env.JIRA_CACHE.get("STORY_POINT_FIELD_ID");
  if (!fieldId) {
    const fields = await jira(env, "/rest/api/3/field");
    if (Array.isArray(fields)) {
      const field = fields.find(
        (f) =>
          f.name === "Story Points" ||
          f.name === "Story point estimate" ||
          f.name?.toLowerCase() === "story points" ||
          f.name?.toLowerCase() === "story point estimate"
      );
      if (field) {
        fieldId = field.id;
        await env.JIRA_CACHE.put("STORY_POINT_FIELD_ID", fieldId, { expirationTtl: 86400 });
      }
    }
  }
  return fieldId;
}

async function createJiraIssue(env, input) {
  const {
    title,
    description,
    issuetype,
    priority,
    assigneeParam,
    sprintIdParam,
    epicKeyParam,
    zohoTicketParam,
    imageUrl,
    addToActiveSprintWhenEmpty = true,
    storypoint,
  } = input;

  let finalDescription = description;
  if (zohoTicketParam) {
    finalDescription += `\n\nZoho Ticket: ${zohoTicketParam}`;
  }
  if (imageUrl) {
    finalDescription += `\n\nAttached Image: ${imageUrl}`;
  }

  const fields = {
    project: { key: env.JIRA_PROJECT_KEY },
    summary: title,
    description: jiraDescription(finalDescription),
    issuetype: { name: issuetype },
    ...(priority ? { priority: { name: priority } } : {}),
  };

  if (storypoint) {
    const storyPointFieldId = await getStoryPointFieldId(env);
    if (storyPointFieldId) {
      fields[storyPointFieldId] = Number(storypoint);
    } else {
      console.warn("Story Point field ID not found in Jira");
    }
  }

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
  let finalSprintId = sprintIdParam;

  if (!finalSprintId && addToActiveSprintWhenEmpty) {
    finalSprintId = await getActiveSprintId(env, env.JIRA_PROJECT_KEY);
  }

  if (finalSprintId && issue.id) {
    await jira(env, `/rest/agile/1.0/sprint/${finalSprintId}/issue`, "POST", {
      issues: [issue.key],
    });
  }

  return {
    issue,
    finalSprintId,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return new Response("ok");
    }

    if (url.pathname === "/webhook/discord-thread") {
      if (!env.THREAD_WEBHOOK_SECRET) {
        return Response.json(
          { ok: false, error: "THREAD_WEBHOOK_SECRET is not configured" },
          { status: 500 },
        );
      }

      const webhookSecret = request.headers.get("x-thread-webhook-secret");
      if (!webhookSecret || webhookSecret !== env.THREAD_WEBHOOK_SECRET) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ ok: false, error: "invalid json payload" }, { status: 400 });
      }

      const threadId = payload.threadId?.toString();
      const threadName = payload.threadName?.trim();
      if (!threadId || !threadName) {
        return Response.json(
          { ok: false, error: "threadId and threadName are required" },
          { status: 400 },
        );
      }

      const dedupeKey = `THREAD_TO_ISSUE_${threadId}`;
      const existingIssueKey = await env.JIRA_CACHE.get(dedupeKey);
      if (existingIssueKey) {
        return Response.json({
          ok: true,
          deduplicated: true,
          issueKey: existingIssueKey,
          issueUrl: `${env.JIRA_BASE_URL}/browse/${existingIssueKey}`,
        });
      }

      try {
        const isValidDiscordThreadUrl = (value) => {
          if (!value || typeof value !== "string") return false;
          try {
            const parsed = new URL(value);
            if (parsed.hostname !== "discord.com" && parsed.hostname !== "www.discord.com") {
              return false;
            }
            const parts = parsed.pathname.split("/").filter(Boolean);
            return parts[0] === "channels" && parts.length >= 3;
          } catch {
            return false;
          }
        };

        const fallbackThreadUrl = payload.guildId
          ? `https://discord.com/channels/${payload.guildId}/${threadId}`
          : null;

        const threadUrl = isValidDiscordThreadUrl(payload.threadUrl)
          ? payload.threadUrl
          : fallbackThreadUrl;

        const details = [
          `Thread Name: ${threadName}`,
          `Thread ID: ${threadId}`,
          payload.guildName ? `Guild: ${payload.guildName}` : null,
          payload.channelName ? `Channel: ${payload.channelName}` : null,
          payload.channelId ? `Parent Channel ID: ${payload.channelId}` : null,
          threadUrl ? `Thread URL: ${threadUrl}` : null,
          payload.ownerId ? `Owner: <@${payload.ownerId}>` : null,
        ]
          .filter(Boolean)
          .join("\n");

        const customTitle = payload.title?.trim();
        const title = customTitle
          ? `${customTitle} | ${threadName}`
          : `[Thread] ${threadName}`;

        const customDescription = payload.description?.trim();
        const description = customDescription
          ? `${customDescription}\n\n${details}`
          : `Auto-created from Discord thread.\n\n${details}`;

        const result = await createJiraIssue(env, {
          title,
          description,
          issuetype: payload.issuetype || "Task",
          priority: payload.priority,
          assigneeParam: payload.assignee,
          sprintIdParam: payload.sprintId?.toString(),
          epicKeyParam: payload.epicKey,
          zohoTicketParam: payload.zohoTicket,
          imageUrl: payload.imageUrl,
          addToActiveSprintWhenEmpty: payload.addToActiveSprintWhenEmpty !== false,
        });

        await env.JIRA_CACHE.put(dedupeKey, result.issue.key, { expirationTtl: 2592000 });

        return Response.json({
          ok: true,
          issueKey: result.issue.key,
          issueUrl: `${env.JIRA_BASE_URL}/browse/${result.issue.key}`,
          sprintId: result.finalSprintId,
        });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
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

    // --- Autocomplete Handling (Type 4) ---
    if (interaction.type === 4) {
      const option = interaction.data.options.find((o) => o.focused);
      const name = option.name;
      const value = option.value || "";
      const projectKey = env.JIRA_PROJECT_KEY;

      const fetchAutocomplete = (async () => {
        if (name === "sprint") {
          let boardId = await env.JIRA_CACHE.get(`BOARD_ID_${projectKey}`);
          if (!boardId) {
            const boards = await jira(env, `/rest/agile/1.0/board?projectKeyOrId=${projectKey}`);
            boardId = boards.values?.[0]?.id;
            if (boardId) await env.JIRA_CACHE.put(`BOARD_ID_${projectKey}`, boardId.toString());
          }

          if (boardId) {
            const sprints = await jira(env, `/rest/agile/1.0/board/${boardId}/sprint?state=active,future`);
            const choices = (sprints.values || [])
              .filter((s) => s.name.toLowerCase().includes(value.toLowerCase()))
              .map((s) => ({ name: `${s.state === "active" ? "🏃 " : "📅 "}${s.name}`, value: s.id.toString() }))
              .slice(0, 25);
            return choices;
          }
        }

        if (name === "epic") {
          const epics = await jira(env, `/rest/api/3/search/jql`, "POST", {
            jql: `project = ${projectKey} AND issuetype = Epic AND statusCategory != Done ORDER BY created DESC`,
            fields: ["summary"],
            maxResults: 25,
          });
          const choices = (epics.issues || [])
            .filter((i) => i.fields.summary.toLowerCase().includes(value.toLowerCase()) || i.key.toLowerCase().includes(value.toLowerCase()))
            .map((i) => ({ name: `${i.key}: ${i.fields.summary}`, value: i.key }))
            .slice(0, 25);
          return choices;
        }

        return [];
      })();

      // Discord autocomplete has a 3-second limit. Race it.
      const timeout = new Promise((resolve) => setTimeout(() => resolve([]), 2500));
      const choices = await Promise.race([fetchAutocomplete, timeout]);

      return Response.json({ type: 8, data: { choices: choices || [] } });
    }

    const cmd = interaction.data.name;

    if (cmd === "create") {
      try {
        const opts = interaction.data.options;
        const title = opts.find((o) => o.name === "title").value;
        const description = opts.find((o) => o.name === "description")?.value || "";
        const storypoint = opts.find((o) => o.name === "storypoint")?.value;
        const issuetype = opts.find((o) => o.name === "issuetype")?.value || "Task";
        const priority = opts.find((o) => o.name === "priority")?.value;
        const assigneeParam = opts.find((o) => o.name === "assignee")?.value;
        let sprintIdParam = opts.find((o) => o.name === "sprint")?.value;
        const epicKeyParam = opts.find((o) => o.name === "epic")?.value;
        const zohoTicketParam = opts.find((o) => o.name === "zoho_ticket")?.value;
        const imageId = opts.find((o) => o.name === "image")?.value;

        let imageUrl = null;
        if (imageId && interaction.data.resolved?.attachments?.[imageId]) {
          imageUrl = interaction.data.resolved.attachments[imageId].url;
        }

        const result = await createJiraIssue(env, {
          title,
          description,
          issuetype,
          priority,
          assigneeParam,
          sprintIdParam,
          epicKeyParam,
          zohoTicketParam,
          imageUrl,
          addToActiveSprintWhenEmpty: true,
          storypoint,
        });
        sprintIdParam = result.finalSprintId;

        return Response.json(
          embed(
            "📌 Jira Task Created",
            `**Key:** [${result.issue.key}](${env.JIRA_BASE_URL}/browse/${result.issue.key})\n**Summary:** ${title}${storypoint ? `\n**Story Point:** ${storypoint}` : ""}${assigneeParam ? `\n**Assignee:** ${assigneeParam}` : ""}${sprintIdParam ? `\n**Sprint:** Added to current active sprint` : ""}${epicKeyParam ? `\n**Epic:** ${epicKeyParam}` : ""}${zohoTicketParam ? `\n**Zoho Ticket:** ${zohoTicketParam}` : ""}${imageUrl ? `\n**Image:** [View Attachment](${imageUrl})` : ""}`,
            `${env.JIRA_BASE_URL}/browse/${result.issue.key}`,
          ),
        );
      } catch (err) {
        return Response.json(embed("❌ Error", err.message));
      }
    }

    if (cmd === "sprint") {
      try {
        const opts = interaction.data.options || [];
        const statusParam = opts.find((o) => o.name === "status")?.value;

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

        let jql = "";
        if (statusParam) {
          const statuses = statusParam.split(",").map((s) => s.trim());
          if (statuses.length > 1) {
            jql = `status IN (${statuses.map((s) => `"${s}"`).join(",")})`;
          } else {
            jql = `status = "${statuses[0]}"`;
          }
        }

        const urlParams = new URLSearchParams({
          maxResults: "15",
          fields: "summary,status",
        });
        if (jql) {
          urlParams.append("jql", jql);
        }

        const issuesData = await jira(
          env,
          `/rest/agile/1.0/sprint/${sprintId}/issue?${urlParams.toString()}`,
        );
        const issues = issuesData.issues
          ?.map((i) => {
            const status = i.fields.status.name.toUpperCase();
            return `\`[${status}]\` **[${i.key}](${env.JIRA_BASE_URL}/browse/${i.key})** ${i.fields.summary}`;
          })
          .join("\n");

        const title = statusParam
          ? `🏃 ${sprintData.name} (${statusParam})`
          : `🏃 ${sprintData.name}`;

        return Response.json(
          embed(title, issues || "No issues found matching the criteria"),
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

    if (cmd === "update") {
      try {
        const opts = interaction.data.options;
        const issueKey = opts.find((o) => o.name === "issue_key").value?.trim();
        const statusVal = opts.find((o) => o.name === "status").value?.trim();

        if (!issueKey || !statusVal) {
          return Response.json(embed("❌ Error", "Both issue key and status are required."));
        }

        // 1. Fetch available transitions for this issue from Jira
        const transitionsData = await jira(env, `/rest/api/3/issue/${issueKey}/transitions`);
        const transitions = transitionsData.transitions || [];

        if (transitions.length === 0) {
          return Response.json(embed("❌ Error", `No available transitions found for issue **${issueKey}**.`));
        }

        // 2. Find matching transition
        // First try to match by transition ID directly (if selected from autocomplete)
        let selectedTransition = transitions.find(t => t.id === statusVal);

        if (!selectedTransition) {
          // Robust matching logic for string input
          const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, "");
          const normalizedInput = normalize(statusVal);
          
          // Try matching transition ID or name/to.name
          selectedTransition = transitions.find(t => normalize(t.name) === normalizedInput);
          if (!selectedTransition) {
            selectedTransition = transitions.find(t => t.to && normalize(t.to.name) === normalizedInput);
          }
          if (!selectedTransition) {
            selectedTransition = transitions.find(t => normalize(t.name).includes(normalizedInput) || normalizedInput.includes(normalize(t.name)));
          }
          if (!selectedTransition) {
            selectedTransition = transitions.find(t => t.to && (normalize(t.to.name).includes(normalizedInput) || normalizedInput.includes(normalize(t.to.name))));
          }
        }

        if (!selectedTransition) {
          const availableList = transitions.map(t => `• **${t.to?.name || t.name}** (trigger: \`${t.name}\`)`).join("\n");
          return Response.json(embed("❌ Status Transition Not Found", `Could not find a status transition matching **${statusVal}** for issue **${issueKey}**.\n\nAvailable transitions:\n${availableList}`));
        }

        // 3. Perform the transition
        await jira(env, `/rest/api/3/issue/${issueKey}/transitions`, "POST", {
          transition: {
            id: selectedTransition.id,
          },
        });

        const successMsg = `Successfully transitioned issue **[${issueKey}](${env.JIRA_BASE_URL}/browse/${issueKey})** to status **${selectedTransition.to?.name || selectedTransition.name}**.`;
        return Response.json(embed("🔄 Jira Task Updated", successMsg, `${env.JIRA_BASE_URL}/browse/${issueKey}`));
      } catch (err) {
        return Response.json(embed("❌ Error", err.message));
      }
    }

    if (cmd === "help") {
      return Response.json(
        embed(
          "🤖 Jira Bot",
          `
            /create – 📌 Create Jira task (supports image attachments)
            /update – 🔄 Update status of a Jira task (follows Jira workflow)
            /sprint – 🏃 Show current sprint board
            /mytasks – 📋 Show tasks assigned to you
            /linkjira – 🔗 Link your Discord account to Jira email
          `,
        ),
      );
    }
  },
};
