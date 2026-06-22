import { verifyKey } from "discord-interactions";

const SLA_SQL = `
  (priority IN ('Highest', 'Critical') AND (julianday(resolved_at) - julianday(created_at)) * 24 <= 24) OR
  (priority = 'High' AND (julianday(resolved_at) - julianday(created_at)) * 24 <= 72) OR
  (priority = 'Medium' AND (julianday(resolved_at) - julianday(created_at)) * 24 <= 168) OR
  ((priority NOT IN ('Highest', 'Critical', 'High', 'Medium') OR priority IS NULL) AND (julianday(resolved_at) - julianday(created_at)) * 24 <= 336)
`;

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

async function getZohoAccessToken(env) {
  // 1. Try to get cached access token from KV
  let accessToken = await env.JIRA_CACHE.get("ZOHO_ACCESS_TOKEN");
  if (accessToken) {
    return accessToken;
  }

  // 2. We need a refresh token. Check KV first, then env.
  let refreshToken = await env.JIRA_CACHE.get("ZOHO_REFRESH_TOKEN");
  if (!refreshToken) {
    refreshToken = env.ZOHO_REFRESH_TOKEN;
  }

  // 3. If no refresh token, but we have ZOHO_CODE, exchange it (Step 1)
  if (!refreshToken && env.ZOHO_CODE) {
    console.log("No refresh token found. Exchanging ZOHO_CODE for refresh token...");
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.ZOHO_CLIENT_ID,
      client_secret: env.ZOHO_CLIENT_SECRET,
      code: env.ZOHO_CODE
    });

    const res = await fetch("https://accounts.zoho.com/oauth/v2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to exchange ZOHO_CODE: ${res.status} - ${errText}`);
    }

    const data = await res.json();
    if (data.error) {
      throw new Error(`Zoho OAuth Error (authorization_code): ${data.error_description || data.error}`);
    }

    refreshToken = data.refresh_token;
    if (refreshToken) {
      // Store in KV cache permanently
      await env.JIRA_CACHE.put("ZOHO_REFRESH_TOKEN", refreshToken);
      console.log("Successfully retrieved and cached ZOHO_REFRESH_TOKEN");
    } else if (data.access_token) {
      // Fallback: if we only got an access token, cache and return it
      await env.JIRA_CACHE.put("ZOHO_ACCESS_TOKEN", data.access_token, { expirationTtl: 3500 });
      return data.access_token;
    }
  }

  // If we still don't have a refresh token, throw a clear configuration error
  if (!refreshToken) {
    throw new Error(
      "Zoho refresh token is missing. Please configure ZOHO_REFRESH_TOKEN or a valid ZOHO_CODE in your environment variables/secrets."
    );
  }

  // 4. Use refresh token to get a new access token (Step 2)
  console.log("Refreshing Zoho access token...");
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    refresh_token: refreshToken
  });

  const res = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to refresh Zoho token: ${res.status} - ${errText}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`Zoho OAuth Error (refresh_token): ${data.error_description || data.error}`);
  }

  accessToken = data.access_token;
  if (!accessToken) {
    throw new Error("No access_token returned from Zoho token refresh");
  }

  // Cache access token for 3500 seconds (expires in 3600)
  await env.JIRA_CACHE.put("ZOHO_ACCESS_TOKEN", accessToken, { expirationTtl: 3500 });
  return accessToken;
}

function parseZohoDateTime(input) {
  if (!input) return null;
  const cleaned = input.trim();

  // Pattern 1: YYYY-MM-DD HH:mm:ss
  const patternSec = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/;
  const matchSec = cleaned.match(patternSec);
  if (matchSec) {
    const [, y, m, d, hh, mm, ss] = matchSec;
    return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}+07:00`).toISOString();
  }

  // Pattern 2: YYYY-MM-DD HH:mm
  const patternMin = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/;
  const matchMin = cleaned.match(patternMin);
  if (matchMin) {
    const [, y, m, d, hh, mm] = matchMin;
    return new Date(`${y}-${m}-${d}T${hh}:${mm}:00+07:00`).toISOString();
  }

  // Pattern 3: YYYY-MM-DD
  const patternDate = /^(\d{4})-(\d{2})-(\d{2})$/;
  const matchDate = cleaned.match(patternDate);
  if (matchDate) {
    const [, y, m, d] = matchDate;
    return new Date(`${y}-${m}-${d}T00:00:00+07:00`).toISOString();
  }

  // Fallback: If it already looks like an ISO string
  if (cleaned.includes("T") || cleaned.includes("Z")) {
    return cleaned;
  }

  // General Date parser fallback
  try {
    const d = new Date(cleaned);
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  } catch (e) {
    // ignore
  }

  return cleaned;
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

async function getSprintIdByName(env, projectKey, sprintName) {
  const boardId = await getBoardId(env, projectKey);
  if (!boardId) return null;

  const cacheKey = `SPRINT_ID_BY_NAME_${boardId}_${sprintName.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
  let sprintId = await env.JIRA_CACHE.get(cacheKey);

  if (!sprintId) {
    const data = await jira(env, `/rest/agile/1.0/board/${boardId}/sprint?state=active,future`);
    const sprint = (data.values || []).find(s => s.name?.trim().toLowerCase() === sprintName.toLowerCase().trim());
    if (sprint) {
      sprintId = sprint.id.toString();
      await env.JIRA_CACHE.put(cacheKey, sprintId, { expirationTtl: 3600 });
    } else {
      const allData = await jira(env, `/rest/agile/1.0/board/${boardId}/sprint`);
      const fallbackSprint = (allData.values || []).find(s => s.name?.trim().toLowerCase() === sprintName.toLowerCase().trim());
      if (fallbackSprint) {
        sprintId = fallbackSprint.id.toString();
        await env.JIRA_CACHE.put(cacheKey, sprintId, { expirationTtl: 3600 });
      }
    }
  }
  return sprintId;
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
    businessUnit,
    customerUrl,
  } = input;

  let finalDescription = description;
  if (zohoTicketParam) {
    finalDescription += `\n\nZoho Ticket: ${zohoTicketParam}`;
  }
  if (businessUnit) {
    finalDescription += `\n\nBusiness Unit: ${businessUnit}`;
  }
  if (customerUrl) {
    finalDescription += `\n\nCustomer URL: ${customerUrl}`;
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

  if (!finalSprintId) {
    finalSprintId = await getSprintIdByName(env, env.JIRA_PROJECT_KEY, "Support Ticket");
    if (!finalSprintId && addToActiveSprintWhenEmpty) {
      finalSprintId = await getActiveSprintId(env, env.JIRA_PROJECT_KEY);
    }
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

function extractTextFromADF(adf) {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  let text = "";
  if (adf.text) {
    text += adf.text;
  }
  if (adf.content) {
    for (const node of adf.content) {
      text += extractTextFromADF(node) + "\n";
    }
  }
  return text;
}

function toISODate(jiraDate) {
  if (!jiraDate) return null;
  try {
    return new Date(jiraDate).toISOString();
  } catch {
    return null;
  }
}

async function processAndSaveIssue(env, issue, spFieldId) {
  const key = issue.key;
  const summary = issue.fields.summary || "";
  const issuetype = issue.fields.issuetype?.name || "Task";
  const status = issue.fields.status?.name || "To Do";
  const status_category = issue.fields.status?.statusCategory?.name || "To Do";
  const priority = issue.fields.priority?.name || "Medium";
  const story_points = spFieldId && issue.fields[spFieldId] ? Number(issue.fields[spFieldId]) : 0;
  const assignee_id = issue.fields.assignee?.accountId || null;
  const created_at = toISODate(issue.fields.created);
  const updated_at = toISODate(issue.fields.updated);
  
  let resolved_at = toISODate(issue.fields.resolutiondate);
  let in_progress_at = null;
  let reopened_count = 0;
  
  const histories = issue.changelog?.histories || [];
  const sortedHistories = [...histories].sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime());
  
  const inProgressStatuses = ["in progress", "testing", "hotfix", "requirement"];
  const doneStatuses = ["done", "completed", "resolved"];
  
  for (const history of sortedHistories) {
    for (const item of history.items) {
      if (item.field === "status") {
        const fromStr = item.fromString?.toLowerCase() || "";
        const toStr = item.toString?.toLowerCase() || "";
        
        if (inProgressStatuses.includes(toStr) && !in_progress_at) {
          in_progress_at = toISODate(history.created);
        }
        
        if (doneStatuses.includes(toStr)) {
          resolved_at = toISODate(history.created);
        }
        
        if (doneStatuses.includes(fromStr) && !doneStatuses.includes(toStr)) {
          reopened_count++;
        }
      }
    }
  }
  
  if (inProgressStatuses.includes(status.toLowerCase()) && !in_progress_at) {
    in_progress_at = created_at;
  }
  if (status_category === "Done" && !resolved_at) {
    resolved_at = updated_at;
  }
  
  let is_production_bug = 0;
  const labels = issue.fields.labels || [];
  if (issuetype.toLowerCase() === "bug" && (labels.some(l => l.toLowerCase() === "production" || l.toLowerCase() === "prod") || priority === "Highest")) {
    is_production_bug = 1;
  }
  
  const descText = extractTextFromADF(issue.fields.description);
  const match = descText.match(/Business Unit:\s*(.*)/i);
  const customer = match ? match[1].trim() : null;
  
  await env.DB.prepare(`
    INSERT INTO issues (
      key, summary, issuetype, status, status_category, priority, story_points,
      assignee_id, created_at, updated_at, resolved_at, in_progress_at,
      reopened_count, is_production_bug, customer
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      summary=excluded.summary,
      issuetype=excluded.issuetype,
      status=excluded.status,
      status_category=excluded.status_category,
      priority=excluded.priority,
      story_points=excluded.story_points,
      assignee_id=excluded.assignee_id,
      updated_at=excluded.updated_at,
      resolved_at=excluded.resolved_at,
      in_progress_at=excluded.in_progress_at,
      reopened_count=excluded.reopened_count,
      is_production_bug=excluded.is_production_bug,
      customer=coalesce(excluded.customer, customer)
  `).bind(
    key, summary, issuetype, status, status_category, priority, story_points,
    assignee_id, created_at, updated_at, resolved_at, in_progress_at,
    reopened_count, is_production_bug, customer
  ).run();
}

async function syncSingleIssue(env, issueKey) {
  const spFieldId = await getStoryPointFieldId(env);
  try {
    const issue = await jira(env, `/rest/api/3/issue/${issueKey}?expand=changelog`);
    if (issue) {
      await processAndSaveIssue(env, issue, spFieldId);
    }
  } catch (err) {
    console.error(`Failed to sync single issue ${issueKey}:`, err.message);
  }
}

async function syncJiraIssues(env, lookbackMinutes = null) {
  const spFieldId = await getStoryPointFieldId(env);
  const fields = ["summary", "status", "issuetype", "priority", "assignee", "created", "updated", "resolutiondate", "labels", "description"];
  if (spFieldId) fields.push(spFieldId);
  
  const jql = lookbackMinutes 
    ? `project = "${env.JIRA_PROJECT_KEY}" AND updated >= -${lookbackMinutes}m`
    : `project = "${env.JIRA_PROJECT_KEY}"`;
    
  let startAt = 0;
  let total = 1;
  
  while (startAt < total) {
    const data = await jira(env, "/rest/api/3/search", "POST", {
      jql,
      fields,
      expand: ["changelog"],
      maxResults: 50,
      startAt
    });
    total = data.total || 0;
    const issues = data.issues || [];
    if (issues.length === 0) break;
    
    for (const issue of issues) {
      await processAndSaveIssue(env, issue, spFieldId);
    }
    
    startAt += issues.length;
  }
}

async function calculateDeveloperMetrics(env, developerId, startDate, endDate) {
  const startISO = `${startDate}T00:00:00.000Z`;
  const endISO = `${endDate}T23:59:59.999Z`;
  
  const query = `
    SELECT 
      COUNT(*) as closed_tickets,
      SUM(story_points) as story_points,
      AVG((julianday(resolved_at) - julianday(created_at)) * 24) as lead_time_avg,
      AVG(CASE WHEN in_progress_at IS NOT NULL THEN (julianday(resolved_at) - julianday(in_progress_at)) * 24 ELSE NULL END) as cycle_time_avg,
      SUM(CASE WHEN ${SLA_SQL} THEN 1 ELSE 0 END) as sla_met_count,
      SUM(reopened_count) as reopened_count,
      SUM(is_production_bug) as production_bug_count
    FROM issues
    WHERE assignee_id = ? 
      AND status_category = 'Done' 
      AND resolved_at >= ? 
      AND resolved_at <= ?
  `;
  
  const res = await env.DB.prepare(query).bind(developerId, startISO, endISO).first();
  if (!res || res.closed_tickets === 0) {
    return {
      closed_tickets: 0,
      story_points: 0,
      lead_time_avg: 0,
      cycle_time_avg: 0,
      sla_compliance: 1.0,
      reopened_rate: 0,
      production_bug_rate: 0
    };
  }
  
  const closed = res.closed_tickets;
  return {
    closed_tickets: closed,
    story_points: res.story_points || 0,
    lead_time_avg: res.lead_time_avg || 0,
    cycle_time_avg: res.cycle_time_avg || 0,
    sla_compliance: (res.sla_met_count || 0) / closed,
    reopened_rate: (res.reopened_count || 0) / closed,
    production_bug_rate: (res.production_bug_count || 0) / closed
  };
}

function calculateScore(metrics) {
  const {
    closed_tickets,
    story_points,
    sla_compliance,
    lead_time_avg_hours,
    reopened_rate,
    production_bug_rate
  } = metrics;
  
  const closedScore = Math.min(100, closed_tickets * 20);
  const spScore = Math.min(100, story_points * 15);
  const slaScore = (sla_compliance || 0) * 100;
  const leadScore = Math.max(0, 100 - ((lead_time_avg_hours || 0) / 168) * 100);
  const reopenScore = Math.max(0, 100 - (reopened_rate || 0) * 200);
  const bugScore = Math.max(0, 100 - (production_bug_rate || 0) * 500);
  
  const score = (0.40 * closedScore) +
                (0.20 * spScore) +
                (0.20 * slaScore) +
                (0.10 * leadScore) +
                (0.05 * reopenScore) +
                (0.05 * bugScore);
                
  return Math.round(score * 10) / 10;
}

async function calculateAndSaveDailySnapshots(env, dateStr) {
  const developersRes = await env.DB.prepare(`SELECT DISTINCT assignee_id FROM issues WHERE assignee_id IS NOT NULL`).all();
  const developers = developersRes.results.map(r => r.assignee_id);
  
  for (const developerId of developers) {
    const metrics = await calculateDeveloperMetrics(env, developerId, dateStr, dateStr);
    const score = calculateScore({
      closed_tickets: metrics.closed_tickets,
      story_points: metrics.story_points,
      sla_compliance: metrics.sla_compliance,
      lead_time_avg_hours: metrics.lead_time_avg,
      reopened_rate: metrics.reopened_rate,
      production_bug_rate: metrics.production_bug_rate
    });
    
    await env.DB.prepare(`
      INSERT INTO daily_snapshots (
        date, developer_id, score, closed_tickets, story_points,
        lead_time_avg, cycle_time_avg, sla_compliance, reopened_rate, production_bug_rate
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, developer_id) DO UPDATE SET
        score=excluded.score,
        closed_tickets=excluded.closed_tickets,
        story_points=excluded.story_points,
        lead_time_avg=excluded.lead_time_avg,
        cycle_time_avg=excluded.cycle_time_avg,
        sla_compliance=excluded.sla_compliance,
        reopened_rate=excluded.reopened_rate,
        production_bug_rate=excluded.production_bug_rate
    `).bind(
      dateStr, developerId, score, metrics.closed_tickets, metrics.story_points,
      metrics.lead_time_avg, metrics.cycle_time_avg, metrics.sla_compliance, metrics.reopened_rate, metrics.production_bug_rate
    ).run();
  }
}

async function getJiraToDiscordMap(env) {
  const list = await env.USER_MAP.list();
  const mapping = {};
  for (const key of list.keys) {
    const val = await env.USER_MAP.get(key.name);
    if (val) mapping[val] = key.name;
  }
  return mapping;
}

async function getDeveloperName(env, accountId) {
  try {
    const user = await jira(env, `/rest/api/3/user?accountId=${accountId}`);
    return user.displayName || user.emailAddress || accountId;
  } catch {
    return accountId;
  }
}

async function getLeaderboard(env, startDateStr, endDateStr, jiraToDiscord) {
  const startISO = `${startDateStr}T00:00:00.000Z`;
  const developersRes = await env.DB.prepare(`
    SELECT DISTINCT assignee_id 
    FROM issues 
    WHERE assignee_id IS NOT NULL 
      AND resolved_at >= ?
  `).bind(startISO).all();

  const rankings = [];
  for (const devId of developersRes.results.map((r) => r.assignee_id)) {
    const metrics = await calculateDeveloperMetrics(env, devId, startDateStr, endDateStr);
    const score = calculateScore({
      closed_tickets: metrics.closed_tickets,
      story_points: metrics.story_points,
      sla_compliance: metrics.sla_compliance,
      lead_time_avg_hours: metrics.lead_time_avg,
      reopened_rate: metrics.reopened_rate,
      production_bug_rate: metrics.production_bug_rate,
    });

    const devName = await getDeveloperName(env, devId);
    const discordMention = jiraToDiscord[devId] ? `<@${jiraToDiscord[devId]}>` : devName;

    rankings.push({
      devId,
      devName,
      discordMention,
      score,
      closed: metrics.closed_tickets,
    });
  }

  rankings.sort((a, b) => b.score - a.score);
  return rankings;
}

async function sendDiscordMessage(env, channelId, embedData) {
  if (!channelId || !env.BOT_TOKEN) return;
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(embedData),
  });
  if (!res.ok) {
    console.error("Failed to send Discord message:", await res.text());
  }
}

async function sendScheduledReport(env, type) {
  const channelId = env.REPORTS_CHANNEL_ID;
  if (!channelId) {
    console.error("REPORTS_CHANNEL_ID is not configured.");
    return;
  }
  
  const today = new Date();
  const jiraToDiscord = await getJiraToDiscordMap(env);
  
  if (type === "daily") {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split("T")[0];
    const startISO = `${dateStr}T00:00:00.000Z`;
    const endISO = `${dateStr}T23:59:59.999Z`;

    // Open Issues
    const openRes = await env.DB.prepare(`SELECT COUNT(*) as count FROM issues WHERE status_category != 'Done'`).first();
    
    // Resolved Yesterday
    const resolvedRes = await env.DB.prepare(`
      SELECT key, summary, assignee_id FROM issues 
      WHERE status_category = 'Done' AND resolved_at >= ? AND resolved_at <= ?
    `).bind(startISO, endISO).all();
    
    const resolvedList = [];
    for (const r of resolvedRes.results) {
      const devName = r.assignee_id ? await getDeveloperName(env, r.assignee_id) : "Unassigned";
      const mention = r.assignee_id && jiraToDiscord[r.assignee_id] ? `<@${jiraToDiscord[r.assignee_id]}>` : devName;
      resolvedList.push(`• **[${r.key}](${env.JIRA_BASE_URL}/browse/${r.key})** - Resolver: ${mention}`);
    }

    // Top Performer Yesterday
    const topPerformer = await env.DB.prepare(`
      SELECT assignee_id, COUNT(*) as count FROM issues 
      WHERE status_category = 'Done' AND resolved_at >= ? AND resolved_at <= ? AND assignee_id IS NOT NULL
      GROUP BY assignee_id ORDER BY count DESC LIMIT 1
    `).bind(startISO, endISO).first();
    
    let topText = "None";
    if (topPerformer) {
      const devName = await getDeveloperName(env, topPerformer.assignee_id);
      const mention = jiraToDiscord[topPerformer.assignee_id] ? `<@${jiraToDiscord[topPerformer.assignee_id]}>` : devName;
      topText = `${mention} (${topPerformer.count} tickets closed)`;
    }

    // Attention Required (Critical/High issues open and nearing SLA breach)
    const attentionRes = await env.DB.prepare(`
      SELECT key, priority, CAST((julianday('now') - julianday(created_at)) * 24 as INT) as age_hours, assignee_id 
      FROM issues 
      WHERE status_category != 'Done' 
      ORDER BY 
        CASE priority WHEN 'Highest' THEN 1 WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 ELSE 4 END ASC,
        age_hours DESC 
      LIMIT 5
    `).all();

    const attentionList = [];
    for (const r of attentionRes.results) {
      const devName = r.assignee_id ? await getDeveloperName(env, r.assignee_id) : "Unassigned";
      const mention = r.assignee_id && jiraToDiscord[r.assignee_id] ? `<@${jiraToDiscord[r.assignee_id]}>` : devName;
      attentionList.push(`• **[${r.key}](${env.JIRA_BASE_URL}/browse/${r.key})** (${r.priority}) - Age: \`${r.age_hours}h\` - Assignee: ${mention}`);
    }

    const desc = [
      `📅 **Date:** \`${dateStr}\``,
      "",
      `📥 **Total Open Backlog:** \`${openRes.count}\` issues`,
      `🏆 **Top Performer Yesterday:** ${topText}`,
      "",
      "✅ **Resolved Yesterday:**",
      resolvedList.length > 0 ? resolvedList.join("\n") : "No tickets resolved yesterday.",
      "",
      "⚠️ **Attention Required (Oldest Open/Critical):**",
      attentionList.length > 0 ? attentionList.join("\n") : "No critical open issues."
    ].join("\n");

    const embedMsg = {
      embeds: [
        {
          title: "☀️ Daily Engineering Summary Report",
          description: desc,
          color: 3447003,
        }
      ]
    };
    await sendDiscordMessage(env, channelId, embedMsg);
  }
  
  else if (type === "weekly") {
    // Generate Weekly Report (similar to /kpi week)
    const sinceDate = new Date();
    sinceDate.setDate(today.getDate() - 7);
    const sinceDateStr = sinceDate.toISOString().split("T")[0];
    const sinceISO = `${sinceDateStr}T00:00:00.000Z`;

    const createdRes = await env.DB.prepare(`SELECT COUNT(*) as count FROM issues WHERE created_at >= ?`).bind(sinceISO).first();
    const closedRes = await env.DB.prepare(`SELECT COUNT(*) as count, SUM(story_points) as sp FROM issues WHERE status_category = 'Done' AND resolved_at >= ?`).bind(sinceISO).first();
    
    const slaRes = await env.DB.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN ${SLA_SQL} THEN 1 ELSE 0 END) as met
      FROM issues
      WHERE status_category = 'Done' AND resolved_at >= ?
    `).bind(sinceISO).first();

    const backlogRes = await env.DB.prepare(`SELECT COUNT(*) as count FROM issues WHERE status_category != 'Done'`).first();
    
    const topDevsRes = await env.DB.prepare(`
      SELECT assignee_id, COUNT(*) as count 
      FROM issues 
      WHERE status_category = 'Done' AND resolved_at >= ? AND assignee_id IS NOT NULL
      GROUP BY assignee_id ORDER BY count DESC LIMIT 3
    `).bind(sinceISO).all();

    const topDevList = [];
    for (const row of topDevsRes.results) {
      const devName = await getDeveloperName(env, row.assignee_id);
      const mention = jiraToDiscord[row.assignee_id] ? `<@${jiraToDiscord[row.assignee_id]}>` : devName;
      topDevList.push(`${mention} (${row.count} tickets)`);
    }

    const slaCompliance = slaRes.total > 0 ? (slaRes.met / slaRes.total) * 100 : 100;

    const desc = [
      `📅 **Period:** \`${sinceDateStr}\` to \`${today.toISOString().split("T")[0]}\``,
      "",
      `📥 **Created Issues:** \`${createdRes.count}\``,
      `✅ **Resolved Issues:** \`${closedRes.count}\` (Total Story Points: \`${closedRes.sp || 0}\`)`,
      `🚨 **SLA Compliance:** \`${slaCompliance.toFixed(1)}%\``,
      `📥 **Current Backlog Size:** \`${backlogRes.count}\``,
      "",
      `🔥 **Top Resolution Contributors:**`,
      topDevList.length > 0 ? topDevList.map((d, i) => `${i + 1}. ${d}`).join("\n") : "No tasks resolved."
    ].join("\n");

    const embedMsg = {
      embeds: [
        {
          title: "📅 Weekly Support Engineering KPI Report",
          description: desc,
          color: 3066993, // Green
        }
      ]
    };
    await sendDiscordMessage(env, channelId, embedMsg);
  }
  
  else if (type === "monthly") {
    // Generate Monthly Report (similar to /kpi month)
    const sinceDate = new Date();
    sinceDate.setDate(today.getDate() - 30);
    const sinceDateStr = sinceDate.toISOString().split("T")[0];
    const sinceISO = `${sinceDateStr}T00:00:00.000Z`;

    const createdRes = await env.DB.prepare(`SELECT COUNT(*) as count FROM issues WHERE created_at >= ?`).bind(sinceISO).first();
    const closedRes = await env.DB.prepare(`SELECT COUNT(*) as count, SUM(story_points) as sp FROM issues WHERE status_category = 'Done' AND resolved_at >= ?`).bind(sinceISO).first();
    
    const slaRes = await env.DB.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN ${SLA_SQL} THEN 1 ELSE 0 END) as met
      FROM issues
      WHERE status_category = 'Done' AND resolved_at >= ?
    `).bind(sinceISO).first();

    const endDateStr = today.toISOString().split("T")[0];
    const rankings = await getLeaderboard(env, sinceDateStr, endDateStr, jiraToDiscord);

    const rankingList = rankings.length > 0
      ? rankings.map((r, i) => `${i + 1}. ${r.discordMention} — **Score: \`${r.score}\`** (${r.closed} closed)`).join("\n")
      : "No resolved issues.";

    const slaCompliance = slaRes.total > 0 ? (slaRes.met / slaRes.total) * 100 : 100;

    const desc = [
      `📅 **Period:** \`${sinceDateStr}\` to \`${endDateStr}\``,
      "",
      `📥 **Created Issues:** \`${createdRes.count}\``,
      `✅ **Resolved Issues:** \`${closedRes.count}\` (Total SP: \`${closedRes.sp || 0}\`)`,
      `🚨 **SLA Compliance:** \`${slaCompliance.toFixed(1)}%\``,
      "",
      "🏆 **Monthly Developer Rankings:**",
      rankingList
    ].join("\n");

    const embedMsg = {
      embeds: [
        {
          title: "🗓️ Monthly Support Engineering KPI Report",
          description: desc,
          color: 15105570, // Orange/Gold
        }
      ]
    };
    await sendDiscordMessage(env, channelId, embedMsg);
  }
}

async function updateInteractionResponse(env, interactionToken, messagePayload) {
  if (!env.APP_ID) {
    console.error("APP_ID is not configured. Cannot update interaction response.");
    return;
  }
  const url = `https://discord.com/api/v10/webhooks/${env.APP_ID}/${interactionToken}/messages/@original`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(messagePayload),
  });
  if (!response.ok) {
    const errText = await response.text();
    console.error(`Failed to update interaction response: ${response.status} - ${errText}`);
  }
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
        const isValidDiscordThreadUrl = (url) => typeof url === "string" && /^https?:\/\/(www\.)?discord\.com\/channels\/\d+\/\d+/.test(url);

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
        const businessUnit = opts.find((o) => o.name === "business_unit")?.value;
        const customerUrl = opts.find((o) => o.name === "customer_url")?.value;
 
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
          businessUnit,
          customerUrl,
        });
        sprintIdParam = result.finalSprintId;

        // Perform instant background sync of this issue to D1
        ctx.waitUntil(syncSingleIssue(env, result.issue.key));

        return Response.json(
          embed(
            "📌 Jira Task Created",
            `**Key:** [${result.issue.key}](${env.JIRA_BASE_URL}/browse/${result.issue.key})\n**Summary:** ${title}${storypoint ? `\n**Story Point:** ${storypoint}` : ""}${assigneeParam ? `\n**Assignee:** ${assigneeParam}` : ""}${sprintIdParam ? `\n**Sprint:** Added to current active sprint` : ""}${epicKeyParam ? `\n**Epic:** ${epicKeyParam}` : ""}${zohoTicketParam ? `\n**Zoho Ticket:** ${zohoTicketParam}` : ""}${businessUnit ? `\n**Business Unit:** ${businessUnit}` : ""}${customerUrl ? `\n**Customer URL:** [View Client Portal](${customerUrl})` : ""}${imageUrl ? `\n**Image:** [View Attachment](${imageUrl})` : ""}`,
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

    if (cmd === "zohodesk") {
      try {
        ctx.waitUntil((async () => {
          try {
            const accessToken = await getZohoAccessToken(env);

            // Fetch tickets from Zoho Desk
            const response = await fetch(
              "https://desk.zoho.com/api/v1/tickets?limit=10&status=With Developers&fields=ticketNumber,subject,status,cf_product_category,cf_developer,cf_expect_finish_by_dev,createdTime&viewId=483929000060650018",
              {
                headers: {
                  "Authorization": `Zoho-oauthtoken ${accessToken}`,
                  "orgId": env.ZOHO_ORG_ID
                }
              }
            );

            if (!response.ok) {
              const errText = await response.text();
              const errorPayload = embed("❌ Zoho API Error", `Failed to fetch tickets: ${response.status} - ${errText}`).data;
              await updateInteractionResponse(env, interaction.token, errorPayload);
              return;
            }

            const resData = await response.json();
            const tickets = resData.data || [];

            if (tickets.length === 0) {
              const emptyPayload = embed("🎟️ Zoho Desk Tickets", "No tickets found with status 'With Developers'.").data;
              await updateInteractionResponse(env, interaction.token, emptyPayload);
              return;
            }

            // Format tickets for Discord message
            const ticketList = tickets.map((t) => {
              const id = t.id;
              const ticketNo = t.ticketNumber || "N/A";
              const subject = t.subject || "No Subject";
              
              const cf = t.cf || {};
              const category = cf.cf_product_category || "ยังไม่ได้ระบุ";
              const developer = cf.cf_developer || "ยังไม่ได้ระบุ";
              
              let expectFinish = cf.cf_expect_finish_by_dev || "ยังไม่ได้ระบุ";
              if (expectFinish && expectFinish !== "ยังไม่ได้ระบุ") {
                try {
                  expectFinish = new Date(expectFinish).toLocaleString("th-TH", {
                    timeZone: "Asia/Bangkok",
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit"
                  });
                } catch {
                  // fallback
                }
              }

              let createdStr = "ยังไม่ได้ระบุ";
              if (t.createdTime) {
                try {
                  const d = new Date(t.createdTime);
                  createdStr = d.toLocaleDateString("th-TH", {
                    timeZone: "Asia/Bangkok",
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit"
                  });
                } catch {
                  createdStr = t.createdTime;
                }
              }

              const portalPath = env.ZOHO_PORTAL_PATH || "carmensoftware/carmen-software-support";
              const ticketUrl = id ? `https://desk.zoho.com/agent/${portalPath}/tickets/details/${id}` : null;
              const ticketTitle = ticketUrl ? `[#${ticketNo}](${ticketUrl})` : `#${ticketNo}`;

              return [
                `🎫 **${ticketTitle}** - **${subject}**`,
                `• 📦 **Product:** \`${category}\` | 👤 **Dev:** \`${developer}\``,
                `• 📅 **Expect Finish:** \`${expectFinish}\` | ⏳ **Created:** \`${createdStr}\``,
                `───────────────────`
              ].join("\n");
            }).join("\n");

            const successPayload = embed("🎟️ Zoho Desk Tickets (With Developers)", ticketList).data;
            await updateInteractionResponse(env, interaction.token, successPayload);
          } catch (err) {
            const errorPayload = embed("❌ Error", err.message).data;
            await updateInteractionResponse(env, interaction.token, errorPayload);
          }
        })());

        return Response.json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      } catch (err) {
        return Response.json(embed("❌ Error", err.message));
      }
    }

    if (cmd === "updatezoho") {
      try {
        const opts = interaction.data.options || [];
        const ticketInput = opts.find((o) => o.name === "ticket")?.value?.trim();
        const developerVal = opts.find((o) => o.name === "developer")?.value?.trim();
        const expectFinishVal = opts.find((o) => o.name === "expect_finish")?.value?.trim();

        if (!ticketInput) {
          return Response.json(embed("❌ Error", "Please provide a ticket number or ticket ID."));
        }

        if (developerVal === undefined && expectFinishVal === undefined) {
          return Response.json(
            embed("❌ Error", "Please provide at least one field to update (`developer` or `expect_finish`).")
          );
        }

        ctx.waitUntil((async () => {
          try {
            const accessToken = await getZohoAccessToken(env);

            // 1. Resolve ticket number to ticket ID if necessary
            let ticketId = ticketInput;
            let ticketNo = ticketInput;

            // If it's a short input (likely ticketNumber, e.g., not an 18-digit ID), look it up first
            if (ticketInput.length < 15) {
              let foundTicket = null;

              // Step A: Search in the 'With Developers' view (limit 100)
              const viewResponse = await fetch(
                "https://desk.zoho.com/api/v1/tickets?limit=100&viewId=483929000060650018",
                {
                  headers: {
                    "Authorization": `Zoho-oauthtoken ${accessToken}`,
                    "orgId": env.ZOHO_ORG_ID
                  }
                }
              );

              if (viewResponse.ok) {
                const viewData = await viewResponse.json();
                if (viewData.data) {
                  foundTicket = viewData.data.find(t => t.ticketNumber === ticketInput);
                }
              }

              // Step B: If not found, search in the latest 100 tickets of all statuses
              if (!foundTicket) {
                const listResponse = await fetch(
                  "https://desk.zoho.com/api/v1/tickets?limit=100",
                  {
                    headers: {
                      "Authorization": `Zoho-oauthtoken ${accessToken}`,
                      "orgId": env.ZOHO_ORG_ID
                    }
                  }
                );

                if (listResponse.ok) {
                  const listData = await listResponse.json();
                  if (listData.data) {
                    foundTicket = listData.data.find(t => t.ticketNumber === ticketInput);
                  }
                }
              }

              if (foundTicket) {
                ticketId = foundTicket.id;
                ticketNo = foundTicket.ticketNumber;
              } else {
                const errorPayload = embed(
                  "❌ Ticket Not Found",
                  `Could not find a ticket with number **${ticketInput}** in the active developer view or the latest 100 tickets.`
                ).data;
                await updateInteractionResponse(env, interaction.token, errorPayload);
                return;
              }
            }

            // 2. Build the PATCH body
            const cf = {};
            if (developerVal !== undefined) {
              cf.cf_developer = developerVal || null;
            }
            if (expectFinishVal !== undefined) {
              cf.cf_expect_finish_by_dev = parseZohoDateTime(expectFinishVal);
            }

            // 3. Send update request
            const updateResponse = await fetch(
              `https://desk.zoho.com/api/v1/tickets/${ticketId}`,
              {
                method: "PATCH",
                headers: {
                  "Authorization": `Zoho-oauthtoken ${accessToken}`,
                  "orgId": env.ZOHO_ORG_ID,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({ cf })
              }
            );

            if (!updateResponse.ok) {
              const errText = await updateResponse.text();
              const errorPayload = embed("❌ Zoho Update Error", `Failed to update ticket: ${updateResponse.status} - ${errText}`).data;
              await updateInteractionResponse(env, interaction.token, errorPayload);
              return;
            }

            // Format success message
            const updatedFields = [];
            if (developerVal !== undefined) {
              updatedFields.push(`• 👤 **Dev (นักพัฒนา):** \`${developerVal || "ล้างค่า"}\``);
            }
            if (expectFinishVal !== undefined) {
              updatedFields.push(`• 📅 **Expect Finish (วันเสร็จ):** \`${expectFinishVal || "ล้างค่า"}\``);
            }

            const portalPath = env.ZOHO_PORTAL_PATH || "carmensoftware/carmen-software-support";
            const ticketUrl = `https://desk.zoho.com/agent/${portalPath}/tickets/details/${ticketId}`;
            const successDesc = [
              `อัปเดตข้อมูล Ticket **[#${ticketNo}](${ticketUrl})** เรียบร้อยแล้ว:`,
              "",
              ...updatedFields
            ].join("\n");

            const successPayload = embed("🔄 Zoho Ticket Updated Successfully", successDesc).data;
            await updateInteractionResponse(env, interaction.token, successPayload);
          } catch (err) {
            const errorPayload = embed("❌ Error", err.message).data;
            await updateInteractionResponse(env, interaction.token, errorPayload);
          }
        })());

        return Response.json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
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
            /sprint – 🏃 Show current sprint board
            /mytasks – 📋 Show tasks assigned to you
            /linkjira – 🔗 Link your Discord account to Jira email
            /zohodesk – 🎟️ ดึงข้อมูล Ticket จาก Zoho Desk
            /updatezoho – 🔄 อัปเดตข้อมูลตั๋ว Zoho Desk (Dev / Expect Finish)
          `,
        ),
      );
    }
  },

  async scheduled(event, env, ctx) {
    const cron = event.cron;
    console.log(`Cron triggered: ${cron}`);
    
    if (cron === "*/15 * * * *") {
      ctx.waitUntil(syncJiraIssues(env, 20));
    } else if (cron === "0 0 * * *") {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const dateStr = yesterday.toISOString().split("T")[0];
      ctx.waitUntil(calculateAndSaveDailySnapshots(env, dateStr));
    } else if (cron === "0 8 * * *") {
      ctx.waitUntil(sendScheduledReport(env, "daily"));
    } else if (cron === "0 17 * * 5") {
      ctx.waitUntil(sendScheduledReport(env, "weekly"));
    } else if (cron === "0 8 1 * *") {
      ctx.waitUntil(sendScheduledReport(env, "monthly"));
    }
  },
};
