import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createGrammyEmulator, type GrammyEmulator } from "../helpers/grammy-emulate.js";
import { BotChatService } from "../../src/web/chat-service.js";
import { ConversationRepository } from "../../src/web/repository.js";
import { createPiToolAdapters } from "../../src/pi/toolAdapter.js";
import { ChatScheduler } from "../../src/scheduling/runner.js";

let env: GrammyEmulator;
beforeEach(async () => {
  env = await createGrammyEmulator({ privateTopics: true });
  await env.bot.sendCommand(env.user, env.chat, "/start");
});
afterEach(async () => { await env.dispose(); });

it("runs a tool-created check through the normal conversation engine and surfaces it on the website", async () => {
  const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
  const user = await env.repos.users.get(env.user.id);
  if (!user) throw new Error("Missing fixture user");
  const tool = createPiToolAdapters({ buildInput: () => ({ config: env.config, db: env.db, repos: env.repos, user, thread }) }).find(tool => tool.name === "schedule_chat");
  if (!tool) throw new Error("Scheduling tool is not registered");
  expect(tool.parameters).toMatchObject({ type: "object" });
  const nextRunAt = Date.now() + 1000;
  const result = await tool.execute("schedule-call", { request: { action: "create", title: "Weather", prompt: "Check today's weather", nextRunAt, intervalMinutes: null } }, new AbortController().signal, undefined, {} as never);
  expect(result.isError).not.toBe(true);
  const chat = new BotChatService({ services: env.services, api: env.bot.api, repository: new ConversationRepository(env.db.db, env.repos) });
  const listed = await chat.schedules(user.tg_id);
  expect(listed.items).toHaveLength(1);
  const scheduler = new ChatScheduler({ schedules: env.repos.schedules, access: env.services.access,
    logger: env.services.logger, wake: id => env.services.turnCoordinator.wake(id) });
  await scheduler.tick(nextRunAt);
  await env.services.turnCoordinator.waitForIdle(thread.id);
  const history = await chat.history(user.tg_id, thread.id);
  expect(history.messages.at(-1)).toMatchObject({ role: "assistant", text: expect.stringContaining("Check today's weather") });
  expect(history.thread.unread).toBe(false);
  expect((await chat.schedules(user.tg_id)).items[0]).toMatchObject({ enabled: false, lastRunAt: nextRunAt });
  await scheduler.stop();
});

it("pauses scheduled checks for revoked accounts before enqueueing any work", async () => {
  const thread = await env.repos.threads.activeForUserTopic(env.user.id, null);
  const nextRunAt = Date.now() + 1000;
  await env.repos.schedules.create(env.user.id, { threadId: thread.id, title: "Check", prompt: "Check it", nextRunAt, intervalMinutes: 60 });
  await env.services.access.revoke(env.user.id);
  const wake = vi.fn();
  const scheduler = new ChatScheduler({ schedules: env.repos.schedules, access: env.services.access, logger: env.services.logger, wake });
  await scheduler.tick(nextRunAt);
  expect(wake).not.toHaveBeenCalled();
  expect(await env.repos.turnRuns.listForThread(thread.id)).toEqual([]);
  expect((await env.repos.schedules.list(env.user.id))[0]?.enabled).toBe(false);
  await scheduler.stop();
});
