/** A project — a named container that scopes sessions/loops under one owner. */
export interface Project {
  id: string
  /** The user who owns this project; set by the HTTP surface when scoping. Unowned = visible to all (dev). */
  ownerId?: string
  name: string
  createdAt: number
}

/**
 * Standalone project persistence. JSON-backed, in-process. Mirrors the shape of
 * SessionStore/LoopStore: a small async surface with an injectable clock + id
 * factory for tests.
 */
export interface ProjectStore {
  /** Create a project; ownerId scopes it to one user (undefined = unowned/dev). */
  create(ownerId: string | undefined, name: string): Promise<Project>
  /** The owner's "home" project named `name` ("我的"), creating it if absent.
   *  Idempotent — sessions with no explicit project default into this one. */
  getOrCreateDefault(ownerId: string | undefined, name: string): Promise<Project>
  /** All projects, narrowed to one owner when ownerId is set. */
  list(ownerId?: string): Promise<Project[]>
  /** Rename a project; resolves undefined when no project has that id. */
  rename(id: string, name: string): Promise<Project | undefined>
  /** Delete a project; resolves true when one was removed, false when absent. */
  remove(id: string): Promise<boolean>
}
