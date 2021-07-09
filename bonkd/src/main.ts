

import express = require("express")
import fetch = require("node-fetch")
import octokit = require("@octokit/core")
import dotenv = require("dotenv")
import path = require("path")

dotenv.config()


const WORK_DIR = path.resolve(__dirname, "./_work")

let WEBHOOK_URL;


const REQUIRED_ENV = [
    "GITHUB_API_TOKEN",
]

REQUIRED_ENV.forEach(e => {
    if (!process.env[e]) {
        console.warn(`WARN: "${e} not found in environment."`)
    }
})


async function github_webhook_exists() {
    let hooks = await github.request("GET /repos/{owner}/{repo}/hooks", {
        owner: "Nyrox",
        repo: "bonk",
    })

    return hooks.data.find(hook => hook.config.url == WEBHOOK_URL) !== undefined
}

async function ensure_github_webhook() {
    if (!await github_webhook_exists()) {
        console.info("Creating GitHub WebHook")
        await github.request("POST /repos/{owner}/{repo}/hooks", {
            owner: "Nyrox",
            repo: "bonk",
            name: "web",
            config: {
                url: WEBHOOK_URL,
                content_type: "json",
            },
            events: ["*"],
        })
    }
}

const github = new octokit.Octokit({
    auth: process.env["GITHUB_API_TOKEN"],
})


async function get_ngrok_public_url() {
    const response = await fetch("http://localhost:4040/api/tunnels")
    return (await response.json()).tunnels.find(t => t.name == "github-webhooks").public_url
}


const start = async () => {
    WEBHOOK_URL = process.env["WEBHOOK_URL_CONFIG"] == "ngrok" ?
        await get_ngrok_public_url()  : process.env["WEBHOOK_URL_CONFIG"]

    console.info("WebHook URL: ", WEBHOOK_URL)

    ensure_github_webhook()

    const serv = express()
        .use(express.json())
        .post("*", (req, res) => {

            switch(req.body.action) {
                case "push":
                    console.info("Received a push event with ref: " + req.body.ref)
                    return;
                default:
                    return
            }
        })

    return serv.listen(80)
}

start()