import dotenv = require("dotenv")
dotenv.config()



import express = require("express")
import fetch = require("node-fetch")
import octokit = require("@octokit/core")
import path = require("path")
import { mkdir, readFile, writeFile } from "fs/promises"
import child_process = require( "child_process")
import util = require("util")
import { Artifact, Resource, WorkGroup, WorkUnit } from "@nyrox/bonk-dsl"
import { Db, MongoClient, ObjectId } from "mongodb"
import { downloadRawTextFile, ensureGithubWebhook } from "./github"
import { WORK_DIR } from "./config"
import { useDatabase } from "./utils"
import { LockedResource, requestResources, unlockResourcesForJob } from "./resources"

const exec = util.promisify(child_process.exec);



const runBonkFile = async (event) => {
    const workspace = path.resolve(WORK_DIR, `${event.ref}/${event.after}/`)
    await mkdir(workspace, { recursive: true })
    
    console.info("Created workspace: ", workspace)

    const bonkfile = await downloadRawTextFile(event.after, ".bonk/bonkfile.ts")
    await writeFile(workspace + "/bonkfile.ts", bonkfile)

    const packageJson = await downloadRawTextFile(event.after, "package.json")
    const bonkDslVer = JSON.parse(packageJson).dependencies["@nyrox/bonk-dsl"]

    console.log("Using DSL Version: " + bonkDslVer)
    await writeFile(workspace + "/package.json", JSON.stringify({
        dependencies: {
            ["@nyrox/bonk-dsl"]: bonkDslVer,
        }
    }, undefined, 4))
    
    await writeFile(workspace + "/.npmrc", await downloadRawTextFile(event.after, ".npmrc"))
    
    const yarnLogs = await exec("yarn", { cwd: workspace })
    const nodeLogs = await exec("ts-node " + workspace + "/bonkfile.ts", { cwd: workspace, env: Object.assign(process.env, {
        BONK_EVENT: "push:" + (event.ref as string).split("/").pop()
    })})
    
    console.log(yarnLogs.stdout, nodeLogs.stderr)
    console.log(nodeLogs.stdout, nodeLogs.stderr)
}


export interface ExtendedWorkUnit extends WorkUnit {
    triggeredAt?: Date
    finishedAt?: Date
}

export interface WorkGroupRun extends WorkGroup {
    _id?: ObjectId,
    triggeredAt?: Date
    lastProgressAt?: Date
    lastCheckedAt?: Date
    items: Record<string, ExtendedWorkUnit>
}

import * as cors from "cors"

const start = async () => {
    await ensureGithubWebhook()

    const public_serv = express()
        .use(express.json())
        .use(cors({ origin: "*" }))
        .post("*", async (req, res) => {
            const event = req.body
            switch(req.header("X-Github-Event")) {
                case "push":
                    console.info("Received a push event with ref: " + req.body.ref)
                    runBonkFile(event)
                    return;
                default:
                    return
            }

            res.end()
        })
        .get("/api/run/list", async (req, res) => {
            const db = await useDatabase()
            res.write(JSON.stringify(await db.collection("workgroup_runs").find().toArray()))
            res.end()
        })
        .get("*", (req, res) => {
            res.status(404)
            res.end()
        })
    
    const privateServ = express()
        .use(express.json())
        .post("/api/workgroup/trigger", async (req, res) => {
            const workflow: WorkGroup = req.body
            console.log(workflow)
            console.log("Got request to start workflow: ", workflow.name)

            const workflow_run: WorkGroupRun = {
                triggeredAt: new Date(),
                ...workflow
            }

            const db = await useDatabase()
            const ret = await db.collection("workgroup_runs").insertOne(workflow_run)

            await advance_workgroup(ret.insertedId)

            res.end()
        })
        .post("/api/run/:id/advance", async (req, res) => {
            console.log("Advancing workflow run: " + req.params.id)
            await advance_workgroup(new ObjectId(req.params.id))

            res.end()
        })
        .post("/api/run/:run_id/job/:name/finish", async (req, res) => {
            const { name, run_id } = req.params
            console.log(`Marking job ${name} in run ${run_id} as finished.`)

            const db = await useDatabase()
            const run = await db.collection("workgroup_runs").findOne({ _id: new ObjectId(run_id) })

            if (!run) throw new Error("Run " + run_id + " does not exist")

            await finish_job_item(run as WorkGroupRun, name)

            res.end()
        })
    
    console.info("Starting servers")
    return [public_serv.listen(80), privateServ.listen(9725)]
}

function run_is_finished(run: WorkGroupRun): boolean {
    for (const item in run.items) {
        if (!run.items[item].finishedAt) return false
    }

    return true
}

async function finish_job_item(run: WorkGroupRun, item_name: string): Promise<void> {
    const item = run.items[item_name]

    if (!item) throw new Error(`Can't find job "${item_name}" in workgroup run: ${run._id}`)
    if (item.finishedAt) throw new Error(`Job ${item.name} in run ${run._id} already finished!`)

    await unlockResourcesForJob(run._id, item_name)

    const db = await useDatabase()
    await db.collection("workgroup_runs").updateOne({
        _id: run._id,
    }, {
        $set: { ["items." + item_name + ".finished_at"]: new Date() }
    })

    if (run_is_finished) {
        await db.collection("workgroup_runs").updateOne({
            _id: run._id,
        }, {
            $set: { finishedAt: new Date() }
        })
    }
}

async function item_request_progress(run: WorkGroupRun, item: ExtendedWorkUnit): Promise<LockedResource[] | null> {
    const resources: Resource[] = item.inputs.filter(i => i.type == "resource") as Resource[]
    const artifacts: Artifact[] = item.inputs.filter(i => i.type == "artifact") as Artifact[]

    const is_next = artifacts
        .map(a => !!run.items[a.producer].finishedAt)
        .reduce((state, v) => state && v, true)
    
    if (!is_next) return null

    const acquiredResources = await requestResources(resources, { run: run._id, job: item.name })
    if (!acquiredResources) return null

    return acquiredResources
}

async function advance_workgroup(run_id: ObjectId) {
    const db = await useDatabase()
    const run = (await db.collection("workgroup_runs").findOne({ _id: run_id })) as WorkGroupRun
    
    console.log(run)
    run.lastCheckedAt = new Date()

    Object.keys(run.items).forEach(async itemName => {
        const item = run.items[itemName]
        if (item.finishedAt) return;

        const resources = await item_request_progress(run, item)
        console.log(resources)

        if (resources == null) {
            console.log(itemName + ": Not able to make progress")
            return;
        }

        console.log(itemName + ": can progress with resources: ", resources)
        run.items[itemName].triggeredAt = new Date()
    });

    await db.collection("workgroup_runs").findOneAndReplace({ _id: run_id }, run)
}


start()