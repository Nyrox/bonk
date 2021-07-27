
import { Octokit } from "@octokit/core"
import { useConfig } from "./config";
import fetch from "node-fetch"


let __github: Octokit
export const useGithub = async () => {
    return __github || await (async () => {
        const config = await useConfig()
        __github = new Octokit({
            auth: config.github_api_token,
        })
        return __github
    })()
}

async function getNgrokPublicUrl() {
    const response = await fetch("http://localhost:4040/api/tunnels")
    return (await response.json()).tunnels.find(t => t.name == "github-webhooks").public_url
}


let __webhook_url: string;
export async function useWebhookUrl() {
    return __webhook_url || await (async () => {
        const config = await useConfig()
        __webhook_url = config.webhook_url == "ngrok" ? await getNgrokPublicUrl() : config.webhook_url
        return __webhook_url
    })()
}

async function githubWebhookExists() {
    const config = await useConfig()
    const github = await useGithub()
    let hooks = await github.request("GET /repos/{owner}/{repo}/hooks", {
        owner: config.repository.owner,
        repo: config.repository.repo,
    })

    const webhook = await useWebhookUrl()
    return hooks.data.find(hook => hook.config.url == webhook) !== undefined
}

export async function ensureGithubWebhook() {
    if (!await githubWebhookExists()) {
        const config = await useConfig()
        const github = await useGithub()
        console.info("Creating GitHub WebHook")
        await github.request("POST /repos/{owner}/{repo}/hooks", {
            owner: config.repository.owner,
            repo: config.repository.repo,
            name: "web",
            config: {
                url: await useWebhookUrl(),
                content_type: "json",
            },
            events: ["*"],
        })
        console.info("GitHub Hook created")
    } else {
        console.info("GitHub Hook exists")
    }
}


export async function downloadRawTextFile(commitHash: string, filePath: string): Promise<string> {
    const config = await useConfig()
    const github = await useGithub()
    const response = await github.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: config.repository.owner,
        repo: config.repository.repo,
        path: filePath,
        ref: commitHash,
      })

    return await (await fetch((response.data as any).download_url)).text()
}


export async function workflowDispatch(workflow: string, ref: string, inputs: Record<string, string> = {}) {
    const config = await useConfig()
    const github = await useGithub()

    await github.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
        owner: config.repository.owner,
        repo: config.repository.repo,
        workflow_id: workflow,
        ref,
        inputs,
    })
}