

import express = require("express")
import fetch = require("node-fetch")
import octokit = require("@octokit/core")
import dotenv = require("dotenv")
import path = require("path")
import { mkdir, readFile, writeFile } from "fs/promises"
import child_process = require( "child_process")
import util = require("util")
import { WorkGroup, WorkUnit } from "@nyrox/bonk-dsl"
import { Db, MongoClient, ObjectId } from "mongodb"
import { isTemplateSpan } from "typescript"

const exec = util.promisify(child_process.exec);

let __mongo_handle: MongoClient;
let __database_handle: Db;
const useDatabase = async () => {
    return __database_handle || await (async () => {
        __mongo_handle = new MongoClient("mongodb://localhost:27017")
        await __mongo_handle.connect()
        __database_handle = __mongo_handle.db("bonkd")
        return __database_handle
    })()
}


dotenv.config()

const WORK_DIR = path.resolve(__dirname, "../_work")
const CONFIG_DIR = process.env["BONK_LOCAL"] == "true" ? path.resolve(__dirname, "../etc.local/") : "/etc/bonkd/"


export interface BonkConfig {
    webhook_url: string,
    github_api_token: string,
    repository: {
        owner: string,
        repo: string,
    }
}

export const DEFAULT_CONFIG: BonkConfig = {
    webhook_url: "",
    github_api_token: "",
    repository: {
        owner: "",
        repo: "",
    }
}

let CONFIG: BonkConfig;
let WEBHOOK_URL: string;
let github: octokit.Octokit;

async function github_webhook_exists() {
    let hooks = await github.request("GET /repos/{owner}/{repo}/hooks", {
        owner: CONFIG.repository.owner,
        repo: CONFIG.repository.repo,
    })

    return hooks.data.find(hook => hook.config.url == WEBHOOK_URL) !== undefined
}

async function ensure_github_webhook() {
    if (!await github_webhook_exists()) {
        console.info("Creating GitHub WebHook")
        await github.request("POST /repos/{owner}/{repo}/hooks", {
            owner: CONFIG.repository.owner,
            repo:CONFIG.repository.repo,
            name: "web",
            config: {
                url: WEBHOOK_URL,
                content_type: "json",
            },
            events: ["*"],
        })
        console.info("GitHub Hook created")
    } else {
        console.info("GitHub Hook exists")
    }
}


async function get_ngrok_public_url() {
    const response = await fetch.default("http://localhost:4040/api/tunnels")
    return (await response.json()).tunnels.find(t => t.name == "github-webhooks").public_url
}

async function download_raw_text_file(commitHash: string, filePath: string): Promise<string> {
    const response = await github.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: CONFIG.repository.owner,
        repo: CONFIG.repository.repo,
        path: filePath,
        ref: commitHash,
      })

    return await (await fetch.default((response.data as any).download_url)).text()
}

const runBonkFile = async (event) => {
    const workspace = path.resolve(WORK_DIR, `${event.ref}/${event.after}/`)
    await mkdir(workspace, { recursive: true })
    
    console.info("Created workspace: ", workspace)

    const bonkfile = await download_raw_text_file(event.after, ".bonk/bonkfile.ts")
    await writeFile(workspace + "/bonkfile.ts", bonkfile)

    const packageJson = await download_raw_text_file(event.after, "package.json")
    const bonkDslVer = JSON.parse(packageJson).dependencies["@nyrox/bonk-dsl"]

    await writeFile(workspace + "/package.json", JSON.stringify({
        dependencies: {
            ["@nyrox/bonk-dsl"]: bonkDslVer,
        }
    }, undefined, 4))
    
    await writeFile(workspace + "/.npmrc", await download_raw_text_file(event.after, ".npmrc"))
    
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
    CONFIG = JSON.parse(await readFile(path.resolve(CONFIG_DIR, "./config.json"), "utf-8"))
    github = new octokit.Octokit({
        auth: CONFIG.github_api_token,
    })

    WEBHOOK_URL = CONFIG.webhook_url == "ngrok" ?
        await get_ngrok_public_url() : CONFIG.webhook_url

    console.info("WebHook URL: ", WEBHOOK_URL)

    await ensure_github_webhook()

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
            const ret = await db.collection("workgroup_runs").insertOne(workflow)

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
    const gates = item.inputs.map(input => {
        switch (input.type) {
            case "artifact":
                const producer = run.items[input.producer]
                return !!producer.finishedAt
            case "resource":
                throw new Error("Resources not implemented")
            default:
                throw new Error("wtf")
        }
    })

    return gates.reduce((state, v) => state && v, true)
}

async function advance_workgroup(run_id: ObjectId) {
    const db = await useDatabase()
    const run = (await db.collection("workgroup_runs").findOne({ _id: run_id })) as WorkGroupRun
    
    console.log(run)
    run.lastCheckedAt = new Date()

    Object.keys(run.items).forEach(async itemName => {
        const item = run.items[itemName]
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
            await fetch.default("http://localhost:9725/api/runs/" + run_id + "/advance", { method: "POST" })
        }, 10000)

    });

    await db.collection("workgroup_runs").findOneAndReplace({ _id: run_id }, run)
}


start()