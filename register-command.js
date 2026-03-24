const APP_ID = process.env.APP_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;

const commands = [
  {
    name: "create",
    description: "Create Jira task with type / priority",
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
        description: "Jira email or Account ID (defaults to Unassigned)",
        type: 3,
        required: false,
      },
      {
        name: "sprint_id",
        description: "The ID of the sprint (leave empty for Backlog)",
        type: 3,
        required: false,
      },
      {
        name: "epic_key",
        description: "The Epic Key (e.g. PROJ-123)",
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: "sprint",
    description: "Show current sprint issues",
  },
  {
    name: "mytasks",
    description: "Show tasks assigned to you",
  },
  {
    name: "done",
    description: "Mark Jira task as done",
    options: [
      {
        name: "key",
        description: "Issue key (DEV-123)",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "linkjira",
    description: "Link your Jira account using email",
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
    description: "Show bot help",
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
