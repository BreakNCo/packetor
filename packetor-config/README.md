# packetor-config

Checked-in, idempotent setup for the Packetor deployment. `sync.sh` runs on every container
start (from `src/server.js`, before the gateway starts, never fatal) and can be run by hand:

```bash
railway ssh -- bash /app/packetor-config/sync.sh
```

| Step | What | Source of truth |
|---|---|---|
| skills | clone/fast-forward `BreakNCo/packetor-skills` (`main`) into `/data/workspace/packetor-skills`; skips if the clone has local changes or is on another branch. Needs `GITHUB_PAT_TOKEN` (read-only, never written to disk) | env `PACKETOR_SKILLS_*` |
| config | `skills.load.extraDirs`/`watch`, the Discord channel map (reply without a mention in `#leads-capture` and open a thread per post so posts run in parallel, mention required everywhere else), `agents.defaults.maxConcurrent=10` and `messages.groupChat.unmentionedInbound=room_event` (a bare `NO_REPLY` to un-mentioned chatter is honoured; visible replies must use the message tool) and `agents.entries.discord-ops.typingMode=instant` | `discord.json` |
| mcporter | add MCP servers from `mcporter-servers.json` (Firecrawl, key from env `FIRECRAWL_API_KEY`) to `/data/workspace-discord-ops/config/mcporter.json` if missing; never overwrites existing servers | `mcporter-servers.json` |
| agents | managed routing block in the Discord agent's `AGENTS.md` (between `packetor-config:<name>` markers) | `<skills clone>/<name>/agents-block.md` if present (e.g. `leads-capture/agents-block.md` in packetor-skills, so wording ships with a skills update), else the bundled `agents-blocks/<name>.md` |

Config steps are skipped until OpenClaw is onboarded (`/setup`); restart or re-run afterwards.
Set `PACKETOR_CONFIG_SYNC=0` in Railway to switch the whole thing off. Manual edits to the keys above
or inside the managed block are overwritten on the next start: change this directory instead.

To replicate elsewhere: new Railway service + volume at `/data`, set `SETUP_PASSWORD`, `GITHUB_PAT_TOKEN`,
`DISCORD_BOT_TOKEN`, run `/setup`, restart. Adding another block = drop a `.md` in `agents-blocks/`.

## Booking alerts (`booking-alert.json`)

New bookings on the Zoho Bigin **packets Intro Call** page are announced in Discord. This is plain code in
the wrapper (`src/booking-alert.js`), not an agent: no model is involved and it keeps working while the
gateway is down.

```
booking -> Bigin Notification API -> POST /bigin/booking-alert (wrapper) -> look up the event -> Discord (bot)
```

- On start, then every 6 hours, the wrapper (re)subscribes to `Events.create` for 23 hours (Bigin allows at
  most a day) and announces any booking created since the last successful check whose notification was missed.
- Only events made by a booking page (`$calendar_booking_event`) whose title starts with `titlePrefix` are
  announced, once each. Cancellations and reschedules are not announced separately.
- After 3 failed attempts it posts one warning in the same channel; it retries every 5 minutes. Logs: `[booking-alert]`.
- Needs: `DISCORD_BOT_TOKEN`, `RAILWAY_PUBLIC_DOMAIN` (set by Railway), and the `zoho-bigin` server in the
  mcporter config with the notification tools. No other secrets, DNS records or Bigin settings: the
  verification token is generated into `$OPENCLAW_STATE_DIR/booking-alert.json` with the list of announced events.
- `booking-alert.json`: Discord `channelId` and `roleId` to ping (`#book-demo-responses`, Demo Team), the title
  prefix, a numeric Bigin channel id, and the Bigin org URL for links. Set `BOOKING_ALERT=0` to switch it off.
- Run only one deployment with the same `biginChannelId`: a second one would take over the subscription.
