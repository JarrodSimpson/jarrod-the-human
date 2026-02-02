// Jarrod the Human - Slack Feature Request Bot
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk').default;
const { LinearClient } = require('@linear/sdk');
const cron = require('node-cron');

const CONFIG = {
  linearTeamKey: 'KDE',
  featureRequestChannel: 'kde-product-requests',
  summaryChannel: 'well-do-it-live',
  timezone: 'America/Chicago',
};

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const linear = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });

const JARROD_SYSTEM_PROMPT = `You are Jarrod the Human, a friendly product feature request assistant for Koddi.

## Your Personality
- Casual and approachable like a friendly coworker
- Enthusiastic but not over-the-top
- Use emoji sparingly (1-2 per message max)
- Keep messages short and punchy
- Subtle humor about being an AI named "the Human"

## Your Goal
Guide users through sharing a feature request naturally. Understand:
1. What they want
2. Why they want it
3. Who it's for
4. How urgent it is

Never ask these as a checklist. Have a natural conversation.

## Guidelines
- Ask ONE follow-up question at a time
- Keep exchanges to 3-5 messages
- Mirror their energy
- Acknowledge what they said before asking more

## Example Follow-ups
- "Oh interesting—what's driving this?"
- "Got it. Is this something you're running into, or have customers been asking?"
- "Makes sense. How urgent is this—nice-to-have or blocking your work?"

## Wrapping Up
When you have enough context, wrap up:
- "Perfect, I've got it. I'll get this over to the product team. Thanks for the idea!"
- "Got it—sending this to the team now. Appreciate you sharing!"

IMPORTANT: Include "sending this to" or "get this over to" when wrapping up.

## Edge Cases
- Too vague: "Ha, I feel that. What specifically has been bugging you about it?"
- Bug report: "Hmm, this sounds like something's broken. Want me to route this as a bug?"
- Multiple ideas: "Love the energy! Let's tackle these one at a time. Which one's most important?"
- Frustrated: "Sounds like this has been a pain point. Let me capture this properly."`;

const conversations = new Map();
const dailyStats = { newRequests: [], date: new Date().toDateString() };

slackApp.message(async ({ message, say, client }) => {
  try {
    if (message.bot_id || message.subtype) return;

    const channelInfo = await client.conversations.info({ channel: message.channel });
    const channelName = channelInfo.channel?.name;
    const isDM = channelInfo.channel?.is_im;
    const isFeatureChannel = channelName === CONFIG.featureRequestChannel;

    if (!isFeatureChannel && !isDM) return;

    const threadTs = message.thread_ts || message.ts;
    const convKey = `${message.channel}-${threadTs}`;

    if (!conversations.has(convKey)) {
      conversations.set(convKey, {
        messages: [],
        userId: message.user,
        channel: message.channel,
        threadTs: threadTs,
        startTime: new Date(),
      });
    }

    const conv = conversations.get(convKey);
    conv.messages.push({ role: 'user', content: message.text });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: JARROD_SYSTEM_PROMPT,
      messages: conv.messages,
    });

    const jarrodReply = response.content[0].text;
    conv.messages.push({ role: 'assistant', content: jarrodReply });

    const replyOptions = { text: jarrodReply };
    if (isFeatureChannel) replyOptions.thread_ts = threadTs;
    await say(replyOptions);

    const isClosing = /sending this to|get this over to|logged and heading|this is logged/i.test(jarrodReply);
    if (isClosing) {
      await createLinearIssue(conv, client);
      conversations.delete(convKey);
    }
  } catch (error) {
    console.error('Error handling message:', error);
  }
});

async function createLinearIssue(conv, slackClient) {
  try {
    const userInfo = await slackClient.users.info({ user: conv.userId });
    const userName = userInfo.user?.real_name || userInfo.user?.name || 'Unknown';

    const extraction = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Extract the feature request. Return ONLY valid JSON.

Conversation:
${conv.messages.map(m => `${m.role}: ${m.content}`).join('\n')}

Return:
{
  "title": "Brief title (under 60 chars)",
  "description": "What they want",
  "problem": "Why they want it",
  "requester_type": "internal or customer",
  "urgency": "nice-to-have or important or blocking"
}`
      }],
    });

    let data;
    try {
      const jsonText = extraction.content[0].text;
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      data = JSON.parse(jsonMatch[0]);
    } catch (e) {
      data = {
        title: 'Feature Request from Slack',
        description: conv.messages.find(m => m.role === 'user')?.content || 'See conversation',
        problem: 'See conversation',
        requester_type: 'unknown',
        urgency: 'nice-to-have'
      };
    }

    const description = `**Description:**
${data.description}

**Why / Problem:**
${data.problem}

**Requested by:** ${data.requester_type === 'customer' ? 'Customer request' : 'Internal request'} (via ${userName})

**Urgency:** ${data.urgency}

---
*Submitted via Jarrod the Human*

<details>
<summary>Original Conversation</summary>

${conv.messages.map(m => `**${m.role === 'user' ? userName : 'Jarrod'}:** ${m.content}`).join('\n\n')}

</details>`;

    const teams = await linear.teams();
    const team = teams.nodes.find(t => t.key === CONFIG.linearTeamKey);
    if (!team) return console.error('Team not found:', CONFIG.linearTeamKey);

    const issue = await linear.createIssue({ teamId: team.id, title: data.title, description });
    console.log(`Created: ${issue.issue?.identifier} - ${data.title}`);
    trackNewRequest(issue.issue?.identifier, data.title);
  } catch (error) {
    console.error('Error creating Linear issue:', error);
  }
}

function trackNewRequest(identifier, title) {
  const today = new Date().toDateString();
  if (dailyStats.date !== today) {
    dailyStats.newRequests = [];
    dailyStats.date = today;
  }
  dailyStats.newRequests.push({ identifier, title });
}

async function postDailySummary() {
  try {
    const issues = await linear.issues({
      filter: { team: { key: { eq: CONFIG.linearTeamKey } }, state: { type: { eq: 'triage' } } },
    });

    const triageCount = issues.nodes.length;
    const newToday = dailyStats.newRequests.length;

    const summary = `Daily Feature Request Summary

New requests today: ${newToday}
${newToday > 0 ? dailyStats.newRequests.map(r => `  - ${r.identifier}: ${r.title}`).join('\n') : '  (none)'}

Waiting in triage: ${triageCount} requests
${triageCount > 5 ? '\nTriage queue is getting full!' : ''}`;

    const channels = await slackApp.client.conversations.list({ types: 'public_channel' });
    const channel = channels.channels?.find(c => c.name === CONFIG.summaryChannel);
    if (channel) {
      await slackApp.client.chat.postMessage({ channel: channel.id, text: summary });
      console.log('Posted daily summary');
    }
  } catch (error) {
    console.error('Error posting daily summary:', error);
  }
}

cron.schedule('0 17 * * *', postDailySummary, { timezone: CONFIG.timezone });

slackApp.event('app_home_opened', async ({ event, client }) => {
  try {
    await client.views.publish({
      user_id: event.user,
      view: {
        type: 'home',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*Hey! I'm Jarrod the Human*\n\nI help collect feature requests and get them to the product team.\n\n*How to submit an idea:*\n- Post in #${CONFIG.featureRequestChannel}\n- Or just DM me directly!\n\nNo forms, no fuss.` } },
        ],
      },
    });
  } catch (error) {
    console.error('Error updating app home:', error);
  }
});

(async () => {
  await slackApp.start();
  console.log('Jarrod the Human is running!');
  console.log(`Listening in #${CONFIG.featureRequestChannel}`);
  console.log(`Daily summaries to #${CONFIG.summaryChannel} at 5pm CDT`);
})();
