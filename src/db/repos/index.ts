import type { TextSearch } from "../search.js";
import type { SqlExecutor } from "../sql.js";
import { FilesRepo } from "./files.js";
import { MessagesRepo } from "./messages.js";
import { EmbeddingsRepo } from "./embeddings.js";
import { ThreadsRepo } from "./threads.js";
import { UsersRepo } from "./users.js";
import { ThreadSandboxesRepo } from "./threadSandboxes.js";
import { SandboxFileRestoresRepo } from "./sandboxFileRestores.js";
import { BrowserUseProfilesRepo } from "./browserUseProfiles.js";

export interface Repos {
  users: UsersRepo;
  threads: ThreadsRepo;
  messages: MessagesRepo;
  files: FilesRepo;
  embeddings: EmbeddingsRepo;
  threadSandboxes: ThreadSandboxesRepo;
  sandboxFileRestores: SandboxFileRestoresRepo;
  browserUseProfiles: BrowserUseProfilesRepo;
}

export function createRepos(db: SqlExecutor, search: TextSearch): Repos {
  return {
    users: new UsersRepo(db),
    threads: new ThreadsRepo(db),
    messages: new MessagesRepo(db, search),
    files: new FilesRepo(db, search),
    embeddings: new EmbeddingsRepo(db),
    threadSandboxes: new ThreadSandboxesRepo(db),
    sandboxFileRestores: new SandboxFileRestoresRepo(db),
    browserUseProfiles: new BrowserUseProfilesRepo(db),
  };
}
