
import { Mutex } from "async-mutex"
import { Resource } from "@nyrox/bonk-dsl"
import { Db, ObjectId } from "mongodb"
import { useDatabase } from "./utils"

enum LockState {
    Free = 0,
    Reserved = 1,
    Locked = 2,
}

const serviceLock = new Mutex()

export interface LockedResource {
    _id: ObjectId,
    properties: object,
    locked_in_run?: ObjectId,
    locked_in_job?: string,
}

export async function requestResources(requested: Resource[], requester: { run: ObjectId, job: string }): Promise<LockedResource[] | null> {
    const release = await serviceLock.acquire()
    let selected: LockedResource[] = []
    const db = await useDatabase()
    console.log(requested)

    try {
        for(let i = 0; i < requested.length; i++) {
            let find = requested[i]
            let available = await db.collection("resources").findOneAndUpdate({ 
                set: find.resource_set,
                lock_state: LockState.Free,
                properties: {
                    ...find.filters
                }
            }, { $set: { lock_state: LockState.Reserved }})

            if (!available.value) return null
            console.log(available.value)
            selected.push(available.value as LockedResource)
        }

        await db.collection("resources").updateMany({
            lock_state: LockState.Reserved,
        }, { $set: {
            lock_state: LockState.Locked,
            locked_in_run: requester.run,
            locked_in_job: requester.job,
        }})

        return selected
    } finally {
        // unlock resources we didn't end up using
        await db.collection("resources").updateMany({
            lock_state: LockState.Reserved,
        }, { $set: { lock_state: LockState.Free }})
        release()
    }
}


export async function unlockResourcesForJob(run: ObjectId, job: string): Promise<void> {
    const db = await useDatabase()

    await db.collection("resources").updateMany({
        locked_in_run: run,
        locked_in_job: job,
    }, { $set: {
        lock_state: LockState.Free,
        locked_in_run: null,
        locked_in_job: null,
    }})
}