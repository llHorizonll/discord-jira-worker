const APP_ID = process.env.APP_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;

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
        required: true,
      },
      {
        name: "issuetype",
        description: "Issue type",
        type: 3,
        required: true,
        choices: [
          { name: "Task", value: "Task" },
          { name: "Bug", value: "Bug" },
          { name: "Story", value: "Story" },
        ],
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
        name: "assignee",
        description: "👤 Jira email or Account ID",
        type: 3,
        required: false,
      },
      {
        name: "sprint",
        description: "🏃 Select a sprint (empty for active)",
        type: 3,
        required: false,
        autocomplete: true,
      },
      {
        name: "epic",
        description: "💎 Select an Epic",
        type: 3,
        required: false,
        autocomplete: true,
      },
    ],
  },
  {
    name: "sprint",
    description: "🏃 Show current sprint issues",
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
