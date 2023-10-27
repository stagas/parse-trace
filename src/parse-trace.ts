import { TracingModel, TimelineModel, Helpers, makeCompleteEvent, TraceEvents, TimelineProfileTree, TopDownRootNode, BottomUpRootNode, TimelineModelFilter } from 'chrome-devtools-frontend/entry.ts'
import type { CPUProfileDataModel } from 'chrome-devtools-frontend/front_end/models/cpu_profile/cpu_profile'
import type { TraceEventData } from 'chrome-devtools-frontend/front_end/models/trace/types/TraceEvents'
import { ILocation, buildModel } from './build-model.ts'
import { median } from 'utils'

export interface ProfileJson {
  profile: Profile
}
export interface Profile {
  nodes: Node[]
}
export interface Node {
  id: number
  callFrame: {
    functionName: string
    scriptId: string
    url: string
    lineNumber: number
    columnNumber: number
  }
  hitCount: number
  children: number[]
  positionTicks: {
    line: number
    ticks: number
  }[]
}

export function parseProfile({ profile }: ProfileJson, microseconds: number) {
  const hits = {}
  profile.nodes.forEach((n: Node) => {
    hits[n.id] = n.hitCount
  })
  const res = buildModel(profile as any)

  const uid = (x: ILocation) => {
    return `${x.callFrame.functionName} ${x.id}`
  }

  const results = Object.fromEntries(res.locations
    .filter(x => x.selfTime)
    .sort((a, b) =>
      b.selfTime - a.selfTime
    ).map(x =>
      [
        uid(x),
        { t: x.selfTime / (hits[x.id] || 1) / 1000/*  * microseconds */, h: hits[x.id] }
      ] as const
    )
    .sort(([, a], [, b]) => b.t - a.t)
  )
  return results
}

export async function parseTrace(events: TraceEventData[]) {
  const timelineModel = new TimelineModel.TimelineModelImpl()
  const tracingModel = new TracingModel()

  const results: any = new Map()

  tracingModel.addEvents(events)
  tracingModel.tracingComplete()
  timelineModel.setEvents(tracingModel)

  for (const { cpuProfileData: profile } of timelineModel.cpuProfiles() as { cpuProfileData: CPUProfileDataModel.CPUProfileDataModel }[]) {
    if (!profile.samples || !profile.lines) continue

    const samplesIntegrator =
      new Helpers.SamplesIntegrator.SamplesIntegrator(profile, events[0].pid, events[0].tid)

    const profileCalls = samplesIntegrator?.buildProfileCalls(events)
    if (profileCalls) {
      events = Helpers.Trace.mergeEventsInOrder(events, profileCalls)
    }
    const root: TopDownRootNode = new TimelineProfileTree.TopDownRootNode(events,
      [], profile.profileStartTime, profile.profileEndTime, false, null) as any

    const entries = [[...root.children().entries()]]
    while (entries.length) {
      for (const [key, node] of entries.pop() as any) {
        if (node?.event?.callFrame?.functionName) {
          const c = node.event.callFrame
          const id = `${c.scriptId}:${c.lineNumber || 0} ${c.functionName}`
          if (node.totalTime) {
            if (results.has(id)) {
              results.get(id).times.push(node.totalTime)
            }
            else {
              results.set(id, {
                name: id,
                times: [node.totalTime]
              })
            }
          }
          const res = node.children()
          entries.push([...res.entries()])
        }
      }
    }
  }

  for (const result of results.values() as any) {
    // result.time = average(result.times) //(result.times.length > 2 ? median(result.times) : result.times[0]) || 0
    result.time = (result.times.length > 2 ? median(result.times) : result.times[0]) || 0
    delete result.times
  }

  // const sorted = [...Object.entries(results)]
  const sorted = [...results.entries()]
    .sort(([, a]: any, [, b]: any) => b.time - a.time) as any

  for (const [k, n] of sorted.slice(0, 100)) {
    console.log(`${n.time.toFixed(3)} ${n.name}`)
  }

  // return data
}

export function test_parseTrace() {
  // @env browser
  describe('parseTrace', () => {
    it('works', async () => {
      const json = await (await fetch('./trace.json')).json() as any
      const result = await parseTrace(json.traceEvents)
      console.log(result)
    })
  })
}
