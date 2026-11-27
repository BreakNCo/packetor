import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import express from "express";

import { buildMessage, createBookingAlert, formatWhen, isIntroCallBooking, ROUTE } from "../src/booking-alert.js";

const CONFIG = path.join(process.cwd(), "packetor-config", "booking-alert.json");
const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const ENV = { RAILWAY_PUBLIC_DOMAIN: "bot.example.test", DISCORD_BOT_TOKEN: "test-token" };
const T0 = Date.parse("2026-11-27T12:00:00+05:30");
const MIN = 60_000;

// Shaped like the records Bigin returned for the real test booking.
const booking = (over = {}) => ({
  id: "111",
  Event_Title: "packets Intro Call for Asha Rao",
  Start_DateTime: "2026-12-30T17:00:00+05:30",
  End_DateTime: "2026-12-30T17:20:00+05:30",
  Created_Time: "2026-11-27T12:05:00+05:30",
  Participants: [{ type: "contact", Email: "asha@example.com", name: "Asha Rao" }],
  $calendar_booking_event: true,
  $event_cancelled: false,
  ...over,
});

function harness({ events = [], env = ENV, stateDir } = {}) {
  const h = { calls: [], posts: [], warnings: [], events, clock: T0, discordStatus: 200, subscribeCode: "SUCCESS" };
  h.stateDir = stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "booking-"));
  const exec = async (_bin, args) => {
    const tool = args[3].split(".")[1];
    const params = Object.fromEntries(args.slice(4).map((a) => [a.slice(0, a.indexOf("=")), JSON.parse(a.slice(a.indexOf("=") + 1))]));
    h.calls.push({ tool, params });
    const ok = (data) => JSON.stringify({ status: "success", data });
    if (tool === "Bigin_enableNotifications") return ok({ watch: [{ code: h.subscribeCode, details: { events: [{ channel_expiry: "x" }] } }] });
    if (tool === "Bigin_getRecords") {
      return h.events.length ? ok({ data: h.events }) : ok({ message: "Empty response received from API. With Status - 204." });
    }
    return ok({ data: h.events.filter((e) => e.id === params.path_variables.id) });
  };
  const fetchImpl = async (url, init) => {
    h.posts.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(h.discordStatus === 200 ? "{}" : "nope", { status: h.discordStatus });
  };
  const log = { log() {}, warn: (m) => h.warnings.push(m) };
  h.alert = createBookingAlert({ configPath: CONFIG, stateDir: h.stateDir, env, exec, fetchImpl, now: () => h.clock, log });
  h.state = () => JSON.parse(fs.readFileSync(path.join(h.stateDir, "booking-alert.json"), "utf8"));
  return h;
}

async function serve(h) {
  const app = express();
  app.use(express.json());
  h.alert.register(app);
  app.use((_req, res) => res.status(418).end());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const send = async (body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ROUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
    });
    await h.alert.idle();
    return res.status;
  };
  return { send, close: () => (h.alert.stop(), server.close()) };
}

// The body shape Bigin actually pushed during testing.
const push = (token, over = {}) => ({
  server_time: T0,
  query_params: {},
  module: "Events",
  ids: ["111"],
  affected_fields: [],
  operation: "insert",
  channel_id: config.biginChannelId,
  token,
  ...over,
});

test("only booking-page intro calls count", () => {
  const p = config.titlePrefix;
  assert.equal(isIntroCallBooking(booking(), p), true);
  assert.equal(isIntroCallBooking(booking({ $calendar_booking_event: false }), p), false);
  assert.equal(isIntroCallBooking(booking({ $event_cancelled: true }), p), false);
  assert.equal(isIntroCallBooking(booking({ Event_Title: "Daily Connect" }), p), false);
});

test("times are shown in India time", () => {
  assert.equal(formatWhen("2026-12-30T17:00:00+05:30", "2026-12-30T17:20:00+05:30"), "Wed, 30 Dec 2026, 5:00 PM – 5:20 PM IST");
  assert.equal(formatWhen("2026-09-01T04:00:00Z", "2026-09-01T04:20:00Z"), "Tue, 1 Sep 2026, 9:30 AM – 9:50 AM IST");
  assert.equal(formatWhen(undefined, undefined), "Unknown");
});

test("the message names the booker and cannot be used to ping or inject links", () => {
  const msg = buildMessage(booking({ Event_Title: `${config.titlePrefix}@everyone [x](http://evil.test) <@&1> ${"a".repeat(500)}` }), config);
  assert.deepEqual(msg.allowed_mentions, { parse: [], roles: [config.roleId] });
  assert.ok(msg.content.startsWith(`<@&${config.roleId}> New intro call booked: **`));
  assert.ok(msg.content.includes("\\[x\\]\\(http://evil.test\\)"));
  assert.ok(msg.content.includes("\\<@&1\\>"));
  assert.ok(msg.content.length < 2000);
  const plain = buildMessage(booking(), config).embeds[0].fields;
  assert.deepEqual(plain.map((f) => f.name), ["Booked by", "When", "Email", "Details"]);
  assert.equal(plain[3].value, `[Open in Bigin](${config.orgUrl}/Home#/events/111)`);
});

test("the wrapper registers the route ahead of the dashboard auth and gateway proxy", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src", "server.js"), "utf8");
  const register = src.indexOf("bookingAlert.register(app)");
  assert.ok(register > src.indexOf("app.use(express.json("));
  assert.ok(register < src.indexOf("app.use(requireDashboardAuth"));
  assert.ok(src.includes("bookingAlert.start()"));
});

test("stays off without a public domain, bot token or when disabled", async () => {
  for (const env of [{}, { ...ENV, RAILWAY_PUBLIC_DOMAIN: "" }, { ...ENV, BOOKING_ALERT: "0" }]) {
    const h = harness({ env });
    assert.equal(h.alert.enabled, false);
    const s = await serve(h);
    assert.equal(await s.send(push("anything")), 418);
    s.close();
  }
});

test("subscribes to new events with its own token and a sub-day expiry", async () => {
  const h = harness();
  assert.equal(await h.alert.tick(), 6 * 60 * MIN);
  const [watch] = h.calls[0].params.body.watch;
  assert.equal(watch.notify_url, `https://bot.example.test${ROUTE}`);
  assert.deepEqual(watch.events, ["Events.create"]);
  assert.equal(watch.channel_id, config.biginChannelId);
  assert.equal(watch.token, h.state().token);
  assert.ok(watch.token.length <= 50);
  assert.equal(watch.channel_expiry, "2026-11-28T11:00:00+05:30");
});

test("a push announces the booking once, as the bot, in the configured channel", async () => {
  const h = harness();
  await h.alert.tick();
  h.events = [booking()];
  const s = await serve(h);
  assert.equal(await s.send(push(h.state().token)), 200);
  assert.equal(await s.send(push(h.state().token)), 200);
  await h.alert.tick(); // the sweep must not announce it again
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].url, `https://discord.com/api/v10/channels/${config.channelId}/messages`);
  assert.equal(h.posts[0].headers.Authorization, "Bot test-token");
  s.close();
});

test("a push with a wrong or missing token is refused", async () => {
  const h = harness({ events: [booking()] });
  const s = await serve(h);
  for (const token of ["wrong", "", undefined, 42]) assert.equal(await s.send(push(token)), 401);
  assert.equal(h.calls.length, 0);
  assert.equal(h.posts.length, 0);
  s.close();
});

test("other events, other operations and odd ids are ignored", async () => {
  const h = harness({ events: [booking({ $calendar_booking_event: false })] });
  const s = await serve(h);
  await h.alert.tick();
  h.calls.length = 0;
  const token = h.state().token;
  await s.send(push(token, { module: "Contacts" }));
  await s.send(push(token, { operation: "delete" }));
  await s.send(push(token, { ids: ["../x", 5, null] }));
  assert.equal(h.calls.length, 0);
  h.events = [booking({ id: "333", $calendar_booking_event: false })];
  assert.equal(await s.send(push(token, { ids: ["333"] })), 200);
  assert.equal(h.posts.length, 0);
  s.close();
});

test("first run never announces old bookings", async () => {
  const h = harness({ events: [booking({ Created_Time: "2026-11-27T11:59:00+05:30" })] });
  await h.alert.tick();
  assert.equal(h.posts.length, 0);
});

test("a later run announces a booking whose push never arrived, and survives a restart", async () => {
  const h = harness();
  await h.alert.tick();
  const h2 = harness({ stateDir: h.stateDir, events: [booking(), booking({ id: "9", Event_Title: "Daily Connect" })] });
  h2.clock = T0 + 24 * 60 * MIN; // down for a day
  await h2.alert.tick();
  assert.equal(h2.posts.length, 1);
  await h2.alert.tick();
  assert.equal(h2.posts.length, 1);
  assert.equal(h2.state().token, h.state().token);
});

test("a Discord failure is retried by the next run, not forgotten", async () => {
  const h = harness();
  await h.alert.tick();
  h.events = [booking()];
  h.clock = T0 + 60 * MIN;
  h.discordStatus = 500;
  assert.equal(await h.alert.tick(), 5 * MIN);
  assert.ok(!h.state().seen.includes("111"));
  h.discordStatus = 200;
  h.clock = T0 + 90 * MIN;
  await h.alert.tick();
  assert.ok(h.state().seen.includes("111"));
});

test("if renewing fails, bookings are still announced and the channel is warned once", async () => {
  const h = harness();
  await h.alert.tick();
  h.subscribeCode = "NOT_ALLOWED";
  h.events = [booking()];
  h.clock = T0 + 60 * MIN;
  for (let i = 0; i < 5; i++) assert.equal(await h.alert.tick(), 5 * MIN);
  assert.equal(h.posts.filter((p) => p.body.content.includes("New intro call booked")).length, 1);
  const warnings = h.posts.filter((p) => p.body.content.startsWith("⚠️"));
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].body.allowed_mentions, { parse: [] });
});

test("errors from the Bigin tool never leak URLs into logs", async () => {
  const warnings = [];
  const alert = createBookingAlert({
    configPath: CONFIG,
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "booking-")),
    env: ENV,
    exec: async () => {
      throw new Error("request to https://mcp.example.test/?key=SECRET failed");
    },
    log: { log() {}, warn: (m) => warnings.push(m) },
  });
  await alert.tick();
  assert.ok(warnings.length > 0);
  assert.ok(!warnings.join(" ").includes("SECRET"));
});
