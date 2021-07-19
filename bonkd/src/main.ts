

import express = require("express")
import fetch = require("node-fetch")
import octokit = require("@octokit/core")
import dotenv = require("dotenv")
import path = require("path")
import { mkdir, readFile, writeFile } from "fs/promises"
import child_process = require( "child_process")
import util = require("util")
import { WorkGroup } from "@nyrox/bonk-dsl"

const exec = util.promisify(child_process.exec);

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
        })
    
    const privateServ = express()
        .use(express.json())
        .post("/api/workgroup/trigger", async (req, res) => {
            const workflow: WorkGroup = req.body
            console.log("Got request to start workflow: ", workflow.name)
        })
    
    console.info("Starting servers")
    return [public_serv.listen(80), privateServ.listen(9725)]
}

start()