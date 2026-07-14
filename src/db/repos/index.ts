import type { TextSearch } from "../search.js";
import type { SqlExecutor } from "../sql.js";
import { FilesRepo } from "./files.js";
import { InvitesRepo } from "./invites.js";
import { MessagesRepo } from "./messages.js";
import { EmbeddingsRepo } from "./embeddings.js";
import { ThreadsRepo } from "./threads.js";
import { UsersRepo } from "./users.js";

export interface Repos {
  users: UsersRepo;
  invites: InvitesRepo;
  threads: ThreadsRepo;
  messages: MessagesRepo;
  files: FilesRepo;
  embeddings: EmbeddingsRepo;
}

export function createRepos(db: SqlExecutor, search: TextSearch): Repos {
  return {
    users: new UsersRepo(db),
    invites: new InvitesRepo(db),
    threads: new ThreadsRepo(db),
    messages: new MessagesRepo(db, search),
    files: new FilesRepo(db, search),
    embeddings: new EmbeddingsRepo(db),
  };
}
