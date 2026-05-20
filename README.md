# Staff feedback slackbot

A private Slack bot that helps you draft warm, clear messages to your
household staff. You speak/type raw feedback; it drafts something kind and
specific; you iterate until it's right; then you hit **Send** and the final
message is delivered **as you** (no bot badge) to the right person.

Only your Slack user ID can talk to it.

---

## Project layout

```
app/
  layout.tsx
  page.tsx                       small status page (private)
  api/slack/
    events/route.ts              receives DMs from you (Events API)
    interactivity/route.ts       receives button clicks (Send / Revise / Cancel)
lib/
  env.ts                         typed env access
  slack-verify.ts                request signature + owner check
```

---

## Setup

This guide assumes:

- You're a Workspace Owner / Admin on the Slack you want to install into.
- You have a [Vercel](https://vercel.com) account.
- You have an [Anthropic API key](https://console.anthropic.com/).

We do the Slack app setup **first** because we need its tokens to put in
Vercel.

### 1. Create the Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. App name: `Staff feedback drafter` (or whatever you want — only you see it).
3. Workspace: pick your household workspace.

Once it's created, you'll do these in the left sidebar.

> Note: do **OAuth & Permissions first**. Slack disables the "Messages Tab"
> toggle on the App Home page until your bot has at least one scope.

#### a. OAuth & Permissions → Scopes

Add these **Bot Token Scopes**:

- `chat:write` — post the draft back to you
- `im:history` — read DMs you send to the bot
- `im:read` — list DMs
- `im:write` — open DM with you
- `files:read` — read photos/videos you attach

Add these **User Token Scopes** (this is the magic for "send as me"):

- `chat:write` — post the final message **as you**
- `im:write` — open DMs to your staff **as you**

#### b. App Home

- Under **Show Tabs**, enable the **Messages Tab** so you can DM the bot.
- Check **Allow users to send Slash commands and messages from the messages tab**.

#### c. Event Subscriptions

- Toggle **Enable Events** ON.
- **Request URL** — you'll fill this in after deploying to Vercel (see step 3).
- Under **Subscribe to bot events**, add:
  - `message.im`

#### d. Interactivity & Shortcuts

- Toggle **Interactivity** ON.
- **Request URL** — same deal, fill in after deploying.

#### e. Install to workspace

- Top of the OAuth page: **Install to Workspace** → approve.
- Copy the two tokens you now see:
  - **Bot User OAuth Token** (`xoxb-...`) → `SLACK_BOT_TOKEN`
  - **User OAuth Token** (`xoxp-...`) → `SLACK_USER_TOKEN`
- From **Basic Information**, copy **Signing Secret** → `SLACK_SIGNING_SECRET`.

#### f. Your user ID

In Slack, click your own profile picture → **View profile** → **...** menu →
**Copy member ID**. That goes in `OWNER_SLACK_USER_ID` (looks like `U01ABC2DEF3`).

### 2. Deploy to Vercel

1. Push this repo to GitHub (already done if you followed along).
2. In Vercel, **Add New… → Project** → import the GitHub repo.
3. Framework preset: **Next.js** (auto-detected).
4. **Environment Variables** — add all the values from `.env.example`.
5. From the project's **Storage** tab, add an **Upstash Redis** integration.
   It auto-injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
6. Deploy.

### 3. Tell Slack where to find us

Once deployed, you'll have a URL like `https://staff-feedback-slackbot.vercel.app`.

Back in your Slack app config:

- **Event Subscriptions** → Request URL:
  `https://YOUR-DOMAIN/api/slack/events`
- **Interactivity & Shortcuts** → Request URL:
  `https://YOUR-DOMAIN/api/slack/interactivity`

Slack will verify the URL by pinging it; we handle the handshake in
`app/api/slack/events/route.ts`.

---

## Local development

```bash
cp .env.example .env.local   # fill in the values
npm install
npm run dev
```

To expose your local server to Slack during development, use Vercel's
preview deployments (push a branch and Vercel gives you a preview URL) or
install `vercel dev` and the Vercel CLI tunnel.

---

## Status

- [x] **Step 1** — Foundation: project, repo, Slack signature verification.
- [ ] **Step 2** — DM listener (owner-only) and acknowledgement.
- [ ] **Step 3** — Staff roster + recipient resolution.
- [ ] **Step 4** — LLM drafting (Claude via AI SDK).
- [ ] **Step 5** — Iteration loop with Send / Revise / Cancel buttons.
- [ ] **Step 6** — "Send as me" using the user token.
- [ ] **Step 7** — Attach photos / videos to the final message.
- [ ] **Step 8** — Deploy + end-to-end smoke test.
