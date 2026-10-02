/**
 * Post-restart acceptance probe for the running DSH host.
 *
 * Calls the plugin's own management routes and prints what the live process
 * actually returns, so a result can be judged against the fixture tree instead
 * of inferred from the panel.
 *
 * Usage (PowerShell):
 *   node verify-live.mjs                      # all roots
 *   node verify-live.mjs "D:\path\to\project" # include project roots
 */

const BASE = process.env.DSH_BASE_URL ?? 'http://127.0.0.1:43120'
const STATE = `${BASE}/skill-manager/panel/state`
const SET = `${BASE}/skill-manager/panel/set`

const projectCwd = process.argv[2]

/** GET the state payload. */
async function readState(cwd) {
  const url = cwd === undefined ? STATE : `${STATE}?cwd=${encodeURIComponent(cwd)}`
  const response = await fetch(url, { headers: { host: '127.0.0.1' } })
  const text = await response.text()
  if (!response.ok) throw new Error(`state ${response.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

/** Print the tree depth-first. */
function printTree(nodes, indent = '') {
  for (const node of nodes) {
    const label = node.depth === 0 ? `[${node.kind}] ${node.path || '(root)'}` : node.name
    console.log(`${indent}${label} — total=${node.totalSkills} blocked=${node.blockedSkills} direct=${(node.skills ?? []).length}`)
    for (const skill of node.skills ?? []) {
      const flags = [skill.blocked ? 'blocked' : 'enabled', skill.usable === false ? `unusable: ${skill.defect}` : 'ok']
      if (skill.truncated === true) flags.push(`full=${skill.fullCategoryPath}`)
      console.log(`${indent}   · ${skill.name} [${flags.join(', ')}] cat=${skill.categoryPath}`)
    }
    printTree(node.children ?? [], `${indent}   `)
  }
}

const state = await readState(projectCwd)
console.log(`roots: ${(state.roots ?? []).map((root) => `${root.kind}=${root.path}`).join('  ')}`)
console.log(`maxDepth=${state.maxDepth} maxCategoryDepth=${state.maxCategoryDepth} blocked=${state.blockedCount}`)
console.log(`flatCategories=${(state.flatCategories ?? state.categories ?? []).length} treeRoots=${(state.tree ?? []).length}`)
console.log('')
printTree(state.tree ?? [])
if ((state.depthPruned ?? []).length > 0) {
  console.log('')
  console.log('depth-pruned directories:')
  for (const path of state.depthPruned) console.log(`  ${path}`)
}
