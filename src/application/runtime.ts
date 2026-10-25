import { ThreadTurnCoordinator } from "../ai/threadTurnCoordinator.js";
import { ConversationService } from "./conversations.js";
import type { ApplicationServices } from "./services.js";
import type { TurnFrontend } from "./turnFrontend.js";

type CoordinatorOptions = ConstructorParameters<typeof ThreadTurnCoordinator>[0];

export function createApplication(input: Omit<ApplicationServices, "turnCoordinator"> & {
  frontend: TurnFrontend;
  t: CoordinatorOptions["t"];
  scheduleThreadTitle?: CoordinatorOptions["scheduleThreadTitle"];
  awaitProcessingOnAccept?: boolean;
}) {
  const services: ApplicationServices = { ...input, turnCoordinator: new ThreadTurnCoordinator({
    ...input, canUse: userId => input.access.isAllowed(userId),
  }) };
  return { ...services, conversations: new ConversationService(services) };
}
