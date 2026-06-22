const APP_ID = process.env.APP_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;

// 1. Get Zoho Access Token
async function getZohoAccessToken() {
  const env = process.env;
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    refresh_token: env.ZOHO_REFRESH_TOKEN
  });

  const res = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!res.ok) {
    throw new Error(`Failed to refresh Zoho token: ${res.status}`);
  }

  const data = await res.json();
  return data.access_token;
}

// 2. Fetch Zoho Developer Choices
async function getZohoDeveloperChoices() {
  try {
    const accessToken = await getZohoAccessToken();
    const res = await fetch(
      "https://desk.zoho.com/api/v1/layouts/483929000000074011/fields/483929000060650088/value?fileType=CSV",
      {
        headers: {
          "Authorization": `Zoho-oauthtoken ${accessToken}`,
          "orgId": process.env.ZOHO_ORG_ID
        }
      }
    );

    if (!res.ok) {
      throw new Error(`Failed to fetch developer layout values: ${res.status}`);
    }

    const text = await res.text();
    const list = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && s !== "-None-");
    
    return list.map((devName) => ({
      name: devName,
      value: devName
    }));
  } catch (err) {
    console.error("Warning: Could not fetch Zoho developer choices dynamically, using fallback list.", err.message);
    return [
      { name: "Ake", value: "Ake" },
      { name: "Ohm", value: "Ohm" },
      { name: "Noon", value: "Noon" },
      { name: "PP", value: "PP" }
    ];
  }
}

const developerChoices = await getZohoDeveloperChoices();

const commands = [
  {
    name: "create",
    description: "📌 Create Jira task with type / priority",
    options: [
      {
        name: "title",
        description: "Task title",
        type: 3,
        required: true,
      },
      {
        name: "description",
        description: "Task description",
        type: 3,
        required: false,
      },
      {
        name: "storypoint",
        description: "Story Point (1-10)",
        type: 4,
        required: false,
        min_value: 1,
        max_value: 10,
      },
      {
        name: "issuetype",
        description: "Issue type",
        type: 3,
        required: false,
        choices: [
          { name: "Task", value: "Task" },
          { name: "Bug", value: "Bug" },
          { name: "Story", value: "Story" },
        ],
      },
      {
        name: "priority",
        description: "Priority level",
        type: 3,
        required: false,
        choices: [
          { name: "Low", value: "Low" },
          { name: "Medium", value: "Medium" },
          { name: "High", value: "High" },
          { name: "Highest", value: "Highest" },
        ],
      },
      {
        name: "sprint",
        description: "🏃 Select a sprint (empty for active)",
        type: 3,
        required: false,
        autocomplete: true,
      },
      {
        name: "zoho_ticket",
        description: "🎫 Reference ticket number from Zoho",
        type: 3,
        required: false,
      },

      {
        name: "image",
        description: "🖼️ Attach an image to the task",
        type: 11,
        required: false,
      },
      {
        name: "assignee",
        description: "👤 Jira email or Account ID",
        type: 3,
        required: false,
      },

      {
        name: "epic",
        description: "💎 Select an Epic",
        type: 3,
        required: false,
        autocomplete: true,
      },
      {
        name: "business_unit",
        description: "🏢 Customer name or business unit",
        type: 3,
        required: false,
      },
      {
        name: "customer_url",
        description: "🔗 Customer portal URL or related ticket link",
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: "sprint",
    description: "🏃 Show current sprint issues",
    options: [
      {
        name: "status",
        description: "Filter by status (e.g. 'To Do', 'In Progress')",
        type: 3,
        required: false,
        choices: [
          { name: "In Progress", value: "In Progress" },
          { name: "HotFix", value: "HotFix" },
          { name: "Requirement", value: "Requirement" },
          { name: "TESTING", value: "TESTING" },
        ],
      },
    ],
  },
  {
    name: "mytasks",
    description: "📋 Show tasks assigned to you",
  },
  {
    name: "linkjira",
    description: "🔗 Link your Jira account using email",
    options: [
      {
        name: "email",
        description: "Your Jira email",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "zohodesk",
    description: "🎟️ ดึงข้อมูล Ticket จาก Zoho Desk",
  },
  {
    name: "updatezoho",
    description: "🔄 อัปเดตข้อมูล Developer และ วันคาดว่าจะเสร็จ ใน Zoho Desk",
    options: [
      {
        name: "ticket",
        description: "🎫 หมายเลข Ticket (เช่น 46608) หรือ Ticket ID",
        type: 3,
        required: true,
      },
      {
        name: "developer",
        description: "👤 ชื่อนักพัฒนา (Developer)",
        type: 3,
        required: false,
        choices: developerChoices,
      },
      {
        name: "expect_finish",
        description: "📅 วันเวลาคาดว่าจะเสร็จ (เช่น YYYY-MM-DD HH:mm หรือ YYYY-MM-DD)",
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: "help",
    description: "🤖 Show bot help",
  },
];

await fetch(`https://discord.com/api/v10/applications/${APP_ID}/commands`, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${BOT_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commands),
});

console.log("Commands registered");
