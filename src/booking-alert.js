// Announces new Bigin intro-call bookings in Discord. No model or agent is involved.
//
// Bigin's Notification API calls us (record ids only) when an event is created. We look the event up, keep only
// bookings made on the booking page, and post them as the bot. A subscription lasts at most a day, so we renew
// it here; each renewal also looks for bookings whose notification never arrived (e.g. we were down).
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ROUTE = "/bigin/booking-alert";

const HOUR = 60 * 60 * 1000;
const RENEW_EVERY = 6 * HOUR;
const LIFETIME = 23 * HOUR; // Bigin silently falls back to 1 hour if asked for more than a day
const RETRY_AFTER = 5 * 60 * 1000;
const START_DELAY = 60 * 1000;
const SWEEP_OVERLAP = 10 * 60 * 1000;
const MAX_LOOKBACK = 7 * 24 * HOUR;
const MAX_REMEMBERED = 500;
const ALERT_AFTER_FAILURES = 3;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// Names and addresses are typed by whoever books: keep them from being read as formatting, links or mentions.
const escapeMarkdown = (s) => s.replace(/[\\*_~`|>#[\]()<]/g, "\\$&");
const redactUrls = (s) => String(s).replace(/https?:\/\/\S+/g, "[url]");

export function isIntroCallBooking(event, titlePrefix) {
  return (
    event?.$calendar_booking_event === true &&
    !event.$event_cancelled &&
    typeof event.Event_Title === "string" &&
    event.Event_Title.startsWith(titlePrefix)
  );
}

/** "Wed, 30 Dec 2026, 5:00 PM – 5:20 PM IST" */
export function formatWhen(start, end) {
  const from = new Date(start);
  if (Number.isNaN(from.getTime())) return "Unknown";
  const zone = { timeZone: "Asia/Kolkata" };
  const day = (d) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", { ...zone, weekday: "short", day: "numeric", month: "short", year: "numeric" })
        .formatToParts(d)
        .map((x) => [x.type, x.value]),
    );
    return `${p.weekday}, ${p.day} ${p.month.slice(0, 3)} ${p.year}`;
  };
  const time = (d) =>
    new Intl.DateTimeFormat("en-US", { ...zone, hour: "numeric", minute: "2-digit" }).format(d).replace(/\s/g, " ");
  const to = new Date(end);
  const until = Number.isNaN(to.getTime()) ? "" : ` – ${day(to) === day(from) ? "" : `${day(to)}, `}${time(to)}`;
  return `${day(from)}, ${time(from)}${until} IST`;
}

export function buildMessage(event, { titlePrefix, roleId, orgUrl }) {
  const name = escapeMarkdown(clip(event.Event_Title.slice(titlePrefix.length).trim() || "Unknown", 80));
  const emails = (event.Participants ?? [])
    .filter((p) => p?.type === "contact" || p?.type === "email")
    .map((p) => p.Email)
    .filter(Boolean);
  const field = (label, value, inline = false) => ({ name: label, value, inline });

  return {
    content: `${roleId ? `<@&${roleId}> ` : ""}New intro call booked: **${name}**`,
    // only ever ping the configured role, never @everyone or anything typed by the booker
    allowed_mentions: { parse: [], roles: roleId ? [roleId] : [] },
    embeds: [
      {
        title: "New intro call booking",
        color: 0x7b5bc0,
        fields: [
          field("Booked by", name),
          field("When", formatWhen(event.Start_DateTime, event.End_DateTime)),
          ...(emails.length ? [field("Email", escapeMarkdown(clip(emails.join(", "), 300)))] : []),
          field("Details", `[Open in Bigin](${orgUrl}/Home#/events/${event.id})`),
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

function execMcporter(bin, args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(bin, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(redactUrls(stderr || stdout || error.message).slice(0, 300)));
      else resolve(stdout);
    });
  });
}

/** ISO 8601 with the +05:30 offset, the form Bigin's own responses use. */
const toIst = (ms) => `${new Date(ms + 5.5 * HOUR).toISOString().slice(0, 19)}+05:30`;

export function createBookingAlert({
  configPath,
  stateDir,
  env = process.env,
  exec = execMcporter,
  fetchImpl = fetch,
  now = Date.now,
  log = console,
}) {
  let config = null;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") log.warn(`[booking-alert] bad config: ${error.message}`);
  }
  const domain = env.RAILWAY_PUBLIC_DOMAIN;
  const enabled = Boolean(config && domain && env.DISCORD_BOT_TOKEN && env.BOOKING_ALERT !== "0");

  const statePath = path.join(stateDir, "booking-alert.json");
  let state = null;
  function loadState() {
    if (state) return state;
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
      state = {};
    }
    state.token ||= crypto.randomBytes(20).toString("hex");
    // First run: start from now, so old bookings are never announced.
    state.firstRun ||= now();
    state.since ||= state.firstRun;
    state.seen ||= [];
    saveState();
    return state;
  }
  function saveState() {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(`${statePath}.tmp`, statePath);
  }
  function remember(id) {
    state.seen = [...state.seen.filter((x) => x !== id), id].slice(-MAX_REMEMBERED);
    saveState();
  }

  async function bigin(tool, args) {
    const stdout = await exec(env.MCPORTER_BIN || "/data/npm/bin/mcporter", [
      "--config",
      env.MCPORTER_CONFIG || "/data/workspace-discord-ops/config/mcporter.json",
      "call",
      `${env.BIGIN_SERVER || "zoho-bigin"}.${tool}`,
      ...Object.entries(args).map(([key, value]) => `${key}=${JSON.stringify(value)}`),
    ]);
    const response = JSON.parse(stdout);
    if (response.status !== "success") throw new Error(redactUrls(stdout).slice(0, 300));
    return response.data;
  }

  async function post(message) {
    const res = await fetchImpl(`https://discord.com/api/v10/channels/${config.channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (packetor, 1.0)",
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Discord responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  // One event at a time, so a notification and a sweep can never both announce the same booking.
  let queue = Promise.resolve();
  function handle(id) {
    const run = queue.then(async () => {
      loadState();
      if (state.seen.includes(id)) return;
      const data = await bigin("Bigin_getSpecificRecord", { path_variables: { module_api_name: "Events", id } });
      const event = data?.data?.[0];
      if (!event) throw new Error(`event ${id} not found`);
      if (isIntroCallBooking(event, config.titlePrefix)) {
        await post(buildMessage(event, config));
        log.log(`[booking-alert] announced event ${id}`);
      }
      remember(id);
    });
    queue = run.catch(() => {});
    return run;
  }

  async function subscribe() {
    loadState();
    // Enabling an existing channel again replaces its expiry, so this both creates and renews.
    const data = await bigin("Bigin_enableNotifications", {
      body: {
        watch: [
          {
            channel_id: config.biginChannelId,
            events: ["Events.create"],
            channel_expiry: toIst(now() + LIFETIME),
            token: state.token,
            notify_url: `https://${domain}${ROUTE}`,
          },
        ],
      },
    });
    const result = data?.watch?.[0];
    if (result?.code !== "SUCCESS") {
      throw new Error(`subscribe failed: ${result?.code ?? "no result"} ${redactUrls(result?.message ?? "")}`);
    }
    log.log(`[booking-alert] subscribed until ${result.details?.events?.[0]?.channel_expiry}`);
  }

  /** Announces bookings created since the last successful sweep that no notification covered. */
  async function sweep() {
    loadState();
    const sweptAt = now();
    const from = Math.max(state.since - SWEEP_OVERLAP, sweptAt - MAX_LOOKBACK, state.firstRun);
    const data = await bigin("Bigin_getRecords", {
      path_variables: { module_api_name: "Events" },
      query_params: { fields: "Event_Title,Created_Time", sort_by: "Created_Time", sort_order: "desc", per_page: 100 },
    });
    const missed = (data?.data ?? []).filter(
      (e) =>
        Date.parse(e.Created_Time) >= from &&
        e.Event_Title?.startsWith(config.titlePrefix) &&
        !state.seen.includes(e.id),
    );
    for (const e of missed.reverse()) await handle(e.id);
    state.since = sweptAt;
    saveState();
  }

  let timer = null;
  let failures = 0;
  let stopped = false;
  /** Renews, then sweeps. Returns the delay until the next run. */
  async function tick() {
    const errors = [];
    // The sweep runs even if renewing fails, so bookings are still announced (late) while it is broken.
    for (const step of [subscribe, sweep]) await step().catch((error) => errors.push(error));
    if (errors.length === 0) {
      failures = 0;
      return RENEW_EVERY;
    }
    failures += 1;
    for (const error of errors) log.warn(`[booking-alert] attempt ${failures} failed: ${redactUrls(error.message)}`);
    if (failures === ALERT_AFTER_FAILURES) {
      await post({
        content:
          "⚠️ Booking alerts are failing: Packetor couldn't renew or check Bigin bookings. " +
          "New intro calls may be announced late or not at all. See the Railway logs for `[booking-alert]`.",
        allowed_mentions: { parse: [] },
      }).catch((e) => log.warn(`[booking-alert] could not post the warning: ${e.message}`));
    }
    return RETRY_AFTER;
  }
  function schedule(delay) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(async () => schedule(await tick()), delay);
    timer.unref?.();
  }

  function receive(req, res) {
    const { token, module: moduleName, operation, ids } = req.body ?? {};
    const expected = Buffer.from(loadState().token);
    const given = Buffer.from(typeof token === "string" ? token : "");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return res.status(401).json({ ok: false });
    }
    // Answer first: Bigin only needs to know the notification arrived.
    res.json({ ok: true });
    if (moduleName !== "Events" || operation !== "insert" || !Array.isArray(ids)) return;
    for (const id of ids.slice(0, 20)) {
      if (typeof id !== "string" || !/^\d{1,30}$/.test(id)) continue;
      handle(id).catch((error) => {
        // It stays unremembered, so the next sweep picks it up.
        log.warn(`[booking-alert] event ${id} failed, will retry: ${redactUrls(error.message)}`);
        schedule(RETRY_AFTER);
      });
    }
  }

  return {
    enabled,
    register(app) {
      if (enabled) app.post(ROUTE, receive);
    },
    start() {
      if (!enabled) {
        log.log("[booking-alert] off (needs booking-alert.json, RAILWAY_PUBLIC_DOMAIN and DISCORD_BOT_TOKEN)");
        return;
      }
      schedule(START_DELAY);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    // exposed for tests
    tick,
    sweep,
    handle,
    idle: () => queue,
  };
}
