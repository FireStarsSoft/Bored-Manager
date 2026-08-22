#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

interface Contract {
  rpcHandlers: Set<string>
  rpcInvokes: Set<string>
  sendHandlers: Set<string>
  clientSends: Set<string>
  serverPushes: Set<string>
  clientListeners: Set<string>
  serverRoutes: Set<string>
  clientRequests: Set<string>
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverRoot = join(root, 'server')
const clientRoot = join(root, 'src')
const clientApiFile = join(root, 'src', 'lib', 'ws-api.ts')

/** Deliberate diagnostics/internal methods, not part of the renderer facade. */
const SERVER_ONLY_RPC = new Set(['app:ping', 'modules:enabledIds'])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name))) out.push(path)
  }
  return out
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

function staticString(node: ts.Expression | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null
}

function propertyCall(node: ts.CallExpression): {
  receiver: ts.Expression
  method: string
} | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null
  return { receiver: node.expression.expression, method: node.expression.name.text }
}

function isIdentifier(node: ts.Node, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name
}

function walk(source: ts.SourceFile, visit: (call: ts.CallExpression) => void): void {
  const each = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) visit(node)
    ts.forEachChild(node, each)
  }
  each(source)
}

function requestMethod(call: ts.CallExpression): string {
  const options = call.arguments[1]
  if (!options || !ts.isObjectLiteralExpression(options)) return 'GET'
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = property.name
    const key =
      ts.isIdentifier(name) || ts.isStringLiteralLike(name)
        ? name.text
        : null
    if (key !== 'method') continue
    return staticString(property.initializer)?.toUpperCase() ?? 'GET'
  }
  return 'GET'
}

function routeKey(method: string, path: string): string {
  const fullPath = path.startsWith('/api/') ? path : `/api${path}`
  return `${method.toUpperCase()} ${fullPath}`
}

function collectServer(contract: Contract): void {
  for (const file of sourceFiles(serverRoot)) {
    const source = parse(file)
    walk(source, (call) => {
      const property = propertyCall(call)
      const first = staticString(call.arguments[0])
      const second = staticString(call.arguments[1])

      if (property && first) {
        if (property.method === 'registerHandler' || property.method === 'registerClientHandler') {
          contract.rpcHandlers.add(first)
        } else if (property.method === 'registerSend') {
          contract.sendHandlers.add(first)
        } else if (property.method === 'broadcast') {
          contract.serverPushes.add(first)
        } else if (
          isIdentifier(property.receiver, 'api') &&
          ['get', 'post', 'put', 'patch', 'delete'].includes(property.method)
        ) {
          contract.serverRoutes.add(routeKey(property.method, first))
        }
      }

      if (property?.method === 'broadcastToMachine' && second) {
        contract.serverPushes.add(second)
      }
      if (isIdentifier(call.expression, 'send') && first) {
        contract.serverPushes.add(first)
      }
      if (isIdentifier(call.expression, 'sendToMachine') && second) {
        contract.serverPushes.add(second)
      }
    })
  }
}

function collectClient(contract: Contract): void {
  for (const file of sourceFiles(clientRoot)) {
    const source = parse(file)
    const inFacade = resolve(file) === resolve(clientApiFile)
    walk(source, (call) => {
      const first = staticString(call.arguments[0])
      if (!first) return

      const property = propertyCall(call)
      if (inFacade && isIdentifier(call.expression, 'invoke')) contract.rpcInvokes.add(first)
      if (inFacade && isIdentifier(call.expression, 'on')) contract.clientListeners.add(first)
      if (property && isIdentifier(property.receiver, 'client')) {
        if (property.method === 'invoke') contract.rpcInvokes.add(first)
        else if (property.method === 'send') contract.clientSends.add(first)
        else if (property.method === 'on') contract.clientListeners.add(first)
      }

      if (inFacade && isIdentifier(call.expression, 'postFile')) {
        contract.clientRequests.add(routeKey('POST', first))
      } else if (inFacade && isIdentifier(call.expression, 'downloadUrl')) {
        contract.clientRequests.add(routeKey('GET', first))
      } else if (isIdentifier(call.expression, 'fetch') && first.startsWith('/api/')) {
        contract.clientRequests.add(routeKey(requestMethod(call), first))
      }
    })
  }
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort()
}

function difference(left: Set<string>, right: Set<string>): string[] {
  return sorted([...left].filter((item) => !right.has(item)))
}

function reportSet(label: string, values: Set<string>): void {
  console.log(`${label} (${values.size}): ${sorted(values).join(', ') || '(none)'}`)
}

const contract: Contract = {
  rpcHandlers: new Set(),
  rpcInvokes: new Set(),
  sendHandlers: new Set(),
  clientSends: new Set(),
  serverPushes: new Set(),
  clientListeners: new Set(),
  serverRoutes: new Set(),
  clientRequests: new Set()
}

collectServer(contract)
collectClient(contract)

const failures: string[] = []
const callableHandlers = new Set(
  [...contract.rpcHandlers].filter((channel) => !SERVER_ONLY_RPC.has(channel))
)

for (const channel of difference(contract.rpcInvokes, contract.rpcHandlers)) {
  failures.push(`client invokes "${channel}", but the server does not register it`)
}
for (const channel of difference(callableHandlers, contract.rpcInvokes)) {
  failures.push(`server registers "${channel}", but the client does not invoke it`)
}
for (const channel of difference(SERVER_ONLY_RPC, contract.rpcHandlers)) {
  failures.push(`server-only RPC allowlist contains stale channel "${channel}"`)
}
for (const channel of difference(contract.clientSends, contract.sendHandlers)) {
  failures.push(`client sends "${channel}", but the server does not register it`)
}
for (const channel of difference(contract.sendHandlers, contract.clientSends)) {
  failures.push(`server receives send "${channel}", but the client never sends it`)
}
for (const channel of difference(contract.clientListeners, contract.serverPushes)) {
  failures.push(`client listens for "${channel}", but the server never pushes it`)
}
for (const channel of difference(contract.serverPushes, contract.clientListeners)) {
  failures.push(`server pushes "${channel}", but the client never listens for it`)
}
for (const route of difference(contract.clientRequests, contract.serverRoutes)) {
  failures.push(`client requests ${route}, but the server does not register it`)
}
for (const route of difference(contract.serverRoutes, contract.clientRequests)) {
  failures.push(`server registers ${route}, but the client never requests it`)
}

console.log(`Protocol source root: ${relative(process.cwd(), root) || '.'}`)
reportSet('RPC handlers', contract.rpcHandlers)
reportSet('RPC invokes', contract.rpcInvokes)
reportSet('Client send channels', contract.clientSends)
reportSet('Server push channels', contract.serverPushes)
reportSet('HTTP routes', contract.serverRoutes)

if (failures.length > 0) {
  console.error('\nProtocol contract mismatches:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('\nProtocol contract is consistent.')
}
