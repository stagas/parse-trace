import { mean, median, sum } from 'utils'

export type TraceEvent = {
  ts: number
} & ({
  name: 'Profile'
  args: {
    data: Profile
  }
} | {
  name: 'ProfileChunk'
  args: {
    data: ProfileData
  }
})
export interface ProfileJson {
  profile: CpuProfile
}
export interface Profile {
  startTime: number
}
export interface ProfileData {
  cpuProfile: CpuProfile
  lines: number[]
  timeDeltas: number[]
}
export interface CpuProfile {
  nodes: ProfileNode[]
  samples: number[]
}
interface ProfileNode {
  id: number
  parent: number | undefined
  callFrame: {
    functionName: string
    scriptId: number
    url: string
    lineNumber: number
    columnNumber: number
  }
}

interface Fn {
  id: string
  name: string
  line: number
  col: number
  scriptId: number
  url: string
  times: number[]
  sum: number
  mean: number
  median: number
}

interface Node {
  nodeId: number
  fn: Fn
  parent: number
  parentNode: Node | undefined
  startTime?: number | undefined
  endTime?: number | undefined
}

interface Output {
  name: string
  url: string
  line: number
  col: number
  real?: { url: string, line: string | number, column: string | number } | undefined
  sum: number
  mean: number
  median: number
}

export function parseTrace(events: TraceEvent[]) {
  const fns = new Map<string, Fn>()
  const lns = new Map<number, number[]>()
  const nodesById = new Map<number, Node>()
  const scripts = new Map<number, string>()
  const scriptLines = new Map<number, number>()

  const stack: Node[] = []

  let startTime = 0
  let endTime = 0
  let i = 0

  let e: TraceEvent
  for (; i < events.length;) {
    e = events[i++]
    if (e.name === 'Profile') {
      endTime = startTime = e.args.data.startTime

      // beyond this, everything is ProfileChunk, so we
      // break and iterate just for that
      break
    }
  }
  for (; i < events.length; i++) {
    e = events[i]
    if (e.name !== 'ProfileChunk') break

    endTime = e.ts
    const p = e.args.data

    const {
      cpuProfile: { nodes = [], samples = [] },
      lines = [],
      timeDeltas = []
    } = p

    for (const n of nodes) {
      const { callFrame: c, id: nodeId, parent = 0 } = n

      if (!scripts.has(c.scriptId)) scripts.set(c.scriptId, c.url)

      const parentNode = nodesById.get(parent)
      const line = c.lineNumber ?? parentNode?.fn.line ?? 0
      const col = c.columnNumber ?? parentNode?.fn.col ?? 0
      const scriptId = c.scriptId || parentNode?.fn.scriptId || 0
      const id = `${scriptId}:${line}:${col} ${c.functionName}`

      let fn = fns.get(id)!
      if (!fns.has(id)) {
        fns.set(id, fn = {
          id,
          name: c.functionName,
          line: line + 1, // convert to 1-based for sourcemap resolution
          col: col + 1,
          url: c.url,
          scriptId,
          times: [],
          sum: 0,
          mean: 0,
          median: 0,
        })
      }

      nodesById.set(nodeId, { nodeId, parent, parentNode, fn })
    }

    let x = 0
    let time = e.ts

    // (root)
    let node: Node | undefined
    stack.push(node = nodesById.get(1)!)
    node.startTime = time

    for (const nodeId of samples) {
      const line = lines[x] // 1-based
      const delta = timeDeltas[x]

      let ln = lns.get(line)
      if (!ln) lns.set(line, ln = [])
      ln.push(delta)

      node = nodesById.get(nodeId)!

      scriptLines.set(line, node.fn.scriptId)

      let j: number
      const thisStack: Node[] = []
      do {
        j = stack.findIndex(s => s.nodeId === node!.nodeId)
        if (j >= 0) break
        node.startTime = time
        thisStack.unshift(node)
        node = node.parentNode
      } while (node)

      const removed = stack.splice(j + 1)
      if (removed.length) {
        removed.forEach(s => {
          if (s.startTime) {
            s.endTime = time
            s.fn.times.push(s.endTime - s.startTime)
            delete s.startTime
          }
        })
        // console.log(stack.map(s => s.fn.name).join('>'))
      }

      stack.push(...thisStack)

      let visited = new Set<Fn>()
      stack.forEach(s => {
        if (visited.has(s.fn)) return
        visited.add(s.fn)
        s.fn.sum += delta
      })

      time += delta
      x++
    }
  }

  const totalTime = (endTime - startTime) / 1000

  const junk = 2
  for (const fn of fns.values()) {
    fn.mean = mean(fn.times.slice(junk)) / 1000
    fn.median = median(fn.times.slice(junk)) / 1000
  }

  const output: Output[] = []
  // const linesUsed = new Set()
  for (const fn of [...fns.values()]
    .sort((a, b) => b.mean - a.mean)
  ) {
    output.push({
      name: fn.name,
      url: `${fn.url ?? fn.scriptId ?? '0'}`,
      line: fn.line,
      col: fn.col,
      sum: (1 / (totalTime / (fn.sum / 1000))),
      mean: fn.mean,
      median: fn.median,
    })
    // linesUsed.add(fn.line)
    // output.push([
    //   (scripts.get(+fn.id.split(':')[0]) ?? '0') + ':' + fn.id.split(':').slice(1).join(':'),
    //   (1 / (totalTime / (fn.sum / 1000))).toFixed(2), fn.mean.toFixed(2), fn.median.toFixed(2),
    // ])
    // console.log(!fn.sum ? 0 : ((1 / ((totalTime / 16.666666) / fn.sum)) * 16.66666).toFixed(1), fn.id)
  }

  for (const [line, deltas] of [...lns.entries()]
    .sort(([a], [b]) => a - b)) {
    // if (linesUsed.has(line)) continue
    const total = sum(deltas) / 1000
    const avgPerSec = (total / totalTime) * 1000
    output.push({
      name: '',
      line,
      col: 1,
      url: (scripts.get(scriptLines.get(line) ?? 0) ?? '0'),
      sum: total,
      mean: avgPerSec,
      median: avgPerSec,
    })
    // console.log(fn)
    // const fn = lnFns.get(line - 1)
    // console.log(
    //   fn?.id ?? line,
    //   sum(deltas) / 1000,
    //   ((fn?.lines && sum(fn?.lines) || 0) / 1000) || ''
    // )
  }

  return output
}

export async function test_parseTrace() {
  // @env no
  const fsp = await import('fs/promises')
  describe('parseTrace', () => {
    it('works', async () => {
      // const json = await (await fetch('./trace.json')).json() as any
      const json = JSON.parse(await fsp.readFile('./trace.json', 'utf-8')) as any
      const result = await parseTrace(json.traceEvents)
      console.log(result)
      // console.log(result.map(x => x.join(' ')).join('\n'))
    })
  })
}
