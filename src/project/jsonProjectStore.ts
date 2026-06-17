import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Project, ProjectStore } from './types'

/**
 * jsonProjectStore — JSON-backed, in-process project persistence.
 *
 * Mirrors jsonSessionStore: mkdir -p the dir, persist the whole collection to a
 * single JSON file (projects.json) under it, read-modify-write on each mutation.
 * ids via randomUUID and timestamps via Date.now by default; both are injectable
 * so tests stay deterministic.
 */
export function jsonProjectStore(dir: string, opts?: { now?: () => number; id?: () => string }): ProjectStore {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const now = opts?.now ?? Date.now
  const id = opts?.id ?? randomUUID
  const projectsFile = join(dir, 'projects.json')

  const readAll = (): Project[] => {
    if (!existsSync(projectsFile)) return []
    return JSON.parse(readFileSync(projectsFile, 'utf8')) as Project[]
  }
  const writeAll = (rows: Project[]) => { writeFileSync(projectsFile, JSON.stringify(rows, null, 2) + '\n') }

  const createProject = (ownerId: string | undefined, name: string): Project => {
    const project: Project = {
      id: id(),
      ...(ownerId !== undefined ? { ownerId } : {}),
      name,
      createdAt: now(),
    }
    const projects = readAll()
    projects.push(project)
    writeAll(projects)
    return project
  }

  return {
    async create(ownerId, name) {
      return createProject(ownerId, name)
    },
    async getOrCreateDefault(ownerId, name) {
      // Idempotent "home" project: reuse the owner's project named `name`
      // ("我的") if it exists, else create it. Sessions with no explicit
      // project land here so the sidebar always nests them under a project.
      const existing = readAll().find((p) => p.ownerId === ownerId && p.name === name)
      return existing ?? createProject(ownerId, name)
    },
    async list(ownerId) {
      const projects = readAll()
      return ownerId === undefined ? projects : projects.filter((p) => p.ownerId === ownerId)
    },
    async rename(id, name) {
      const projects = readAll()
      const project = projects.find((p) => p.id === id)
      if (!project) return undefined
      project.name = name
      writeAll(projects)
      return project
    },
    async remove(id) {
      const projects = readAll()
      const next = projects.filter((p) => p.id !== id)
      if (next.length === projects.length) return false
      writeAll(next)
      return true
    },
  }
}
