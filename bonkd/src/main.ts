

import express = require("express")
import fetch = require("node-fetch")
import octokit = require("@octokit/core")
import dotenv = require("dotenv")
import path = require("path")
import { readFile } from "fs/promises"

dotenv.config()

const WORK_DIR = path.resolve(__dirname, "./_work")
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
    const response = await fetch("http://localhost:4040/api/tunnels")
    return (await response.json()).tunnels.find(t => t.name == "github-webhooks").public_url
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

    const serv = express()
        .use(express.json())
        .post("*", (req, res) => {

            switch(req.header("X-Github-Event")) {
                case "push":
                    console.info("Received a push event with ref: " + req.body.ref)


                    return;
                default:
                    return
            }
        })

    console.info("Starting server")
    return serv.listen(80)
}

start()