
import { Mutex } from "async-mutex"
import { Resource } from "@nyrox/bonk-dsl"
import { ObjectId } from "mongodb"
import { useDatabase } from "./utils"


enum LockState {
    Free = 0,
    Reserved = 1,
    Locked = 2,
}

const serviceLock = new Mutex()

export async function requestResources(requested: Resource[]): Promise<any[]> {
    const release = await serviceLock.acquire()
    let selected: any[] = []

    try {
        const db = await useDatabase()
        
        for(let i = 0; i < requested.length; i++) {
            let find = requested[i]
            let available = await db.collection("resources").findOneAndUpdate({ 
                set: find.resource_set,
                lock_state: LockState.Free,
                properties: {
                    ...find.filters
                }
            }, { $set: { lock_state: LockState.Reserved }})

            if (!available) break
            console.log(available.value)
            selected.push(available.value)
        }

        return selected
    } finally {
        release()
    }
}
