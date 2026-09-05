import type { TextSearch } from "../search.js";
import type { SqlExecutor } from "../sql.js";
import { FilesRepo } from "./files.js";
import { MessagesRepo } from "./messages.js";
import { ThreadsRepo } from "./threads.js";
import { UsersRepo } from "./users.js";
import { ThreadSandboxesRepo } from "./threadSandboxes.js";
import { SandboxFileRestoresRepo } from "./sandboxFileRestores.js";
import { BrowserUseProfilesRepo } from "./browserUseProfiles.js";
import { TurnRunsRepo } from "./turnRuns.js";
import { TurnActivityRepo } from "./turnActivity.js";
import { AudioTranscriptsRepo } from "./audioTranscripts.js";

export interface Repos {
  users: UsersRepo;
  threads: ThreadsRepo;
  messages: MessagesRepo;
  files: FilesRepo;
  threadSandboxes: ThreadSandboxesRepo;
  sandboxFileRestores: SandboxFileRestoresRepo;
  browserUseProfiles: BrowserUseProfilesRepo;
  turnRuns: TurnRunsRepo;
  turnActivity: TurnActivityRepo;
  audioTranscripts: AudioTranscriptsRepo;
}

export function createRepos(db: SqlExecutor, search: TextSearch): Repos {
  return {
    users: new UsersRepo(db),
    threads: new ThreadsRepo(db),
    messages: new MessagesRepo(db),
    files: new FilesRepo(db, search),
    threadSandboxes: new ThreadSandboxesRepo(db),
    sandboxFileRestores: new SandboxFileRestoresRepo(db),
    browserUseProfiles: new BrowserUseProfilesRepo(db),
    turnRuns: new TurnRunsRepo(db, search),
    turnActivity: new TurnActivityRepo(db),
    audioTranscripts: new AudioTranscriptsRepo(db),
  };
}
