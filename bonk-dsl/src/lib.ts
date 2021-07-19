


interface PushTrigger {
    EVENT_TYPE: "push",
    ref: string,
}

interface PRTrigger {
    EVENT_TYPE: "pr",
}

type Trigger = PushTrigger | PRTrigger


export interface WorkUnit {

}

export interface WorkGroup  {
    items: Record<string, WorkUnit>,
    name: string,
}


export class Artifact implements InputInterface {
    producer: string
    name: string

    constructor(producer: string, name: string) {
        this.producer = producer
        this.name = name
    }

    display(): string {
        return `<Artifact ${this.producer}:${this.name}>`
    }
}

export class Resource  implements InputInterface{
    resource_set: string
    filters: Record<string, string>

    constructor(resource_set: string, filters: Record<string, string>) {
        this.resource_set = resource_set
        this.filters = filters
    }

    display(): string {
        return `<Resource ${this.resource_set}>`
    }
}


interface InputInterface {
    display: () => string
}
export type Input = Artifact | Resource



export interface UnitOptions {
    workflow: string,
    inputs?: Input[]
}

export class WorkUnit {
    name: string
    workflow_file: string
    inputs: Input[]

    constructor(name: string, options: UnitOptions) {
        this.name = name
        this.workflow_file = options.workflow
        this.inputs = options.inputs || []
    }

    public artifact(name: string) {
        return new Artifact(this.name, name)
    }
}



export function push(ref: string, workgroup: () => Promise<WorkGroup>): [Trigger, () => Promise<WorkGroup>] {
    return [{ EVENT_TYPE: "push", ref }, workgroup]
}

export function check_trigger(trigger: Trigger, event: BonkEvent): boolean {
    if (trigger.EVENT_TYPE != event.event_type) return;

    switch (trigger.EVENT_TYPE) {
        case "push": return trigger.ref == event.event_payload
        default: return true;
    }
}

export async function stick(workgroups: [Trigger, () => Promise<WorkGroup>][]) {
    if (is_trial()) {
        console.info("Event: ", current_event())
    }

    const wgp = workgroups.map(async ([trigger, wg_f]) => {
        if (!check_trigger(trigger, current_event())) return;

        const workgroup = await wg_f()

        if (is_trial()) {
            console.info(`Running workgroup "${workgroup.name}" with items:`)
            Object.keys(workgroup.items).forEach(item_name => {
                console.log(`  ↳ ${item_name}`)
                const item = workgroup.items[item_name]
                item.inputs.sort().forEach(input => console.log(`    → ${input.display()}`))
            })
        } else {
            await fetch("0.0.0.0:9725/api/workgroup/trigger", { body: JSON.stringify(workgroup), method: "POST" })
        }
    })

    await Promise.all(wgp)
}

export function resource(resource_set: string, filters: Record<string, string>): Resource {
    return new Resource(resource_set, filters)
}


export function workgroup(name: string, units: WorkUnit[]): WorkGroup {
    let items: Record<string, WorkUnit> = {}

    units.forEach(unit => {
        if (items[unit.name]) throw new Error(`ERROR: WorkUnit ${unit.name} is defined twice.`)
        items[unit.name] = unit
    })

    units.forEach(unit => {
        unit.inputs.forEach(input => {
            if (input instanceof Artifact) {
                if (!items[input.producer]) throw new Error(`ERROR: WorkUnit "${unit.name}" has a dependency on "${input.producer}", but "${input.producer}" is not declared as part of the workgroup.`)
            }
        })
    })

    return { name, items }
}

export function unit(name: string, options: UnitOptions): WorkUnit {
    return new WorkUnit(name, options)
}

export function is_trial(): boolean {
    return process.env["BONK_IS_TRIAL"] == "true"
}

export interface BonkEvent {
    event_type: string
    event_payload: string
}

export function current_event(): BonkEvent {
    let event = process.env["BONK_EVENT"]
    let [event_type, event_payload] = event.split(":")

    return {
        event_type,
        event_payload,
    }
} 