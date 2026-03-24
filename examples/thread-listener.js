import "dotenv/config";
import { Client, Events, GatewayIntentBits } from "discord.js";

const {
  BOT_TOKEN,
  WORKER_WEBHOOK_URL,
  THREAD_WEBHOOK_SECRET,
  DEFAULT_ISSUE_TYPE = "Task",
} = process.env;

if (!BOT_TOKEN || !WORKER_WEBHOOK_URL || !THREAD_WEBHOOK_SECRET) {
  throw new Error(
    "Missing env: BOT_TOKEN, WORKER_WEBHOOK_URL, THREAD_WEBHOOK_SECRET",
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Thread listener ready as ${readyClient.user.tag}`);
});

client.on(Events.ThreadCreate, async (thread) => {
  try {
    const payload = {
      threadId: thread.id,
      threadName: thread.name,
      guildId: thread.guild?.id,
      guildName: thread.guild?.name,
      channelId: thread.parentId,
      channelName: thread.parent?.name,
      ownerId: thread.ownerId,
      threadUrl: thread.url,
      issuetype: DEFAULT_ISSUE_TYPE,
    };

    const res = await fetch(WORKER_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-thread-webhook-secret": THREAD_WEBHOOK_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Webhook failed (${res.status}): ${text}`);
      return;
    }

    const data = await res.json();
    console.log(`Thread ${thread.id} -> Jira ${data.issueKey}`);
  } catch (err) {
    console.error("Thread webhook error:", err);
  }
});

client.login(BOT_TOKEN);
