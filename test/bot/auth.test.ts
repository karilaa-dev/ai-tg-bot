import { expect, it, vi } from "vitest";
import { initializeUserAndThread } from "../../src/bot/auth.js";
import type { BotContext } from "../../src/bot/context.js";

it("does not create a user for bot-authored topic creation service messages", async () => {
  const ensure = vi.fn().mockResolvedValue({ tg_id: 99 });
  const next = vi.fn();
  const ctx = {
    from: { id: 99, is_bot: true, first_name: "Test Bot", username: "test_bot" },
    msg: { forum_topic_created: { name: "New topic" } },
    services: { repos: { users: { ensure } } },
  } as unknown as BotContext;
  await initializeUserAndThread(ctx, next);
  expect(ensure).not.toHaveBeenCalled();
  expect(ctx.user).toBeUndefined();
  expect(next).toHaveBeenCalledOnce();
});
