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
import { requestResources } from "./resources"

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


interface ExtendedWorkUnit extends WorkUnit {
    triggeredAt?: Date
    finishedAt?: Date
}

interface WorkGroupRun extends WorkGroup {
    triggeredAt?: Date
    lastProgressAt?: Date
    lastCheckedAt?: Date
    items: Record<string, ExtendedWorkUnit>
}


const start = async () => {
    await ensureGithubWebhook()

    const public_serv = express()
        .use(express.json())
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
    
    console.info("Starting servers")
    return [public_serv.listen(80), privateServ.listen(9725)]
}

async function item_can_make_progress(run: WorkGroupRun, item: ExtendedWorkUnit): Promise<boolean> {
    const resources: Resource[] = item.inputs.filter(i => i.type == "resource") as Resource[]
    const artifacts: Artifact[] = item.inputs.filter(i => i.type == "artifact") as Artifact[]

    const is_next = artifacts
        .map(a => !!run.items[a.producer].finishedAt)
        .reduce((state, v) => state && v, true)
    
    if (!is_next) return false

    const acquiredResources = await requestResources(resources)
    if (!acquiredResources) return false

    return true
}

async function advance_workgroup(run_id: ObjectId) {
    const db = await useDatabase()
    const run = (await db.collection("workgroup_runs").findOne({ _id: run_id })) as WorkGroupRun
    
    console.log(run)
    run.lastCheckedAt = new Date()

    Object.keys(run.items).forEach(async itemName => {
        const item = run.items[itemName]
        if (item.finishedAt) return;

        if (!await item_can_make_progress(run, item)) {
            console.log(itemName + ": Not able to make progress")
            return;
        }

        console.log(itemName + ": can progress.")
        run.items[itemName].triggeredAt = new Date()

        setTimeout(async () => {
            console.log("Pretending to be done with: " + itemName)
            const _run = (await db.collection("workgroup_runs").findOne({ _id: run_id })) as WorkGroupRun
            _run.items[itemName].finishedAt = new Date()
            await db.collection("workgroup_runs").findOneAndReplace({ _id: run_id }, _run)
            await fetch.default("http://localhost:9725/api/run/" + run_id + "/advance", { method: "POST" })
        }, 10000)
    });

    await db.collection("workgroup_runs").findOneAndReplace({ _id: run_id }, run)
}


start()