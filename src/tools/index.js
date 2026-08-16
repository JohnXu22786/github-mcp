/**
 * 工具装配：把六个领域的工具注册进注册表。
 */
import { ToolRegistry } from './registry.js'
import { repoTools } from './repo.js'
import { issueTools } from './issue.js'
import { pullTools } from './pull.js'
import { reviewTools } from './review.js'
import { searchTools } from './search.js'
import { accountTools } from './account.js'

export function buildRegistry(services) {
  const registry = new ToolRegistry()
  for (const def of [
    ...repoTools(services),
    ...issueTools(services),
    ...pullTools(services),
    ...reviewTools(services),
    ...searchTools(services),
    ...accountTools(services),
  ]) {
    registry.register(def)
  }
  return registry
}

export { ToolRegistry, validateArgs } from './registry.js'
